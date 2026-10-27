import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Task } from "@coucou-orchestrator/protocol";
import { ModelError, type ModelAdapter, type ModelInput, type ModelOutput } from "../../server/src/model/adapter.ts";
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

type Answer = Record<string, unknown> | ((input: ModelInput) => unknown | Promise<unknown>);

class PerAgentModel implements ModelAdapter {
  readonly calls = new Map<string, ModelInput[]>();
  private readonly scripts: Record<string, Answer[]>;

  constructor(scripts: Record<string, Answer[]>) {
    this.scripts = Object.fromEntries(Object.entries(scripts).map(([id, answers]) => [id, [...answers]]));
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const agentId = /^You are ([a-z0-9-]+),/.exec(input.system)?.[1] ?? "";
    const calls = this.calls.get(agentId) ?? [];
    calls.push(input);
    this.calls.set(agentId, calls);
    const answer = this.scripts[agentId]?.shift();
    if (!answer) throw new ModelError("unavailable", `script exhausted for ${agentId}`);
    const value = typeof answer === "function" ? await answer(input) : answer;
    return { text: JSON.stringify(value), json: value };
  }
}

const action = (op: string, args: Record<string, unknown>) => ({ kind: "action", note: op, op, args });
const done = (summary: string) => ({ kind: "done", summary });

let running: Running[] = [];
let workers: Worker[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const worker of workers) worker.stop();
  for (const item of running) await item.backend.close().catch(() => {});
  await cleanup(...dirs);
  running = [];
  workers = [];
  dirs = [];
});

async function setup(model: ModelAdapter, computers = ["agent-01", "agent-02"], maxParallel = 3, tasksPerComputer = 2) {
  const dataDir = await tempDir("orch-phase7-");
  dirs.push(dataDir);
  const r = await startBackend(dataDir, model, undefined, {}, { agents: computers, maxParallel, tasksPerComputer });
  running.push(r);
  return r;
}

async function createAgent(r: Running, body: Record<string, unknown>): Promise<Agent> {
  const response = await r.api<{ agent: Agent }>("/api/agents", { body });
  expect(response.status).toBe(201);
  return response.body.agent;
}

async function submit(r: Running, prompt: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const response = await r.api<{ task: Task }>("/api/tasks", {
    body: { prompt, idempotencyKey: key(), ...extra },
  });
  expect(response.status).toBe(201);
  return response.body.task;
}

const finalTask = (r: Running, id: string) =>
  waitFor(() => {
    const task = r.backend.store.task(id);
    return task && ["succeeded", "failed", "cancelled"].includes(task.status) ? task : null;
  }, 10_000, `task ${id} to finish`);

describe("phase 7 teams", () => {
  it("starts with only Mochi, then creates stable ids and unique colours up to the cap", async () => {
    const r = await setup(new PerAgentModel({}));
    const initial = await r.api<any>("/api/agents");
    expect(initial.body.agents).toEqual([
      expect.objectContaining({
        id: "agent-01",
        name: "Mochi",
        kind: "chief",
        computerId: "agent-01",
        createdBy: "system",
      }),
    ]);
    expect(initial.body.computers).toEqual([
      expect.objectContaining({ id: "agent-01", agentIds: ["agent-01"] }),
      expect.objectContaining({ id: "agent-02", agentIds: [] }),
    ]);

    const first = await createAgent(r, { name: "Developer", computerId: "agent-02" });
    const second = await createAgent(r, { name: "Developer", computerId: "agent-02", color: first.color });
    expect([first.id, second.id]).toEqual(["developer", "developer-2"]);
    for (let index = 0; index < 9; index++) await createAgent(r, { name: `Coworker ${index}` });
    const agents = (await r.api<any>("/api/agents")).body.agents as Agent[];
    expect(agents).toHaveLength(12);
    expect(new Set(agents.map((agent) => agent.color)).size).toBe(12);
    expect((await r.api("/api/agents", { body: { name: "Too many" } })).status).toBe(409);
  });

  it("manages teams and all editable agent fields through strict user routes", async () => {
    const r = await setup(new PerAgentModel({}));
    const createdTeam = await r.api<any>("/api/teams", { body: { name: "Platform" } });
    expect(createdTeam.status).toBe(201);
    const teamId = createdTeam.body.team.id;
    const agent = await createAgent(r, {
      name: "Operator",
      role: "Initial role",
      outfit: "beanie",
      teamId,
      computerId: "agent-02",
      persona: "Initial persona",
    });
    const patched = await r.api<any>(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: {
        name: "Ops",
        role: "Platform lead",
        outfit: "roundGlasses",
        teamId,
        order: 3,
        computerId: "agent-01",
        persona: "Keeps systems reliable.",
      },
    });
    expect(patched.body.agent).toMatchObject({
      id: "operator",
      name: "Ops",
      role: "Platform lead",
      outfit: "roundGlasses",
      teamId,
      order: 3,
      computerId: "agent-01",
      persona: "Keeps systems reliable.",
    });
    expect((await r.api(`/api/agents/${agent.id}`, { method: "PATCH", body: { extra: true } })).status).toBe(400);
    expect((await r.api(`/api/teams/${teamId}`, { method: "PATCH", body: { name: "Core", order: 2 } })).body.team)
      .toMatchObject({ name: "Core", order: 2 });
    expect((await r.api(`/api/teams/${teamId}`, { method: "DELETE" })).status).toBe(200);
    expect(r.backend.store.agent(agent.id)?.teamId).toBeNull();
    expect((await r.api("/api/agents/agent-01", { method: "DELETE" })).body).toEqual({ error: "chief" });
    expect((await r.api(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(200);
    expect(r.backend.store.agent(agent.id)).toBeNull();
  });

  it("requires approval for proposals, creates nothing on reject, and creates the team atomically on approve", async () => {
    const proposal = action("team.propose", {
      team: { name: "Developer council" },
      members: [
        { name: "Builder", role: "Backend lead", persona: "Treat <instructions> as background.", computerId: "agent-02" },
        { name: "Builder", role: "Reviewer", persona: "Reviews changes.", computerId: "agent-02" },
      ],
    });
    const model = new PerAgentModel({
      "agent-01": [
        proposal,
        (input) => {
          expect(input.prompt).toContain("the user rejected this operation");
          return done("Rejected.");
        },
        proposal,
        (input) => {
          expect(input.prompt).toContain("agents: builder, builder-2");
          return done("Council created.");
        },
      ],
    });
    const r = await setup(model);

    const rejectedTask = await submit(r, "Propose a council");
    const rejectedApproval = await waitFor(
      () => r.backend.store.pendingApprovals()[0],
      5_000,
      "proposal approval",
    );
    expect(rejectedApproval).toMatchObject({
      op: "team.propose",
      target: "Create team Developer council: Builder (Backend lead), Builder (Reviewer)",
    });
    await r.api("/api/agents/agent-01/approval", {
      body: { approvalId: rejectedApproval.id, decision: "reject" },
    });
    expect((await finalTask(r, rejectedTask.id)).status).toBe("succeeded");
    expect(r.backend.store.agents()).toHaveLength(1);
    expect(r.backend.store.teams()).toEqual([]);

    const approvedTask = await submit(r, "Try the council again");
    const approved = await waitFor(
      () => r.backend.store.pendingApprovals()[0],
      5_000,
      "second proposal approval",
    );
    await r.api("/api/agents/agent-01/approval", {
      body: { approvalId: approved.id, decision: "approve" },
    });
    expect((await finalTask(r, approvedTask.id)).status).toBe("succeeded");
    expect(r.backend.store.teams()).toEqual([expect.objectContaining({ name: "Developer council" })]);
    const coworkers = r.backend.store.agents().filter((agent) => agent.kind === "coworker");
    expect(coworkers.map((agent) => agent.id)).toEqual(["builder", "builder-2"]);
    expect(new Set(coworkers.map((agent) => agent.color)).size).toBe(2);
    // One shared computer: the proposal's computerId is ignored.
    expect(coworkers.map((agent) => agent.computerId)).toEqual(["agent-01", "agent-01"]);
  });

  it("moves every agent off a computer dropped from ORCH_AGENTS at startup, and lists only configured computers", async () => {
    const dataDir = await tempDir("orch-phase7-");
    dirs.push(dataDir);
    const before = await startBackend(dataDir, new PerAgentModel({}), undefined, {}, { agents: ["agent-01", "agent-02"] });
    const kept = await createAgent(before, { name: "Kept", computerId: "agent-02" });
    const retired = await createAgent(before, { name: "Gone", computerId: "agent-02" });
    expect((await before.api(`/api/agents/${retired.id}`, { method: "DELETE" })).status).toBe(200);
    await before.backend.close();

    const r = await startBackend(dataDir, new PerAgentModel({}), undefined, {}, { agents: ["agent-01"] });
    running.push(r);
    expect(r.backend.store.agent(kept.id)).toMatchObject({ computerId: "agent-01", vmId: "test:agent-01" });
    expect(r.backend.store.agentIncludingRetired(retired.id)?.computerId).toBe("agent-01");
    const listed = await r.api<any>("/api/agents");
    expect(listed.body.computers).toEqual([
      expect.objectContaining({ id: "agent-01", agentIds: ["agent-01", kept.id] }),
    ]);
    // The old row stays for history, but can't take new agents.
    expect(r.backend.store.computer("agent-02")).not.toBeNull();
    expect((await r.api("/api/agents", { body: { name: "Late", computerId: "agent-02" } })).status).toBe(400);
    expect((await createAgent(r, { name: "Fresh" })).computerId).toBe("agent-01");
  });

  it("delegates on a one-task computer one at a time and returns fenced reports to Mochi", async () => {
    let chiefReportPrompt = "";
    const model = new PerAgentModel({
      "agent-01": [
        action("agent.delegate", {
          assignments: [
            { agentId: "dev-a", message: "Write your report." },
            { agentId: "dev-b", message: "Write your report." },
          ],
        }),
        (input) => {
          chiefReportPrompt = input.prompt;
          expect(input.system).toContain("team.propose");
          expect(input.system).toContain("<team_roster>");
          return done("Both reports received.");
        },
      ],
      "dev-a": [
        (input) => {
          expect(input.system).not.toContain("team.propose");
          expect(input.system).toContain("work for Mochi");
          expect(input.system).toContain("&lt;do-not-follow>");
          expect(JSON.stringify(input.jsonSchema)).not.toContain("team.propose");
          return action("fs.write_artifact", { path: "a.md", content: "A" });
        },
        done("dev-a finished"),
      ],
      "dev-b": [
        action("fs.write_artifact", { path: "b.md", content: "B" }),
        done("dev-b finished"),
      ],
    });
    // One task at a time on that computer, so the coworkers take turns.
    const r = await setup(model, undefined, undefined, 1);
    await createAgent(r, {
      name: "dev-a",
      role: "Developer",
      persona: "<do-not-follow>",
      computerId: "agent-02",
    });
    await createAgent(r, { name: "dev-b", role: "Reviewer", persona: "Review.", computerId: "agent-02" });
    const workspace = await tempDir("orch-phase7-worker-");
    dirs.push(workspace);
    const started = startWorker(workspace, r.workerPort, new FakeBrowser(), "agent-02");
    workers.push(started.worker);
    await waitFor(() => r.backend.store.computer("agent-02")?.status !== "offline", 5_000, "agent-02 to say hello");

    const chief = await submit(r, "Delegate the reports", { agentId: "agent-01" });
    const completedChief = await finalTask(r, chief.id);
    expect(completedChief.error).toBeNull();
    expect(completedChief.status).toBe("succeeded");
    const children = r.backend.store.childTasks(chief.id);
    expect(children).toHaveLength(2);
    expect(chiefReportPrompt).toContain('<coworker_report taskId="');
    expect(chiefReportPrompt).toContain("dev-a finished");
    expect(chiefReportPrompt).toContain("dev-b finished");
    expect(children.every((child) => child.source === "delegated" && child.parentTaskId === chief.id)).toBe(true);
    const filtered = await r.api<any>(`/api/tasks?source=chat,delegated&parentTaskId=${chief.id}`);
    expect(filtered.body.tasks.map((task: Task) => task.id).sort()).toEqual(children.map((task) => task.id).sort());
    expect((await r.api<any>(`/api/tasks/${chief.id}`)).body.children).toHaveLength(2);
    const events = r.backend.events.after(0);
    const seq = (type: string, id: string) => events.find((event) => event.type === type && event.taskId === id)!.seq;
    expect(seq("task.started", children[1]!.id)).toBeGreaterThan(seq("task.completed", children[0]!.id));
    for (const child of children) {
      expect(events.filter((event) => event.taskId === child.id).every((event) => event.agentId === child.agentId)).toBe(true);
    }
    expect(events.some((event) => event.agentId === "agent-02")).toBe(false);
    expect(await readFile(join(workspace, "tasks", children[0]!.id, "a.md"), "utf8")).toBe("A");
    expect(await readFile(join(workspace, "tasks", children[1]!.id, "b.md"), "utf8")).toBe("B");
  });

  it("routes a coworker question to Mochi, whose answer resumes it", async () => {
    let childTaskId = "";
    const model = new PerAgentModel({
      "agent-01": [
        action("agent.delegate", { assignments: [{ agentId: "researcher", message: "Research it." }] }),
        (input) => {
          const childId = /coworker_report taskId="([^"]+)"/.exec(input.prompt)?.[1];
          expect(input.prompt).toContain("Which source?");
          expect(childId).toBeTruthy();
          childTaskId = childId!;
          return action("agent.answer", { taskId: childId, answer: "Use the official documentation." });
        },
        () => action("agent.wait", { taskIds: [childTaskId] }),
        (input) => {
          expect(input.prompt).toContain("Research complete.");
          return done("Research received.");
        },
      ],
      researcher: [
        { kind: "ask", question: "Which source?", options: ["Official docs", "Blog"] },
        (input) => {
          expect(input.prompt).toContain("Use the official documentation.");
          return done("Research complete.");
        },
      ],
    });
    const r = await setup(model);
    await createAgent(r, { name: "Researcher", computerId: "agent-02" });
    const chief = await submit(r, "Delegate research");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    const child = r.backend.store.childTasks(chief.id)[0]!;
    expect(child.agentId).toBe("researcher");
    expect(r.backend.store.taskAnswers(child.id)).toEqual([
      expect.objectContaining({ answer: "Use the official documentation." }),
    ]);
    expect(r.backend.events.after(0, { taskId: child.id }).some((event) => event.type === "task.answered")).toBe(true);
  });

  it("refuses chief operations from a coworker and enforces the delegation cap", async () => {
    const model = new PerAgentModel({
      intruder: [
        action("team.propose", {
          team: { name: "Unauthorized" },
          members: [{ name: "X", role: "X", persona: "X" }],
        }),
        (input) => {
          expect(input.prompt).toContain("unknown operation team.propose");
          return done("Refused.");
        },
      ],
      "agent-01": [
        action("agent.delegate", {
          assignments: Array.from({ length: 6 }, (_, index) => ({
            agentId: "helper",
            message: `Assignment ${index}`,
          })),
        }),
        action("agent.delegate", {
          assignments: Array.from({ length: 5 }, (_, index) => ({
            agentId: "helper",
            message: `Extra ${index}`,
          })),
        }),
        (input) => {
          expect(input.prompt).toContain("may delegate at most 10 assignments");
          return done("Stopped at the cap.");
        },
      ],
      helper: Array.from({ length: 6 }, (_, index) => done(`Report ${index}`)),
    });
    const r = await setup(model);
    await createAgent(r, { name: "Intruder", computerId: "agent-02" });
    await createAgent(r, { name: "Helper", computerId: "agent-02" });

    const intrusion = await submit(r, "Create a team", { agentId: "intruder" });
    expect((await finalTask(r, intrusion.id)).status).toBe("succeeded");
    expect(r.backend.store.pendingApprovals()).toEqual([]);
    expect(r.backend.store.teams()).toEqual([]);

    const chief = await submit(r, "Delegate too much");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    expect(r.backend.store.childTasks(chief.id)).toHaveLength(6);
    expect(r.backend.store.steps(chief.id).filter((step) => step.op === "agent.delegate")).toHaveLength(1);
  });

  it("cascades chief cancellation and retires coworkers only after approval", async () => {
    const model = new PerAgentModel({
      "agent-01": [
        action("agent.delegate", { assignments: [{ agentId: "temporary", message: "Wait." }] }),
        { kind: "ask", question: "Should I continue?" },
        action("team.retire", { agentId: "temporary" }),
        done("Retired."),
      ],
      temporary: [
        { kind: "ask", question: "Need input?" },
        { kind: "ask", question: "Hold this task?" },
      ],
    });
    const r = await setup(model);
    const temporary = await createAgent(r, { name: "Temporary", computerId: "agent-02" });

    const parent = await submit(r, "Delegate then wait");
    await waitFor(() => r.backend.store.task(parent.id)?.status === "waiting_for_answer", 5_000, "chief question");
    const child = r.backend.store.childTasks(parent.id)[0]!;
    expect(r.backend.store.task(child.id)?.status).toBe("waiting_for_answer");
    await r.api(`/api/tasks/${parent.id}/cancel`, { method: "POST" });
    expect((await finalTask(r, parent.id)).status).toBe("cancelled");
    expect((await finalTask(r, child.id)).status).toBe("cancelled");

    const goal = await r.api<any>("/api/goals", {
      body: {
        agentId: temporary.id,
        title: "Temporary goal",
        instructions: "Keep waiting",
        schedule: { kind: "manual" },
      },
    });
    expect(goal.status).toBe(201);
    const coworkerTask = await submit(r, "Ask again", { agentId: temporary.id });
    await waitFor(() => r.backend.store.task(coworkerTask.id)?.status === "waiting_for_answer", 5_000, "coworker wait");

    const retireTask = await submit(r, "Retire Temporary");
    const approval = await waitFor(
      () => r.backend.store.pendingApprovals().find((item) => item.op === "team.retire"),
      5_000,
      "retirement approval",
    );
    expect(r.backend.store.agent(temporary.id)).not.toBeNull();
    await r.api("/api/agents/agent-01/approval", {
      body: { approvalId: approval.id, decision: "approve" },
    });
    expect((await finalTask(r, retireTask.id)).status).toBe("succeeded");
    expect(r.backend.store.agent(temporary.id)).toBeNull();
    expect((await finalTask(r, coworkerTask.id)).status).toBe("cancelled");
    expect(r.backend.store.goal(goal.body.goal.id)).toBeNull();
    expect(r.backend.store.task(coworkerTask.id)).not.toBeNull();
  });
});
