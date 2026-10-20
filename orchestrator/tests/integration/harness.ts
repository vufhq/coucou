// The whole backend and a real worker, in one process, in temp folders: only
// the browser and the model are stand-ins. Each test gets its own database,
// workspace and ports.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@coucou-orchestrator/protocol";
import { createBackend, type Backend } from "../../server/src/app.ts";
import type { Config } from "../../server/src/config.ts";
import type { ModelAdapter } from "../../server/src/model/adapter.ts";
import type { VmProbe } from "../../server/src/vm.ts";
import { ModelRouter } from "../../server/src/model/router.ts";
import { BackendClient } from "../../worker/src/client.ts";
import { Journal } from "../../worker/src/journal.ts";
import type { BrowserDriver, BrowserPage } from "../../worker/src/ops/browser.ts";
import { Worker } from "../../worker/src/worker.ts";

export const API_TOKEN = "test-api-token-0123456789";
export const WORKER_TOKEN = "test-worker-token-0123456789";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanup(...dirs: string[]): Promise<void> {
  // SQLite's WAL files can stay locked for a moment on Windows.
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

/** Every byte value once: a screenshot that survives the trip only if nothing treats it as text. */
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);

/** Pages are whatever the test says they are; `hold()` makes the next loads hang until released. */
export class FakeBrowser implements BrowserDriver {
  readonly site = new Map<string, { title: string; text: string }>();
  readonly visits: string[] = [];
  private gate: Promise<void> | null = null;
  private current = new Map<string, string>();

  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((r) => {
      release = r;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  blocked = async (_host: string) => false;

  /** Whether Chromium is "installed", for the worker's health report. */
  installed = true;
  ready = async () => this.installed;

  async page(taskId: string): Promise<BrowserPage> {
    return {
      goto: async (url) => {
        this.visits.push(url);
        if (this.gate) await this.gate;
        this.current.set(taskId, url);
      },
      url: () => this.current.get(taskId) ?? "about:blank",
      title: async () => this.site.get(this.current.get(taskId) ?? "")?.title ?? "Untitled",
      text: async () => this.site.get(this.current.get(taskId) ?? "")?.text ?? "",
      screenshot: async (path) => writeFile(path, PNG_BYTES),
    };
  }

  async close(): Promise<void> {}
}

export interface Running {
  backend: Backend;
  apiPort: number;
  workerPort: number;
  api<T = any>(path: string, init?: { method?: string; body?: unknown; token?: string }): Promise<{ status: number; body: T }>;
  /** The raw bytes and type of an answer, for downloads. */
  raw(path: string): Promise<{ status: number; type: string | null; bytes: Buffer }>;
}

export async function startBackend(
  dataDir: string,
  model: ModelAdapter,
  ports?: { api: number; worker: number },
  /** More model profiles, by id, beside the default "scripted" one. */
  extraModels: Record<string, ModelAdapter> = {},
  options: { vmProbe?: VmProbe; retentionDays?: number } = {},
): Promise<Running> {
  const config: Config = {
    dataDir,
    apiHost: "127.0.0.1",
    apiPort: ports?.api ?? 0,
    workerHost: "127.0.0.1",
    workerPort: ports?.worker ?? 0,
    leaseMs: 1_500,
    claimWaitMs: 300,
    retentionDays: options.retentionDays ?? 30,
    defaultModelProfile: "scripted",
    agents: [{ id: "agent-01", name: "Agent 01", vmId: "test" }],
  };
  const models = new ModelRouter();
  models.register(
    { id: "scripted", provider: "test", model: "script", capabilities: { streaming: false, toolCalling: false, structuredOutput: true } },
    model,
  );
  for (const [id, adapter] of Object.entries(extraModels)) {
    models.register({ id, provider: "test", model: id, capabilities: { streaming: false, toolCalling: false, structuredOutput: false } }, adapter);
  }
  const backend = createBackend(config, { api: API_TOKEN, worker: WORKER_TOKEN }, models, {
    pollMs: 50,
    transientRetryDelaysMs: [20, 20],
    vmProbe: options.vmProbe ?? (async () => null),
  });
  const { apiPort, workerPort } = await backend.listen();
  return {
    backend,
    apiPort,
    workerPort,
    async api(path, init = {}) {
      const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${init.token ?? API_TOKEN}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Plain text (a file download).
      }
      return { status: res.status, body };
    },
    async raw(path) {
      const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
      return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

export function startWorker(workspace: string, workerPort: number, browser: BrowserDriver): { worker: Worker; done: Promise<void> } {
  const worker = new Worker({
    client: new BackendClient(`http://127.0.0.1:${workerPort}`, WORKER_TOKEN, "agent-01"),
    journal: new Journal(workspace),
    browser,
    workspace,
    heartbeatMs: 300,
    claimWaitMs: 300,
  });
  return { worker, done: worker.run() };
}

/** Reads the event stream until `until` says stop. `after` is the Last-Event-ID to resume from. */
export async function readEvents(
  apiPort: number,
  opts: { after?: number; taskId?: string; until: (e: AgentEvent, all: AgentEvent[]) => boolean; timeoutMs?: number },
): Promise<AgentEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const path = opts.taskId ? `/api/tasks/${opts.taskId}/events` : "/api/events";
  let res: Response;
  // A reconnect can race a just-closed keep-alive socket in Node's fetch
  // pool. Retry the initial connection within the same test timeout; this
  // is the same transient failure a real SSE client must tolerate.
  for (;;) {
    try {
      res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        headers: { Authorization: `Bearer ${API_TOKEN}`, ...(opts.after ? { "Last-Event-ID": String(opts.after) } : {}) },
        signal: controller.signal,
      });
      break;
    } catch (err) {
      if (controller.signal.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const out: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let satisfied = false;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as AgentEvent;
        out.push(event);
        if (opts.until(event, out)) {
          satisfied = true;
          controller.abort();
          return out;
        }
      }
    }
  } catch (err) {
    // Stopping the stream on purpose ends the read with an AbortError.
    if (satisfied) return out;
    if (!controller.signal.aborted) throw err;
    throw new Error(`event stream timed out after ${out.length} events: ${out.map((e) => e.type).join(", ")}`);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, what = "condition"): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let keyCounter = 0;
export function key(): string {
  keyCounter += 1;
  return `test-key-${Date.now()}-${keyCounter}`;
}

export const ended = (e: AgentEvent) => ["task.completed", "task.failed", "task.cancelled"].includes(e.type);
