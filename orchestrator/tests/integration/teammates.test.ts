// Coworkers asking teammates: the chain of delegated tasks below Mochi's, its
// limits (no loops, no self, three levels, a coworker's caps), questions
// answered by whoever asked, and cancellation running down the chain.

import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Task } from "@coucou-orchestrator/protocol";
import { ModelError, type ModelAdapter, type ModelInput, type ModelOutput } from "../../server/src/model/adapter.ts";
import { cleanup, key, startBackend, tempDir, waitFor, type Running } from "./harness.ts";

type Answer = Record<string, unknown> | ((input: ModelInput) => unknown | Promise<unknown>);

/** Answers in order, per agent (read from the system prompt's "You are <id>,"). */
class PerAgentModel implements ModelAdapter {
  private readonly scripts: Record<string, Answer[]>;

  constructor(scripts: Record<string, Answer[]>) {
    this.scripts = Object.fromEntries(Object.entries(scripts).map(([id, answers]) => [id, [...answers]]));
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const agentId = /^You are ([a-z0-9-]+),/.exec(input.system)?.[1] ?? "";
    const answer = this.scripts[agentId]?.shift();
    if (!answer) throw new ModelError("unavailable", `script exhausted for ${agentId}`);
    const value = typeof answer === "function" ? await answer(input) : answer;
    return { text: JSON.stringify(value), json: value };
  }
}

const action = (op: string, args: Record<string, unknown>) => ({ kind: "action", note: op, op, args });
const done = (summary: string) => ({ kind: "done", summary });
const ask = (agentId: string, message: string) => action("agent.delegate", { assignments: [{ agentId, message }] });

let running: Running[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const item of running) await item.backend.close().catch(() => {});
  await cleanup(...dirs);
  running = [];
  dirs = [];
});

async function setup(model: ModelAdapter, names: string[]) {
  const dataDir = await tempDir("orch-teammates-");
  dirs.push(dataDir);
  const r = await startBackend(dataDir, model, undefined, {}, { agents: ["agent-01", "agent-02"], maxParallel: 3 });
  running.push(r);
  for (const name of names) {
    const response = await r.api<{ agent: Agent }>("/api/agents", { body: { name, role: `${name} role`, computerId: "agent-02" } });
    expect(response.status).toBe(201);
  }
  return r;
}

/** The user's message to Mochi. */
async function submit(r: Running, prompt: string): Promise<Task> {
  const response = await r.api<{ task: Task }>("/api/tasks", { body: { prompt, agentId: "agent-01", idempotencyKey: key() } });
  expect(response.status).toBe(201);
  return response.body.task;
}

const finalTask = (r: Running, id: string) =>
  waitFor(() => {
    const task = r.backend.store.task(id);
    return task && ["succeeded", "failed", "cancelled"].includes(task.status) ? task : null;
  }, 10_000, `task ${id} to finish`);

describe("teammates asking teammates", () => {
  it("lets a coworker ask a teammate, whose report goes to the coworker, then to Mochi", async () => {
    let qaSystem = "";
    const model = new PerAgentModel({
      "agent-01": [
        ask("qa", "Review PR #4."),
        (input) => {
          expect(input.prompt).toContain("QA done, Sim says the recorder is off");
          return done("Reviewed.");
        },
      ],
      qa: [
        (input) => {
          qaSystem = input.system;
          expect(JSON.stringify(input.jsonSchema)).toContain("agent.delegate");
          expect(JSON.stringify(input.jsonSchema)).not.toContain("team.propose");
          return ask("sim", "Is the recorder off the prod host?");
        },
        (input) => {
          expect(input.prompt).toContain("Recorder is off.");
          return done("QA done, Sim says the recorder is off");
        },
      ],
      sim: [
        (input) => {
          expect(input.system).toContain("handed to you by QA (qa)");
          // Nobody left to ask: QA and Mochi are on it, and there is no other coworker.
          expect(input.system).not.toContain("<teammates>");
          return done("Recorder is off.");
        },
      ],
    });
    const r = await setup(model, ["QA", "Sim"]);

    const chief = await submit(r, "Get PR #4 reviewed");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    expect(qaSystem).toContain("<teammates>");
    expect(qaSystem).toContain("id=sim");
    expect(qaSystem).not.toMatch(/id=qa;|id=agent-01;/);
    const qaTask = r.backend.store.childTasks(chief.id)[0]!;
    const simTask = r.backend.store.childTasks(qaTask.id)[0]!;
    expect(simTask).toEqual(expect.objectContaining({ agentId: "sim", source: "delegated", parentTaskId: qaTask.id }));
    const delegated = r.backend.events.after(0).filter((event) => event.type === "agent.delegated");
    expect(delegated.map((event) => [event.agentId, event.taskId])).toEqual([
      ["agent-01", chief.id],
      ["qa", qaTask.id],
    ]);
  });

  it("refuses asking yourself, Mochi or anyone already on the request, and caps a coworker's requests", async () => {
    const model = new PerAgentModel({
      "agent-01": [ask("qa", "Check it."), done("Checked.")],
      qa: [
        ask("qa", "Me again."),
        (input) => {
          expect(input.prompt).toContain("you cannot delegate to yourself");
          return ask("agent-01", "Boss?");
        },
        (input) => {
          expect(input.prompt).toContain("agent-01 is not a live coworker");
          return action("agent.delegate", {
            assignments: Array.from({ length: 4 }, (_, index) => ({ agentId: "sim", message: `Ask ${index}` })),
          });
        },
        (input) => {
          expect(input.prompt).toContain("a coworker task may delegate at most 3 assignments");
          return ask("sim", "One question.");
        },
        done("QA finished."),
      ],
      sim: [
        ask("qa", "Back to you."),
        (input) => {
          expect(input.prompt).toContain("qa is already working on this request");
          return done("Sim answered.");
        },
      ],
    });
    const r = await setup(model, ["QA", "Sim"]);

    const chief = await submit(r, "Check it");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    const qaTask = r.backend.store.childTasks(chief.id)[0]!;
    const simTasks = r.backend.store.childTasks(qaTask.id);
    expect(simTasks).toHaveLength(1);
    expect(r.backend.store.childTasks(simTasks[0]!.id)).toEqual([]);
  });

  it("stops handing work down three levels below the user's message", async () => {
    const model = new PerAgentModel({
      "agent-01": [ask("a", "1"), done("ok")],
      a: [ask("b", "2"), done("a ok")],
      b: [ask("c", "3"), done("b ok")],
      c: [
        (input) => {
          expect(input.system).not.toContain("<teammates>");
          return ask("d", "4");
        },
        (input) => {
          expect(input.prompt).toContain("handed down as far as it may go");
          return done("c ok");
        },
      ],
    });
    const r = await setup(model, ["A", "B", "C", "D"]);

    const chief = await submit(r, "Go deep");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    const a = r.backend.store.childTasks(chief.id)[0]!;
    const b = r.backend.store.childTasks(a.id)[0]!;
    const c = r.backend.store.childTasks(b.id)[0]!;
    expect(c.agentId).toBe("c");
    expect(r.backend.store.childTasks(c.id)).toEqual([]);
  });

  it("sends a teammate's question to the coworker who asked, whose answer resumes it", async () => {
    let simTaskId = "";
    const model = new PerAgentModel({
      "agent-01": [
        ask("qa", "Review."),
        (input) => {
          expect(input.prompt).not.toContain("Which host?");
          return done("Reviewed.");
        },
      ],
      qa: [
        ask("sim", "Check the host."),
        (input) => {
          expect(input.prompt).toContain("Which host?");
          simTaskId = /coworker_report taskId="([^"]+)"/.exec(input.prompt)![1]!;
          return action("agent.answer", { taskId: simTaskId, answer: "The Oracle production host." });
        },
        () => action("agent.wait", { taskIds: [simTaskId] }),
        (input) => {
          expect(input.prompt).toContain("Host checked.");
          return done("QA done.");
        },
      ],
      sim: [
        { kind: "ask", question: "Which host?" },
        (input) => {
          expect(input.prompt).toContain("The Oracle production host.");
          return done("Host checked.");
        },
      ],
    });
    const r = await setup(model, ["QA", "Sim"]);

    const chief = await submit(r, "Review");
    expect((await finalTask(r, chief.id)).status).toBe("succeeded");
    expect(r.backend.store.taskAnswers(simTaskId)).toEqual([
      expect.objectContaining({ answer: "The Oracle production host." }),
    ]);
  });

  it("cancels the whole chain below a cancelled task", async () => {
    const model = new PerAgentModel({
      // Each one passes the question up and waits.
      "agent-01": [ask("qa", "Go."), { kind: "ask", question: "Hold?" }],
      qa: [ask("sim", "Go on."), { kind: "ask", question: "Should Sim hold?" }],
      sim: [{ kind: "ask", question: "Hold on?" }],
    });
    const r = await setup(model, ["QA", "Sim"]);

    const chief = await submit(r, "Start a chain");
    const sim = await waitFor(() => {
      const qa = r.backend.store.childTasks(chief.id)[0];
      const child = qa && r.backend.store.childTasks(qa.id)[0];
      return child && r.backend.store.task(child.id)?.status === "waiting_for_answer" ? child : null;
    }, 5_000, "the teammate's question");
    await r.api(`/api/tasks/${chief.id}/cancel`, { method: "POST" });
    expect((await finalTask(r, chief.id)).status).toBe("cancelled");
    expect((await finalTask(r, sim.id)).status).toBe("cancelled");
  });
});
