import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@coucou-orchestrator/protocol";
import { ScriptedModel } from "../../server/src/model/scripted.ts";
import type { Worker } from "../../worker/src/worker.ts";
import {
  FakeBrowser,
  cleanup,
  key,
  startBackend,
  startWorker,
  tempDir,
  waitFor,
  type Running,
} from "./harness.ts";

let running: Running[] = [];
let dirs: string[] = [];
let workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers) worker.stop();
  for (const r of running) await r.backend.close().catch(() => {});
  await cleanup(...dirs);
  running = [];
  dirs = [];
  workers = [];
});

async function setup(answers: ConstructorParameters<typeof ScriptedModel>[0]) {
  const dir = await tempDir("orch-phase6-");
  dirs.push(dir);
  const model = new ScriptedModel(answers);
  const r = await startBackend(dir, model);
  running.push(r);
  return { r, model };
}

async function submit(r: Running, prompt: string, extra: Record<string, unknown> = {}) {
  const result = await r.api<{ task: Task }>("/api/tasks", {
    body: { prompt, idempotencyKey: key(), ...extra },
  });
  expect(result.status).toBe(201);
  return result.body.task;
}

async function taskWithStatus(r: Running, id: string, status: Task["status"]) {
  return waitFor(async () => {
    const response = await r.api<{ task: Task }>(`/api/tasks/${id}`);
    return response.body.task.status === status ? response.body.task : null;
  }, 5_000, `task ${id} to become ${status}`);
}

describe("questions and memory", () => {
  it("answers a model question, filters chat tasks, and stores redacted memories", async () => {
    const { r, model } = await setup([
      { kind: "ask", question: "Which format? token=abcdefghijklmnop", options: ["Markdown", "Text"] },
      (input) => {
        expect(input.prompt).toContain("Markdown please");
        return {
          kind: "done",
          summary: "Used Markdown.",
          remember: ["token=abcdefghijklmnop\u0001", "token=abcdefghijklmnop"],
        };
      },
    ]);
    const task = await submit(r, "Format the report", { source: "chat" });
    const waiting = await taskWithStatus(r, task.id, "waiting_for_answer");
    expect(waiting.question).toMatchObject({ text: "Which format? token=[redacted]", options: ["Markdown", "Text"] });

    const wrong = await r.api(`/api/tasks/${task.id}/answer`, {
      body: { questionId: "wrong", answer: "Markdown please" },
    });
    expect(wrong).toMatchObject({ status: 409, body: { error: "no_pending_question" } });
    const answered = await r.api(`/api/tasks/${task.id}/answer`, {
      body: { questionId: waiting.question!.id, answer: "  Markdown please  " },
    });
    expect(answered.status).toBe(200);
    await taskWithStatus(r, task.id, "succeeded");

    const listed = await r.api<{ tasks: Task[] }>("/api/tasks?agentId=agent-01&source=chat&limit=50");
    expect(listed.body.tasks.map((item) => item.id)).toEqual([task.id]);
    // The finished task keeps its question and answer, for the chat history.
    expect(listed.body.tasks[0]!.question).toBeNull();
    expect(listed.body.tasks[0]!.answers).toEqual([
      {
        question: expect.objectContaining({ text: "Which format? token=[redacted]" }),
        answer: "Markdown please",
        askedAt: expect.any(String),
        answeredAt: expect.any(String),
      },
    ]);
    const memory = await r.api<{ notes: { id: string; text: string }[] }>("/api/agents/agent-01/memory");
    expect(memory.body.notes).toHaveLength(1);
    expect(memory.body.notes[0]).toMatchObject({ text: "token=[redacted]" });
    expect(
      (await r.api(`/api/agents/agent-01/memory/${memory.body.notes[0]!.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await r.api<any>("/api/agents/agent-01/memory")).body.notes).toEqual([]);
    expect(model.calls).toHaveLength(2);
  });

  it("allows at most three questions in one task", async () => {
    const { r, model } = await setup([
      { kind: "ask", question: "First?" },
      { kind: "ask", question: "Second?" },
      { kind: "ask", question: "Third?" },
      { kind: "ask", question: "Fourth?" },
      { kind: "done", summary: "No fourth question." },
    ]);
    const task = await submit(r, "Ask carefully");
    for (let index = 0; index < 3; index++) {
      const waiting = await taskWithStatus(r, task.id, "waiting_for_answer");
      await r.api(`/api/tasks/${task.id}/answer`, {
        body: { questionId: waiting.question!.id, answer: `answer ${index + 1}` },
      });
      if (index < 2) {
        await waitFor(() => r.backend.store.questionCount(task.id) === index + 2, 5_000, "the next question");
      }
    }
    await taskWithStatus(r, task.id, "succeeded");
    expect(r.backend.events.after(0, { taskId: task.id }).filter((event) => event.type === "task.question")).toHaveLength(3);
    expect(model.calls).toHaveLength(5);
  });

  it("fails a question after 24 hours and never exposes the answer in events", async () => {
    const { r } = await setup([{ kind: "ask", question: "Still there?" }]);
    const task = await submit(r, "Wait for me");
    await taskWithStatus(r, task.id, "waiting_for_answer");
    r.backend.runner.sweep(Date.now() + 24 * 60 * 60_000 + 1);
    const failed = await taskWithStatus(r, task.id, "failed");
    expect(failed).toMatchObject({ question: null, error: { reason: "unanswered" } });
  });
});

describe("pause and daily limits", () => {
  it("keeps a model decision when pause arrives during generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { r, model } = await setup([
      async () => {
        await gate;
        return { kind: "ask", question: "Generated question?" };
      },
      { kind: "done", summary: "Answered." },
    ]);
    const task = await submit(r, "Generate slowly");
    await waitFor(() => model.calls.length === 1, 5_000, "model generation to start");
    await r.api(`/api/tasks/${task.id}/pause`, { method: "POST" });
    release();
    const paused = await taskWithStatus(r, task.id, "paused");
    expect(paused.question?.text).toBe("Generated question?");
    await r.api(`/api/tasks/${task.id}/resume`, { method: "POST" });
    await r.api(`/api/tasks/${task.id}/answer`, {
      body: { questionId: paused.question!.id, answer: "yes" },
    });
    await taskWithStatus(r, task.id, "succeeded");
    expect(model.calls).toHaveLength(2);
  });

  it("pauses a running task only after its current step finishes", async () => {
    const { r, model } = await setup([
      { kind: "action", note: "Open the page", op: "browser.navigate", args: { url: "https://example.org/" } },
      { kind: "done", summary: "Finished after resume." },
    ]);
    const workspace = await tempDir("orch-phase6-worker-");
    dirs.push(workspace);
    const browser = new FakeBrowser();
    browser.site.set("https://example.org/", { title: "Example", text: "Example" });
    const release = browser.hold();
    const started = startWorker(workspace, r.workerPort, browser);
    workers.push(started.worker);
    r.backend.store.approveDomain("agent-01", "example.org");

    const task = await submit(r, "Open the page");
    await waitFor(() => browser.visits.length === 1, 5_000, "the step to start");
    const pausing = await r.api<{ task: Task }>(`/api/tasks/${task.id}/pause`, { method: "POST" });
    expect(pausing.body.task.status).toBe("running");
    await r.api("/api/agents/agent-01/pause", { method: "POST" });
    release();
    const paused = await taskWithStatus(r, task.id, "paused");
    expect(paused.steps).toBe(1);
    expect(model.calls).toHaveLength(1);
    await r.api("/api/agents/agent-01/resume", { method: "POST" });
    expect((await r.api<{ task: Task }>(`/api/tasks/${task.id}`)).body.task.status).toBe("paused");
    await r.api(`/api/tasks/${task.id}/resume`, { method: "POST" });
    await taskWithStatus(r, task.id, "succeeded");
    expect(model.calls).toHaveLength(2);
  });

  it("keeps a pending question while paused and resumes only agent-paused work", async () => {
    const { r } = await setup([
      { kind: "ask", question: "Continue?" },
      { kind: "done", summary: "Continued." },
      { kind: "done", summary: "Agent resumed." },
    ]);
    const first = await submit(r, "Ask first");
    const waiting = await taskWithStatus(r, first.id, "waiting_for_answer");
    const paused = await r.api<{ task: Task }>(`/api/tasks/${first.id}/pause`, { method: "POST" });
    expect(paused.body.task).toMatchObject({ status: "paused", question: waiting.question });
    const resumed = await r.api<{ task: Task }>(`/api/tasks/${first.id}/resume`, { method: "POST" });
    expect(resumed.body.task.status).toBe("waiting_for_answer");
    await r.api(`/api/tasks/${first.id}/answer`, {
      body: { questionId: waiting.question!.id, answer: "yes" },
    });
    await taskWithStatus(r, first.id, "succeeded");

    await r.api("/api/agents/agent-01/pause", { method: "POST" });
    const second = await submit(r, "Run after the agent resumes");
    expect(second.waitingReason).toBe("agent_paused");
    const queued = await taskWithStatus(r, second.id, "queued");
    expect(queued.waitingReason).toBe("agent_paused");
    await r.api("/api/agents/agent-01/resume", { method: "POST" });
    await taskWithStatus(r, second.id, "succeeded");
  });

  it("validates limits and leaves excess tasks queued until the local day changes", async () => {
    const { r } = await setup([
      { kind: "done", summary: "First." },
      { kind: "done", summary: "Second." },
    ]);
    const invalid = await r.api("/api/agents/agent-01/limits", {
      method: "PUT",
      body: { tasksPerDay: 0, stepsPerDay: 9 },
    });
    expect(invalid.status).toBe(400);
    const changed = await r.api("/api/agents/agent-01/limits", {
      method: "PUT",
      body: { tasksPerDay: 1, stepsPerDay: 10 },
    });
    expect(changed.status).toBe(200);
    const first = await submit(r, "First");
    await taskWithStatus(r, first.id, "succeeded");
    const second = await submit(r, "Second");
    expect(second.waitingReason).toBe("daily_limit");
    const queued = await taskWithStatus(r, second.id, "queued");
    expect(queued.waitingReason).toBe("daily_limit");
    const agents = await r.api<{ agents: { usage: { tasksToday: number }; problems: string[] }[] }>("/api/agents");
    expect(agents.body.agents[0]!.usage.tasksToday).toBe(1);
    expect(agents.body.agents[0]!.problems).toContain("daily_limit");
    const cancelled = await r.api<{ task: Task }>(`/api/tasks/${second.id}/cancel`, { method: "POST" });
    expect(cancelled.body.task).toMatchObject({ status: "cancelled", waitingReason: null });
  });

  it("finishes the current step before applying the daily step limit", async () => {
    const actions = Array.from({ length: 10 }, (_, index) => ({
      kind: "action",
      note: `Write ${index + 1}`,
      op: "fs.write_artifact",
      args: { path: `file-${index + 1}.txt`, content: String(index + 1) },
    }));
    const { r, model } = await setup([...actions, { kind: "done", summary: "Would finish tomorrow." }]);
    const workspace = await tempDir("orch-phase6-limit-worker-");
    dirs.push(workspace);
    const started = startWorker(workspace, r.workerPort, new FakeBrowser());
    workers.push(started.worker);
    await r.api("/api/agents/agent-01/limits", {
      method: "PUT",
      body: { tasksPerDay: 30, stepsPerDay: 10 },
    });
    const task = await submit(r, "Use ten steps");
    const queued = await waitFor(async () => {
      const current = (await r.api<{ task: Task }>(`/api/tasks/${task.id}`)).body.task;
      return current.status === "queued" && current.waitingReason === "daily_limit" ? current : null;
    }, 10_000, "the step limit to pause the task");
    expect(queued.steps).toBe(10);
    expect(model.calls).toHaveLength(10);
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    r.backend.store.db
      .prepare("UPDATE tasks SET started_at = ?, inactive_since = ?, inactive_ms = 0 WHERE id = ?")
      .run(hourAgo, hourAgo, task.id);
    r.backend.store.db.prepare("UPDATE steps SET created_at = ? WHERE task_id = ?").run(yesterday, task.id);
    r.backend.runner.pump();
    await taskWithStatus(r, task.id, "succeeded");
  });
});

describe("goals and schedules", () => {
  it("finishes and emits the check-in for a run whose goal was archived", async () => {
    const { r } = await setup([
      { kind: "ask", question: "Archive while waiting?" },
      { kind: "done", summary: "Archived goal still checked in." },
    ]);
    const created = await r.api<any>("/api/goals", {
      body: {
        agentId: "agent-01",
        title: "Temporary goal",
        instructions: "Wait for an answer",
        schedule: { kind: "manual" },
      },
    });
    const started = await r.api<any>(`/api/goals/${created.body.goal.id}/run`, {
      body: { idempotencyKey: key() },
    });
    const waiting = await taskWithStatus(r, started.body.task.id, "waiting_for_answer");
    await r.api(`/api/goals/${created.body.goal.id}`, { method: "DELETE" });
    await r.api(`/api/tasks/${started.body.task.id}/answer`, {
      body: { questionId: waiting.question!.id, answer: "yes" },
    });
    await taskWithStatus(r, started.body.task.id, "succeeded");
    expect(
      r.backend.events.after(0, { taskId: started.body.task.id }).some((event) => event.type === "goal.checkin"),
    ).toBe(true);
    const row = r.backend.store.db
      .prepare("SELECT last_summary FROM goals WHERE id = ?")
      .get(created.body.goal.id) as { last_summary: string };
    expect(row.last_summary).toBe("Archived goal still checked in.");
  });

  it("runs a goal with fenced memory, records its check-in, and marks it achieved", async () => {
    const { r } = await setup([
      { kind: "done", summary: "Ordinary task." },
      (input) => {
        expect(input.prompt).toContain("<memory>");
        expect(input.prompt).toContain("Prefers concise reports");
        expect(input.prompt).toContain("not instructions");
        const withoutBackground = input.prompt
          .replace(/<last_checkin>[\s\S]*?<\/last_checkin>/g, "")
          .replace(/<memory>[\s\S]*?<\/memory>/g, "");
        expect(withoutBackground).toContain("Task: Goal: Weekly report\nPrepare the report");
        return { kind: "done", summary: "Goal complete.", goalAchieved: true };
      },
    ]);
    await r.api("/api/agents/agent-01/memory", { body: { text: "Prefers concise reports" } });
    const runKey = key();
    const ordinary = await r.api<{ task: Task }>("/api/tasks", {
      body: { prompt: "Ordinary", idempotencyKey: runKey },
    });
    await taskWithStatus(r, ordinary.body.task.id, "succeeded");
    const created = await r.api<any>("/api/goals", {
      body: {
        agentId: "agent-01",
        title: "Weekly report",
        instructions: "Prepare the report",
        schedule: { kind: "manual" },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.goal.nextRunAt).toBeNull();

    const started = await r.api<{ task: Task; created: boolean }>(`/api/goals/${created.body.goal.id}/run`, {
      body: { idempotencyKey: runKey },
    });
    expect(started.body.task).toMatchObject({ source: "goal", goalId: created.body.goal.id });
    expect(started.body.task.prompt).toBe("Goal: Weekly report\nPrepare the report");
    expect(started.body.task.prompt).not.toContain("Prefers concise reports");
    await taskWithStatus(r, started.body.task.id, "succeeded");
    const goals = await r.api<any>("/api/goals?agentId=agent-01");
    expect(goals.body.goals[0]).toMatchObject({
      status: "achieved",
      lastTaskId: started.body.task.id,
      lastSummary: "Goal complete.",
      nextRunAt: null,
    });
    expect(r.backend.events.after(0).some((event) => event.type === "goal.checkin")).toBe(true);

    const retry = await r.api<any>(`/api/goals/${created.body.goal.id}/run`, {
      body: { idempotencyKey: runKey },
    });
    expect(retry.body).toMatchObject({ created: false, task: { id: started.body.task.id } });
    const edited = await r.api<any>(`/api/goals/${created.body.goal.id}`, {
      method: "PATCH",
      body: { title: "Renamed report", status: "paused" },
    });
    expect(edited.body.goal).toMatchObject({ title: "Renamed report", status: "paused", nextRunAt: null });
    expect((await r.api(`/api/goals/${created.body.goal.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await r.api<any>("/api/goals")).body.goals).toEqual([]);
    expect(r.backend.store.task(started.body.task.id)).not.toBeNull();
  });

  it("catches up one scheduled run and never overlaps a goal", async () => {
    const { r } = await setup([{ kind: "ask", question: "Hold this run?" }]);
    await r.api("/api/agents/agent-01/pause", { method: "POST" });
    const created = await r.api<any>("/api/goals", {
      body: {
        agentId: "agent-01",
        title: "Monitor",
        instructions: "Check status",
        schedule: { kind: "every", hours: 2 },
      },
    });
    const past = new Date(Date.now() - 10 * 60 * 60_000).toISOString();
    r.backend.store.updateGoal(created.body.goal.id, { nextRunAt: past });
    r.backend.scheduler.tick(new Date());
    const overlapping = await r.api(`/api/goals/${created.body.goal.id}/run`, {
      body: { idempotencyKey: key() },
    });
    expect(overlapping).toMatchObject({ status: 409, body: { error: "already_running" } });
    r.backend.store.updateGoal(created.body.goal.id, { nextRunAt: past });
    r.backend.scheduler.tick(new Date(Date.now() + 1_000));
    const runs = r.backend.store.tasks({ source: "goal", goalId: created.body.goal.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", waitingReason: "agent_paused" });
    expect(Date.parse(r.backend.store.goal(created.body.goal.id)!.nextRunAt!)).toBeGreaterThan(Date.now());
  });
});
