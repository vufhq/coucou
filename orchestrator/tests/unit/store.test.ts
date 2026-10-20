import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../server/src/store.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
  store.ensureAgent({ id: "agent-01", name: "Agent 01", vmId: "wsl:agent-01", modelProfileId: "scripted" });
});
afterEach(() => store.close());

const req = (key: string) => ({ prompt: "do it", agentId: "agent-01", idempotencyKey: key });

describe("store", () => {
  it("creates a task once per idempotency key", () => {
    const first = store.createTask(req("key-00000001"), "scripted");
    const again = store.createTask(req("key-00000001"), "scripted");
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    expect(store.tasks()).toHaveLength(1);
  });

  it("numbers events globally and per task", () => {
    const a = store.createTask(req("key-0000000a"), "scripted").task;
    const b = store.createTask(req("key-0000000b"), "scripted").task;
    const e1 = store.appendEvent({ taskId: a.id, agentId: "agent-01", type: "task.queued", payload: {} });
    const e2 = store.appendEvent({ taskId: b.id, agentId: "agent-01", type: "task.queued", payload: {} });
    const e3 = store.appendEvent({ taskId: a.id, agentId: "agent-01", type: "task.started", payload: {} });
    const e4 = store.appendEvent({ taskId: null, agentId: "agent-01", type: "agent.status_changed", payload: {} });
    expect([e1.seq, e2.seq, e3.seq, e4.seq]).toEqual([1, 2, 3, 4]);
    expect([e1.sequence, e2.sequence, e3.sequence, e4.sequence]).toEqual([1, 1, 2, null]);
    expect(store.eventsAfter(2).map((e) => e.seq)).toEqual([3, 4]);
    expect(store.eventsAfter(0, { taskId: a.id }).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("hands a job out once and notices when its lease runs out", () => {
    const t = store.createTask(req("key-0000000c"), "scripted").task;
    const job = store.createJob({ taskId: t.id, agentId: "agent-01", op: "fs.list", args: {}, deadlineMs: 1_000 });
    expect(store.claimJob("agent-01", 1_000)?.id).toBe(job.id);
    expect(store.claimJob("agent-01", 1_000)).toBeNull();
    expect(store.expiredLeases(Date.now() + 2_000).map((j) => j.id)).toEqual([job.id]);
    expect(store.finishJob(job.id, { status: "succeeded", result: "[]" })).toBe(true);
    // A second report of the same job changes nothing.
    expect(store.finishJob(job.id, { status: "failed" })).toBe(false);
    expect(store.job(job.id)?.status).toBe("succeeded");
  });

  it("settles an approval only once", () => {
    const t = store.createTask(req("key-0000000d"), "scripted").task;
    const a = store.createApproval({ taskId: t.id, agentId: "agent-01", step: 1, op: "fs.list", target: "", reason: "r" });
    expect(store.decideApproval(a.id, "approved")).toBe(true);
    expect(store.decideApproval(a.id, "rejected")).toBe(false);
    expect(store.approval(a.id)?.status).toBe("approved");
  });

  it("does not count paused approval time twice", () => {
    const task = store.createTask(req("key-approval-pause"), "scripted").task;
    store.setTaskStatus(task.id, "starting");
    store.setTaskStatus(task.id, "waiting_for_approval");
    store.pauseTask(task.id, "waiting_for_approval", false);
    expect(store.taskInactiveMs(task.id)).toBe(0);
    expect(store.pausedFromStatus(task.id)).toBe("waiting_for_approval");
    store.startTaskInactivity(task.id);
    expect(store.taskInactiveMs(task.id)).toBeGreaterThanOrEqual(0);
  });

  it("counts local-day usage and caps memory by dropping agent notes first", () => {
    const task = store.createTask(req("key-usage-01"), "scripted").task;
    store.setTaskStatus(task.id, "starting");
    store.setTaskStatus(task.id, "running");
    store.addStep({ taskId: task.id, note: "", op: "fs.list", args: {} });
    expect(store.agent("agent-01")?.usage).toEqual({ tasksToday: 1, stepsToday: 1 });

    const user = store.addNote({ agentId: "agent-01", text: "user note", source: "user" });
    for (let index = 0; index < 50; index++) {
      store.addNote({ agentId: "agent-01", text: `agent note ${index}`, source: "agent", taskId: task.id });
    }
    const notes = store.notes("agent-01");
    expect(notes).toHaveLength(50);
    expect(notes.some((note) => note.id === user!.id)).toBe(true);
    expect(notes.some((note) => note.text === "agent note 0")).toBe(false);
    expect(store.addNote({ agentId: "agent-01", text: "agent note 49", source: "agent" })!.id).toBe(
      notes.find((note) => note.text === "agent note 49")!.id,
    );

    store.ensureAgent({ id: "agent-02", name: "Agent 02", vmId: "wsl:agent-02", modelProfileId: "scripted" });
    for (let index = 0; index < 50; index++) {
      store.addNote({ agentId: "agent-02", text: `user note ${index}`, source: "user" });
    }
    expect(store.addNote({ agentId: "agent-02", text: "agent note", source: "agent" })).toBeNull();
    expect(store.notes("agent-02")).toHaveLength(50);
  });
});

describe("retention", () => {
  const finish = (key: string, status: "succeeded" | "running") => {
    const task = store.createTask(req(key), "scripted").task;
    store.appendEvent({ taskId: task.id, agentId: "agent-01", type: "task.queued", payload: {} });
    const step = store.addStep({ taskId: task.id, note: "", op: "fs.list", args: {} });
    const job = store.createJob({ taskId: task.id, agentId: "agent-01", op: "fs.list", args: {}, deadlineMs: 1_000 });
    store.setStepJob(task.id, step.n, job.id);
    store.createApproval({ taskId: task.id, agentId: "agent-01", step: step.n, op: "fs.list", target: "", reason: "" });
    if (status === "succeeded") store.finishTask(task.id, "succeeded", { result: { summary: "", artifacts: [] } });
    else store.setTaskStatus(task.id, "running");
    return task.id;
  };

  it("removes old finished tasks and all they own, and nothing still running", () => {
    const old = finish("key-0000old1", "succeeded");
    const busy = finish("key-0000busy", "running");
    store.appendEvent({ taskId: null, agentId: "agent-01", type: "agent.status_changed", payload: {} });
    // Nothing is older than an hour ago yet.
    expect(store.pruneBefore(new Date(Date.now() - 3_600_000))).toBe(0);
    expect(store.pruneBefore(new Date(Date.now() + 1_000))).toBe(1);
    expect(store.task(old)).toBeNull();
    expect(store.steps(old)).toEqual([]);
    expect(store.eventsAfter(0, { taskId: old })).toEqual([]);
    const count = (table: string) =>
      Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(old) as { n: number }).n);
    expect(count("jobs") + count("approvals")).toBe(0);
    expect(store.task(busy)?.status).toBe("running");
    expect(store.steps(busy)).toHaveLength(1);
    expect(store.eventsAfter(0).filter((e) => e.taskId === null)).toEqual([]);
  });

  it("adds the health column to a database made before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-migrate-"));
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, vm_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline', model_profile_id TEXT NOT NULL, last_seen_at TEXT,
      approved_domains TEXT NOT NULL DEFAULT '[]')`);
    db.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
      model_profile_id TEXT NOT NULL, workspace TEXT NOT NULL, budget TEXT NOT NULL,
      steps INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT
    )`);
    db.exec(`INSERT INTO agents (id, name, vm_id, model_profile_id) VALUES ('agent-01', 'Agent 01', 'wsl:agent-01', 'scripted')`);
    db.exec(`INSERT INTO tasks (
      id, agent_id, prompt, status, model_profile_id, workspace, budget,
      idempotency_key, created_at, updated_at
    ) VALUES (
      'old-task', 'agent-01', 'keep me', 'queued', 'scripted', '/workspace/tasks/old-task',
      '{"maxSteps":20,"timeoutMs":600000,"opTimeoutMs":60000}',
      'old-task-key', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )`);
    db.close();
    const migrated = new Store(path);
    try {
      expect(migrated.agent("agent-01")?.health).toBeNull();
      expect(migrated.agent("agent-01")).toMatchObject({
        paused: false,
        limits: { tasksPerDay: 30, stepsPerDay: 300 },
      });
      expect(migrated.task("old-task")).toMatchObject({
        prompt: "keep me",
        source: "user",
        goalId: null,
        question: null,
      });
      migrated.setAgentHealth("agent-01", { diskFreeBytes: 1, diskTotalBytes: 2, browserReady: true });
      expect(migrated.agent("agent-01")?.health).toMatchObject({ diskFreeBytes: 1, diskTotalBytes: 2, browserReady: true });
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("agents config and tokens", () => {
  it("reads ORCH_AGENTS, names each agent and its VM, and refuses bad ids", async () => {
    const { parseAgents } = await import("../../server/src/config.ts");
    expect(parseAgents(undefined)).toEqual([{ id: "agent-01", name: "Agent 01", vmId: "wsl:agent-01" }]);
    expect(parseAgents(" agent-01, agent-02 ,agent-01").map((a) => [a.id, a.name, a.vmId])).toEqual([
      ["agent-01", "Agent 01", "wsl:agent-01"],
      ["agent-02", "Agent 02", "wsl:agent-02"],
    ]);
    expect(() => parseAgents("agent-01,Agent 2")).toThrow(/not an agent id/);
    expect(() => parseAgents("claude")).toThrow();
    expect(() => parseAgents(",")).toThrow(/no agent/);
  });

  it("keeps agent-01's token entry and finds the agent from a token", async () => {
    const { agentForBearer, workerTokenKey } = await import("../../server/src/tokens.ts");
    expect(workerTokenKey("agent-01")).toBe("orchestrator-worker-token");
    expect(workerTokenKey("agent-02")).toBe("orchestrator-worker-token-agent-02");
    const tokens = new Map([["agent-01", "aaaa"], ["agent-02", "bbbb"]]);
    expect(agentForBearer("Bearer bbbb", tokens)).toBe("agent-02");
    expect(agentForBearer("Bearer cccc", tokens)).toBeNull();
    expect(agentForBearer(undefined, tokens)).toBeNull();
  });
});
