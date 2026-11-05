import { afterEach, describe, expect, it } from "vitest";
import type { Agent, Task } from "@coucou-orchestrator/protocol";
import { ScriptedModel } from "../../server/src/model/scripted.ts";
import { cleanup, key, startBackend, tempDir, waitFor, type Running } from "./harness.ts";

let running: Running[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const r of running) await r.backend.close().catch(() => {});
  await cleanup(...dirs);
  running = [];
  dirs = [];
});

async function setup(answers: ConstructorParameters<typeof ScriptedModel>[0]) {
  const dir = await tempDir("orch-rules-");
  dirs.push(dir);
  const r = await startBackend(dir, new ScriptedModel(answers));
  running.push(r);
  return r;
}

describe("rule levels", () => {
  it("start at 2, and only the user's call changes them", async () => {
    const r = await setup([]);
    const agents = await r.api<{ agents: Agent[] }>("/api/agents");
    expect(agents.body.agents[0]!.ruleLevel).toBe(2);
    for (const level of [0, 5, 2.5, "3"]) {
      const bad = await r.api("/api/agents/agent-01/rules", { method: "PUT", body: { level } });
      expect(bad.status).toBe(400);
    }
    expect((await r.api("/api/agents/nobody/rules", { method: "PUT", body: { level: 3 } })).status).toBe(404);
    const changed = await r.api<{ agent: Agent }>("/api/agents/agent-01/rules", { method: "PUT", body: { level: 3 } });
    expect(changed.status).toBe(200);
    expect(changed.body.agent.ruleLevel).toBe(3);
  });

  it("tells the agent its level, and at level 1 a shell command waits for approval", async () => {
    const r = await setup([
      (input) => {
        expect(input.system).toContain("Your rule level is 1 of 4");
        expect(input.system).toContain("Only the user sets rule levels");
        return { kind: "action", note: "List", op: "terminal.shell", args: { command: "ls" } };
      },
    ]);
    await r.api("/api/agents/agent-01/rules", { method: "PUT", body: { level: 1 } });
    const created = await r.api<{ task: Task }>("/api/tasks", { body: { prompt: "List the folder", idempotencyKey: key() } });
    await waitFor(async () => {
      const task = (await r.api<{ task: Task }>(`/api/tasks/${created.body.task.id}`)).body.task;
      return task.status === "waiting_for_approval" ? task : null;
    }, 5_000, "the shell step to wait for approval");
  });
});
