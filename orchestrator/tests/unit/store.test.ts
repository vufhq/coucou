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
});
