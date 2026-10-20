import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, Task } from "@coucou-orchestrator/protocol";
import { ModelError } from "../../server/src/model/adapter.ts";
import { ScriptedModel } from "../../server/src/model/scripted.ts";
import type { Worker } from "../../worker/src/worker.ts";
import {
  FakeBrowser,
  PNG_BYTES,
  WORKER_TOKEN,
  cleanup,
  ended,
  freePort,
  key,
  readEvents,
  startBackend,
  startWorker,
  tempDir,
  waitFor,
  type Running,
} from "./harness.ts";

const DOCS = "https://docs.example.org/install";
const act = (op: string, args: Record<string, unknown>, note = op) => ({ kind: "action", note, op, args });
const done = (summary: string) => ({ kind: "done", summary });

let running: Running[] = [];
let workers: Worker[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const w of workers) w.stop();
  for (const r of running) await r.backend.close().catch(() => {});
  await cleanup(...dirs);
  running = [];
  workers = [];
  dirs = [];
});

async function setup(
  script: ConstructorParameters<typeof ScriptedModel>[0],
  ports?: { api: number; worker: number },
  options: Parameters<typeof startBackend>[4] = {},
) {
  const dataDir = await tempDir("orch-data-");
  const workspace = await tempDir("orch-ws-");
  dirs.push(dataDir, workspace);
  const model = new ScriptedModel(script);
  const r = await startBackend(dataDir, model, ports, {}, options);
  running.push(r);
  const browser = new FakeBrowser();
  browser.site.set(DOCS, { title: "Install guide", text: "Install with: pip install example\nRequires Python 3.10+." });
  const { worker } = startWorker(workspace, r.workerPort, browser);
  workers.push(worker);
  return { r, model, browser, workspace, dataDir };
}

async function submit(r: Running, prompt = "Summarise the install docs into report.md", extra: Record<string, unknown> = {}) {
  const res = await r.api<{ task: Task; created: boolean }>("/api/tasks", { body: { prompt, idempotencyKey: key(), ...extra } });
  expect(res.status).toBe(201);
  return res.body.task;
}

const taskEnd = (r: Running, taskId: string, timeoutMs = 10_000) =>
  readEvents(r.apiPort, { taskId, until: ended, timeoutMs });

describe("the vertical slice", () => {
  it("runs a task end to end: approval, browser, artifact, result", async () => {
    const { r, model, workspace } = await setup([
      act("browser.navigate", { url: DOCS }, "Open the install docs"),
      act("browser.extract_text", {}),
      (input) => {
        expect(input.prompt).toContain("pip install example");
        return act("fs.write_artifact", { path: "report.md", content: "# Install\n\n`pip install example`" });
      },
      done("Saved the install steps to report.md."),
    ]);
    const task = await submit(r);

    const approval = await readEvents(r.apiPort, { taskId: task.id, until: (e) => e.type === "approval.requested" });
    const requested = approval.at(-1)!;
    expect(requested.payload).toMatchObject({ op: "browser.navigate", target: DOCS, reason: "first visit to example.org" });
    expect((await r.api(`/api/tasks/${task.id}`)).body.task.status).toBe("waiting_for_approval");

    const decided = await r.api(`/api/agents/agent-01/approval`, {
      body: { approvalId: requested.payload.approvalId, decision: "approve" },
    });
    expect(decided.status).toBe(200);

    const events = await taskEnd(r, task.id);
    expect(events.at(-1)).toMatchObject({ type: "task.completed", payload: { artifacts: ["report.md"] } });
    expect(events.map((e) => e.type)).toEqual([
      "task.queued",
      "task.started",
      "approval.requested",
      "approval.resolved",
      "tool.started",
      "browser.navigation",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.started",
      "artifact.created",
      "tool.completed",
      "task.completed",
    ]);
    // Per-task sequence numbers have no gaps, global ones only go up.
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);

    const report = await readFile(join(workspace, "tasks", task.id, "report.md"), "utf8");
    expect(report).toContain("pip install example");
    const final = (await r.api(`/api/tasks/${task.id}`)).body.task as Task;
    expect(final).toMatchObject({ status: "succeeded", steps: 3, result: { summary: "Saved the install steps to report.md." } });
    expect(model.calls).toHaveLength(4);
    // The approved site is remembered: the next task goes straight through.
    expect(r.backend.store.approvedDomains("agent-01")).toEqual(["example.org"]);
  });

  it("does not approve or run the same successful operation twice", async () => {
    const { r, model } = await setup([
      act("fs.write_artifact", { path: "report.md", content: "saved" }),
      act("fs.write_artifact", { path: "report.md", content: "saved" }),
      done("Saved the report."),
    ]);
    const task = await submit(r);
    const events = await taskEnd(r, task.id);

    expect(events.at(-1)).toMatchObject({ type: "task.completed" });
    expect(events.filter((e) => e.type === "tool.started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "approval.requested")).toHaveLength(0);
    expect((await r.api(`/api/tasks/${task.id}`)).body.task.steps).toBe(1);
    expect(model.calls).toHaveLength(3);
  });

  it("returns the same task when a submit is retried", async () => {
    const { r } = await setup([done("ok")]);
    const body = { prompt: "hello", idempotencyKey: "retry-key-12345" };
    const first = await r.api("/api/tasks", { body });
    const second = await r.api("/api/tasks", { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.task.id).toBe(first.body.task.id);
    await taskEnd(r, first.body.task.id);
    const queued = r.backend.events.after(0).filter((e) => e.type === "task.queued");
    expect(queued).toHaveLength(1);
  });

  it("lets a client that reconnects pick up exactly where it stopped", async () => {
    const { r } = await setup([act("fs.list", {}), act("fs.list", {}), done("listed")]);
    const task = await submit(r, "list twice");
    const firstPart = await readEvents(r.apiPort, { until: (e) => e.type === "tool.started" });
    const resumeFrom = firstPart.at(-1)!.seq;
    const rest = await readEvents(r.apiPort, { after: resumeFrom, until: ended });
    const all = [...firstPart, ...rest];
    const seqs = all.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const stored = r.backend.events.after(0, { taskId: task.id }).map((e) => e.seq);
    expect(all.filter((e) => e.taskId === task.id).map((e) => e.seq)).toEqual(stored);
  });
});

describe("reliability", () => {
  it("survives a backend restart in the middle of a job without running anything twice", async () => {
    const ports = { api: await freePort(), worker: await freePort() };
    const { r, browser, dataDir } = await setup([act("browser.navigate", { url: DOCS })], ports);
    r.backend.store.approveDomain("agent-01", "example.org");
    const release = browser.hold();
    const task = await submit(r);
    await waitFor(() => browser.visits.length === 1, 5_000, "the worker to start the job");

    await r.backend.close();
    running = running.filter((x) => x !== r);
    // The job finishes while nobody is listening; the worker keeps the outcome.
    release();

    const model2 = new ScriptedModel([
      (input) => {
        expect(input.prompt).toContain('Opened "Install guide"');
        return done("Read the docs.");
      },
    ]);
    const r2 = await startBackend(dataDir, model2, ports);
    running.push(r2);
    const events = await taskEnd(r2, task.id, 15_000);
    expect(events.at(-1)?.type).toBe("task.completed");

    expect(r2.backend.store.tasks()).toHaveLength(1);
    expect(browser.visits).toEqual([DOCS]);
    const jobs = r2.backend.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE task_id = ?").get(task.id) as { n: number };
    expect(Number(jobs.n)).toBe(1);
    expect(events.filter((e) => e.type === "task.started")).toHaveLength(1);
  });

  it("cancels a running task and stops its job", async () => {
    const { r, browser } = await setup([act("browser.navigate", { url: DOCS })]);
    r.backend.store.approveDomain("agent-01", "example.org");
    const release = browser.hold();
    const task = await submit(r);
    await waitFor(() => browser.visits.length === 1, 5_000, "the job to start");
    const res = await r.api(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const events = await taskEnd(r, task.id);
    expect(events.at(-1)?.type).toBe("task.cancelled");
    const job = await waitFor(() => {
      const j = r.backend.store.db.prepare("SELECT status FROM jobs WHERE task_id = ?").get(task.id) as { status: string };
      return j.status === "cancelled" ? j : null;
    }, 5_000, "the job to be cancelled");
    expect(job.status).toBe("cancelled");
    release();
  });

  it("fails an operation that runs past its deadline, and tells the model", async () => {
    const { r, browser } = await setup([
      act("browser.navigate", { url: DOCS }),
      (input) => {
        expect(input.prompt).toMatch(/failed: no result within 1 s/);
        return done("The page did not load.");
      },
    ]);
    r.backend.store.approveDomain("agent-01", "example.org");
    browser.hold();
    const task = await submit(r, "open docs", { budget: { opTimeoutMs: 1_000 } });
    const events = await taskEnd(r, task.id);
    expect(events.find((e) => e.type === "tool.completed")?.payload).toMatchObject({ ok: false });
    expect(events.at(-1)?.type).toBe("task.completed");
  });

  it("fails the task when the whole budget runs out", async () => {
    const { r, browser } = await setup([act("browser.navigate", { url: DOCS })]);
    r.backend.store.approveDomain("agent-01", "example.org");
    browser.hold();
    const task = await submit(r, "open docs", { budget: { timeoutMs: 10_000, opTimeoutMs: 60_000 } });
    const events = await taskEnd(r, task.id, 15_000);
    expect(events.at(-1)).toMatchObject({ type: "task.failed", payload: { reason: "timeout" } });
  }, 20_000);

  it("never re-runs a write whose worker vanished: the task fails as worker_lost", async () => {
    const { r } = await setup([act("fs.write_artifact", { path: "a.md", content: "x" })]);
    workers[0]!.stop(); // No live worker; we play a dead one instead.
    workers = [];
    const task = await submit(r);
    const claim = async () =>
      fetch(`http://127.0.0.1:${r.workerPort}/worker/v1/jobs/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-01" }),
      }).then((res) => res.json() as Promise<{ job: { id: string } | null }>);
    await waitFor(async () => (await claim()).job, 5_000, "a job to claim");
    const events = await taskEnd(r, task.id);
    expect(events.at(-1)).toMatchObject({ type: "task.failed", payload: { reason: "worker_lost" } });
  });

  it("hands a read-only job to the worker again when the first one vanished", async () => {
    const { r, browser, workspace } = await setup([act("browser.navigate", { url: DOCS }), done("read")]);
    r.backend.store.approveDomain("agent-01", "example.org");
    workers[0]!.stop();
    workers = [];
    const task = await submit(r);
    await waitFor(
      async () =>
        (
          (await fetch(`http://127.0.0.1:${r.workerPort}/worker/v1/jobs/claim`, {
            method: "POST",
            headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ agentId: "agent-01" }),
          }).then((res) => res.json())) as { job: unknown }
        ).job,
      5_000,
      "a job to claim",
    );
    // A healthy worker arrives after the first one went silent.
    const { worker } = startWorker(workspace, r.workerPort, browser);
    workers.push(worker);
    const events = await taskEnd(r, task.id);
    expect(events.at(-1)?.type).toBe("task.completed");
    expect(browser.visits).toEqual([DOCS]);
  });
});

describe("model retries", () => {
  it("asks again when the model timed out or could not be reached", async () => {
    const { r, model } = await setup([
      new ModelError("timeout", "no answer within 180 s"),
      new ModelError("unavailable", "claude exited with code 1"),
      done("third time lucky"),
    ]);
    const task = await submit(r);
    const events = await taskEnd(r, task.id);
    expect(events.at(-1)).toMatchObject({ type: "task.completed", payload: { summary: "third time lucky" } });
    expect(model.calls).toHaveLength(3);
  });

  it("gives up once the pauses are used, and never retries a rate limit", async () => {
    const lost = () => new ModelError("unavailable", "down");
    const a = await setup([lost(), lost(), lost(), done("never")]);
    const t1 = await submit(a.r);
    expect((await taskEnd(a.r, t1.id)).at(-1)).toMatchObject({ type: "task.failed", payload: { reason: "model_error" } });
    expect(a.model.calls).toHaveLength(3);

    const b = await setup([new ModelError("rate_limited", "usage limit reached"), done("never")]);
    const t2 = await submit(b.r);
    expect((await taskEnd(b.r, t2.id)).at(-1)).toMatchObject({ type: "task.failed", payload: { reason: "rate_limited" } });
    expect(b.model.calls).toHaveLength(1);
  });
});

describe("safety", () => {
  it("reports a rejected approval to the model instead of running the operation", async () => {
    const { r, browser } = await setup([
      act("browser.navigate", { url: DOCS }),
      (input) => {
        expect(input.prompt).toContain("the user rejected this operation");
        return done("Could not open the docs without permission.");
      },
    ]);
    const task = await submit(r);
    const ev = await readEvents(r.apiPort, { taskId: task.id, until: (e) => e.type === "approval.requested" });
    await r.api("/api/agents/agent-01/approval", { body: { approvalId: ev.at(-1)!.payload.approvalId, decision: "reject" } });
    const events = await taskEnd(r, task.id);
    expect(events.find((e) => e.type === "approval.resolved")?.payload.decision).toBe("reject");
    expect(events.at(-1)?.type).toBe("task.completed");
    expect(browser.visits).toEqual([]);
    // Answering twice is refused rather than applied twice.
    const again = await r.api("/api/agents/agent-01/approval", { body: { approvalId: ev.at(-1)!.payload.approvalId, decision: "approve" } });
    expect(again.status).toBe(409);
  });

  it("keeps secrets out of events, stored outcomes and the model's next prompt", async () => {
    const secret = "sk-ant-api03-SECRETSECRETSECRETSECRET";
    const { r, browser } = await setup([
      act("browser.navigate", { url: DOCS }),
      act("browser.extract_text", {}),
      (input) => {
        expect(input.prompt).not.toContain(secret);
        expect(input.prompt).toContain("[redacted]");
        return done("done");
      },
    ]);
    r.backend.store.approveDomain("agent-01", "example.org");
    browser.site.set(DOCS, { title: "Keys", text: `Use the key ${secret} to log in.` });
    const task = await submit(r);
    const events = await taskEnd(r, task.id);
    expect(JSON.stringify(events)).not.toContain(secret);
    const outcomes = r.backend.store.db.prepare("SELECT outcome FROM jobs").all() as { outcome: string }[];
    expect(JSON.stringify(outcomes)).not.toContain(secret);
  });

  it("refuses the browser a private address before asking anyone", async () => {
    const { r, browser } = await setup([
      act("browser.navigate", { url: "http://127.0.0.1:47621/worker/v1/hello" }),
      done("blocked"),
    ]);
    const task = await submit(r);
    const events = await taskEnd(r, task.id);
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(events.find((e) => e.type === "tool.completed")?.payload).toMatchObject({ ok: false });
    expect(browser.visits).toEqual([]);
  });

  it("checks both tokens, and keeps them apart", async () => {
    const { r } = await setup([]);
    expect((await r.api("/api/agents", { token: "wrong" })).status).toBe(401);
    expect((await r.api("/api/agents", { token: WORKER_TOKEN })).status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${r.workerPort}/worker/v1/heartbeat`, {
      method: "POST",
      headers: { Authorization: "Bearer test-api-token-0123456789", "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-01", running: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a task that is not well formed", async () => {
    const { r } = await setup([]);
    expect((await r.api("/api/tasks", { body: { prompt: "", idempotencyKey: key() } })).status).toBe(400);
    expect((await r.api("/api/tasks", { body: { prompt: "x", idempotencyKey: key(), agentId: "agent-99" } })).status).toBe(400);
  });
});

describe("files", () => {
  it("lists and downloads a task's files through the worker", async () => {
    const { r } = await setup([act("fs.write_artifact", { path: "report.md", content: "# Report" }), done("saved")]);
    const task = await submit(r);
    await taskEnd(r, task.id);
    const list = await r.api(`/api/agents/agent-01/files?taskId=${task.id}`);
    expect(list.status).toBe(200);
    expect(list.body.files).toEqual([{ path: "report.md", bytes: 8 }]);
    const file = await r.api(`/api/agents/agent-01/files/${task.id}/report.md`);
    expect(file).toEqual({ status: 200, body: "# Report" });
    expect((await r.api(`/api/agents/agent-01/files/${task.id}/..%2Fsecret`)).status).toBe(400);
  });

  it("downloads a screenshot byte for byte", async () => {
    const { r } = await setup([
      act("browser.navigate", { url: DOCS }),
      act("browser.screenshot", { name: "page.png" }),
      done("captured"),
    ]);
    const task = await submit(r);
    const approval = await readEvents(r.apiPort, { taskId: task.id, until: (e) => e.type === "approval.requested" });
    await r.api("/api/agents/agent-01/approval", {
      body: { approvalId: approval.at(-1)!.payload.approvalId, decision: "approve" },
    });
    await taskEnd(r, task.id);
    const file = await r.raw(`/api/agents/agent-01/files/${task.id}/page.png`);
    expect(file.status).toBe(200);
    expect(file.type).toBe("image/png");
    expect(file.bytes.equals(PNG_BYTES)).toBe(true);
    // The bytes never reach the event log or the database.
    const stored = JSON.stringify(r.backend.store.db.prepare("SELECT outcome FROM jobs").all());
    expect(stored).not.toContain(PNG_BYTES.subarray(8, 40).toString("base64"));
  });

  it("downloads a long text file whole, with secrets redacted", async () => {
    const long = `${"line of the report\n".repeat(2_000)}token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA\n`;
    const { r } = await setup([act("fs.write_artifact", { path: "big.md", content: long }), done("saved")]);
    const task = await submit(r);
    await taskEnd(r, task.id);
    const file = await r.raw(`/api/agents/agent-01/files/${task.id}/big.md`);
    expect(file.status).toBe(200);
    const text = file.bytes.toString("utf8");
    expect(text.length).toBeGreaterThan(30_000);
    expect(text).not.toContain("sk-ant-api03");
    expect(text.endsWith("token=[redacted]\n")).toBe(true);
  });

  it("never lets the model ask for a download", async () => {
    const { r, model } = await setup([act("fs.fetch", { path: "x.md" }), done("ok")]);
    const task = await submit(r);
    await taskEnd(r, task.id);
    expect(model.calls[1]?.prompt).toMatch(/refused: unknown operation fs\.fetch/);
    expect(r.backend.store.steps(task.id)).toHaveLength(0);
  });
});

describe("agents", () => {
  it("shows the agent as ready once its worker says hello", async () => {
    const { r } = await setup([]);
    const agents = await waitFor(async () => {
      const res = await r.api<{ agents: { status: string }[] }>("/api/agents");
      return res.body.agents[0]?.status === "ready" ? res.body.agents : null;
    }, 5_000, "the agent to be ready");
    expect(agents[0]).toMatchObject({ id: "agent-01", status: "ready" });
    const statusEvents: AgentEvent[] = r.backend.events.after(0).filter((e) => e.type === "agent.status_changed");
    expect(statusEvents[0]?.payload).toEqual({ status: "ready" });
  });

  it("reports the worker's disk and browser, and what is wrong with them", async () => {
    const { r, browser } = await setup([]);
    const ready = await waitFor(async () => {
      const res = await r.api("/api/agents");
      return res.body.agents[0]?.health ? res.body.agents[0] : null;
    }, 5_000, "a health report");
    expect(ready.health).toMatchObject({ browserReady: true });
    expect(ready.health.diskTotalBytes).toBeGreaterThan(0);
    expect(ready.problems).toEqual(ready.health.diskFreeBytes < 1024 ** 3 ? ["low_disk"] : []);

    browser.installed = false;
    r.backend.store.setAgentHealth("agent-01", { diskFreeBytes: 10, diskTotalBytes: 100, browserReady: false });
    expect((await r.api("/api/agents")).body.agents[0].problems).toEqual(["low_disk", "no_browser"]);
  });

  it("tells a stopped VM from a worker that does not answer", async () => {
    let vmRunning: boolean | null = false;
    const dataDir = await tempDir("orch-data-");
    dirs.push(dataDir);
    const r = await startBackend(dataDir, new ScriptedModel([]), undefined, {}, { vmProbe: async () => vmRunning });
    running.push(r);
    expect((await r.api("/api/agents")).body.agents[0]).toMatchObject({ status: "offline", problems: ["vm_stopped"] });
    vmRunning = true;
    await new Promise((resolve) => setTimeout(resolve, 10_050)); // past the 10 s cache
    expect((await r.api("/api/agents")).body.agents[0].problems).toEqual(["worker_down"]);
  }, 20_000);

  it("hands the worker the retention period", async () => {
    const { r } = await setup([], undefined, { retentionDays: 7 });
    const res = await fetch(`http://127.0.0.1:${r.workerPort}/worker/v1/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${WORKER_TOKEN}` },
      body: JSON.stringify({ agentId: "agent-01", version: "test", capabilities: [], journal: [] }),
    });
    expect(await res.json()).toMatchObject({ ok: true, retentionDays: 7 });
  });
});

describe("models", () => {
  it("runs a task on the model it names, through the same worker and events", async () => {
    const dataDir = await tempDir("orch-data-");
    const workspace = await tempDir("orch-ws-");
    dirs.push(dataDir, workspace);
    const main = new ScriptedModel([]);
    const other = new ScriptedModel([act("fs.write_artifact", { path: "a.md", content: "from the other model" }), done("written")]);
    const r = await startBackend(dataDir, main, undefined, { other });
    running.push(r);
    const { worker } = startWorker(workspace, r.workerPort, new FakeBrowser());
    workers.push(worker);

    const models = await r.api("/api/models");
    expect(models.body.profiles.map((p: { id: string }) => p.id)).toEqual(["scripted", "other"]);
    expect((await r.api("/api/tasks", { body: { prompt: "x", idempotencyKey: key(), modelProfileId: "nope" } })).status).toBe(400);

    const task = await submit(r, "write a.md", { modelProfileId: "other" });
    expect(task.modelProfileId).toBe("other");
    const events = await taskEnd(r, task.id);
    expect(events.at(-1)?.type).toBe("task.completed");
    expect(events.at(-1)?.payload.modelProfileId).toBe("other");
    expect(events.find((e) => e.type === "task.started")?.payload.modelProfileId).toBe("other");
    expect(main.calls).toHaveLength(0);
    expect(other.calls).toHaveLength(2);
    expect(await readFile(join(workspace, "tasks", task.id, "a.md"), "utf8")).toBe("from the other model");
  });
});
