// The worker loop: say hello (with the journal), claim a job, validate it
// again, run it under its deadline while heartbeats keep its lease, report
// the outcome until the backend has it, repeat. Up to WORKER_SLOTS jobs at
// once: the computer works on a few tasks together, one operation each.
//
// The backend is allowed to vanish at any moment: the job carries on, its
// outcome waits in the journal, and the next hello hands it over.

import { statfs } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OP_NAMES,
  parseOperation,
  type Job,
  type JobOutcome,
  type OpArgs,
  type WorkerEvent,
  type WorkerHealth,
} from "@coucou-orchestrator/protocol";
import { BackendError, type BackendClient } from "./client.ts";
import type { Journal } from "./journal.ts";
import { PathError, ensureTaskDir } from "./paths.ts";
import { BrowserError, extractText, navigate, screenshot, type BrowserDriver } from "./ops/browser.ts";
import { fetchFile, listFiles, readText, receiveFile, writeArtifact } from "./ops/fs.ts";
import { agentHome, runShell, type ShellRunner } from "./ops/shell.ts";
import { CommandError, runCommand } from "./ops/terminal.ts";
import { pruneTaskDirs } from "./retention.ts";

export const WORKER_VERSION = "0.5.3";
/** How many jobs run at once. The backend sends a computer at most ORCH_TASKS_PER_COMPUTER tasks. */
export const WORKER_SLOTS = 4;

const HEALTH_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;

export interface OpContext {
  taskId: string;
  jobId: string;
  /** The task's folder, real path. */
  dir: string;
  /** The agent's own folder on the computer, kept between tasks (`~` in a shell). */
  home: string;
  deadlineMs: number;
  signal: AbortSignal;
  report(type: WorkerEvent["type"], payload: Record<string, unknown>): void;
  /** Sends a download's bytes to the backend (fs.fetch only). */
  upload(bytes: Uint8Array): Promise<void>;
  /** The bytes of a file the user attached (fs.receive only). */
  download(): Promise<Buffer>;
}

export interface OpResult {
  result: string;
  /** The operation ran but did not succeed (a command's non-zero exit). */
  failed?: boolean;
}

export interface WorkerOptions {
  client: BackendClient;
  journal: Journal;
  browser: BrowserDriver;
  workspace: string;
  /**
   * The computer's shared folder, where task folders live so the runner can
   * work in them (/computer in the VM). Defaults to the workspace.
   */
  computer?: string;
  /** Runs terminal.shell commands; without one the operation is refused. */
  shell?: ShellRunner | null;
  /** How often a running job's lease is renewed. */
  heartbeatMs?: number;
  claimWaitMs?: number;
  log?: (line: string) => void;
}

export class Worker {
  private readonly o: Required<WorkerOptions>;
  private stopped = false;
  private readonly current = new Set<AbortController>();
  private retentionDays = 0;
  private healthAt = 0;
  private prunedAt = 0;

  constructor(options: WorkerOptions) {
    this.o = { heartbeatMs: 5_000, claimWaitMs: 25_000, log: () => {}, computer: options.workspace, shell: null, ...options };
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.current) controller.abort();
  }

  /** Disk space and browser, as reported to the backend. */
  async health(): Promise<WorkerHealth> {
    let diskFreeBytes = 0;
    let diskTotalBytes = 0;
    try {
      const fs = await statfs(this.o.workspace);
      diskFreeBytes = fs.bavail * fs.bsize;
      diskTotalBytes = fs.blocks * fs.bsize;
    } catch {
      // Unknown: reported as 0 of 0, which the backend does not treat as full.
    }
    const browserReady = (await this.o.browser.ready?.().catch(() => false)) ?? true;
    return { diskFreeBytes, diskTotalBytes, browserReady };
  }

  /** Between jobs: old task folders go, at most every few hours. */
  private async prune(): Promise<void> {
    if (Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = Date.now();
    const removed = await pruneTaskDirs(this.o.computer, this.retentionDays).catch(() => []);
    if (removed.length) this.o.log(`removed ${removed.length} old task folder(s)`);
  }

  async run(): Promise<void> {
    let backoff = 500;
    let greeted = false;
    const running = new Set<Promise<unknown>>();
    while (!this.stopped) {
      try {
        if (!greeted) {
          const hello = await this.o.client.hello({
            agentId: this.o.client.agentId,
            version: WORKER_VERSION,
            capabilities: OP_NAMES,
            journal: await this.o.journal.entries(),
            health: await this.health(),
          });
          this.retentionDays = hello.retentionDays;
          this.healthAt = Date.now();
          greeted = true;
          this.o.log("connected to the backend");
        }
        if (running.size >= WORKER_SLOTS) {
          await Promise.race(running);
          continue;
        }
        if (running.size === 0) await this.prune();
        let health: WorkerHealth | undefined;
        if (Date.now() - this.healthAt >= HEALTH_EVERY_MS) {
          health = await this.health();
          this.healthAt = Date.now();
        }
        const claim = await this.o.client.claim(this.o.claimWaitMs, health);
        backoff = 500;
        if (claim.job) {
          const job: Promise<unknown> = this.handle(claim.job)
            .catch((err: unknown) => this.o.log(`job ${claim.job?.id} failed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => running.delete(job));
          running.add(job);
        }
      } catch (err) {
        if (this.stopped) break;
        // The next hello hands the journal over: the jobs still running finish first.
        await Promise.all(running);
        greeted = false;
        this.o.log(`backend unreachable (${err instanceof Error ? err.message : String(err)}); retrying`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
    await Promise.all(running);
  }

  /** Runs one job and makes sure its outcome reaches the backend. */
  async handle(job: Job): Promise<JobOutcome> {
    const known = await this.o.journal.has(job.id);
    let outcome: JobOutcome;
    if (known?.state === "finished" && known.outcome) {
      outcome = known.outcome; // Already ran; only the report was lost.
    } else if (known?.state === "started") {
      outcome = { status: "failed", error: { code: "interrupted", message: "this job was interrupted by a worker restart" } };
    } else {
      await this.o.journal.started(job.id);
      outcome = await this.execute(job);
      await this.o.journal.finished(job.id, outcome);
    }
    await this.deliver(job.id, outcome);
    return outcome;
  }

  private async deliver(jobId: string, outcome: JobOutcome): Promise<void> {
    let backoff = 500;
    while (!this.stopped) {
      try {
        await this.o.client.complete(jobId, outcome);
        return;
      } catch (err) {
        // 404: the backend no longer knows the job (its database was reset); nothing to deliver to.
        if (err instanceof BackendError && err.status === 404) return;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  private async execute(job: Job): Promise<JobOutcome> {
    const parsed = parseOperation(job.op, job.args);
    if (!parsed.ok) return { status: "failed", error: { code: "invalid", message: parsed.error } };

    const controller = new AbortController();
    this.current.add(controller);
    const deadline = setTimeout(() => controller.abort(new Error("deadline")), job.deadlineMs);
    let cancelled = false;

    // Events go out in order, in the background; losing one never fails the job.
    let outbox: Promise<void> = Promise.resolve();
    const report = (type: WorkerEvent["type"], payload: Record<string, unknown>) => {
      outbox = outbox.then(() => this.o.client.events(job.id, [{ type, payload }]).catch(() => {}));
    };
    const heartbeat = setInterval(() => {
      this.o.client
        .heartbeat([job.id])
        .then((cancel) => {
          if (cancel.includes(job.id)) {
            cancelled = true;
            controller.abort(new Error("cancelled"));
          }
        })
        .catch(() => {});
    }, this.o.heartbeatMs);

    try {
      const dir = await ensureTaskDir(this.o.computer, job.taskId);
      const home = agentHome(this.o.computer, job.agentId ?? this.o.client.agentId);
      const upload = (bytes: Uint8Array) => this.o.client.upload(job.id, bytes);
      const download = () => this.o.client.download(job.id);
      const ctx: OpContext = {
        taskId: job.taskId,
        jobId: job.id,
        dir,
        home,
        deadlineMs: job.deadlineMs,
        signal: controller.signal,
        report,
        upload,
        download,
      };
      const run = this.dispatch(ctx, parsed.op.op, parsed.op.args);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      const out = await Promise.race([run, aborted]);
      await outbox;
      return out.failed
        ? { status: "failed", result: out.result, error: { code: "failed", message: out.result.split("\n")[0] ?? "failed" } }
        : { status: "succeeded", result: out.result };
    } catch (err) {
      await outbox;
      if (cancelled) return { status: "cancelled", error: { code: "cancelled", message: "cancelled by the backend" } };
      if (controller.signal.aborted) {
        return { status: "failed", error: { code: "timeout", message: `no result within ${Math.round(job.deadlineMs / 1000)} s` } };
      }
      const refused = err instanceof PathError || err instanceof CommandError || err instanceof BrowserError;
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", error: { code: refused ? "refused" : "failed", message: message.slice(0, 1_000) } };
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.current.delete(controller);
    }
  }

  private dispatch(ctx: OpContext, op: string, args: Record<string, unknown>): Promise<OpResult> {
    const b = this.o.browser;
    switch (op) {
      case "browser.navigate":
        return navigate(ctx, args as OpArgs<"browser.navigate">, b);
      case "browser.extract_text":
        return extractText(ctx, args as OpArgs<"browser.extract_text">, b);
      case "browser.screenshot":
        return screenshot(ctx, args as OpArgs<"browser.screenshot">, b);
      case "fs.write_artifact":
        return writeArtifact(ctx, args as OpArgs<"fs.write_artifact">);
      case "fs.list":
        return listFiles(ctx);
      case "fs.read":
        return readText(ctx, args as OpArgs<"fs.read">);
      case "fs.fetch":
        return fetchFile(ctx, args as OpArgs<"fs.fetch">);
      case "fs.receive":
        return receiveFile(ctx, args as OpArgs<"fs.receive">);
      case "terminal.run":
        return runCommand(ctx, args as OpArgs<"terminal.run">);
      case "terminal.shell":
        if (!this.o.shell) return Promise.reject(new CommandError("this computer has no shell runner"));
        return runShell(ctx, args as OpArgs<"terminal.shell">, this.o.shell);
      default:
        return Promise.reject(new CommandError(`unsupported operation ${op}`));
    }
  }
}
