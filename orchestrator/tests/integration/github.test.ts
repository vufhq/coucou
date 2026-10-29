// GitHub through the user's account, end to end with a real git: a local bare
// repo stands in for github.com. A canary token is planted in the sign-in and
// must never show up in the database, the events, the model's prompts or the
// computer's files; a repo whose .git/config tries to run code or redirect the
// push gets neither.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@coucou-orchestrator/protocol";
import { Github, gitBasicAuth, memorySlot } from "../../server/src/github.ts";
import { ScriptedModel, type ScriptedAnswer } from "../../server/src/model/scripted.ts";
import { FakeBrowser, cleanup, key, readEvents, startBackend, startWorker, tempDir, waitFor, type Running } from "./harness.ts";

const CANARY = "ghu_canaryTOKEN0123456789abcdefABCDEF";
const REPO = "octo/demo";

let stops: (() => Promise<void>)[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const stop of stops) await stop().catch(() => {});
  await cleanup(...dirs);
  stops = [];
  dirs = [];
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

/** A bare "GitHub" repo with one commit on main. */
async function remote(root: string): Promise<string> {
  const seed = join(root, "seed");
  const bare = join(root, "remote.git");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  execFileSync("git", ["-C", seed, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first"]);
  git(root, "clone", "-q", "--bare", seed, bare);
  return bare;
}

async function setup(answers: ScriptedAnswer[], level: 1 | 2 | 3 | 4) {
  const root = await tempDir("orch-github-");
  dirs.push(root);
  const bare = await remote(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const github = new Github({
    clientId: "Iv23test",
    slot: memorySlot(JSON.stringify({ access: CANARY, accessExpiresAt: null, refresh: null, refreshExpiresAt: null, login: "octo" })),
  });
  const model = new ScriptedModel(answers);
  const r = await startBackend(join(root, "data"), model, undefined, {}, { github });
  const { worker, done } = startWorker(workspace, r.workerPort, new FakeBrowser(), "agent-01", undefined, {
    git: { remoteUrl: () => pathToFileURL(bare).href, protocols: ["file"] },
  });
  stops.push(async () => {
    worker.stop();
    await done;
    await r.backend.close();
  });
  await r.api("/api/agents/agent-01/rules", { method: "PUT", body: { level, github: true } });
  return { r, root, bare, workspace, model };
}

const act = (op: string, args: Record<string, unknown>, note = op) => ({ kind: "action", note, op, args });

/** Approves each approval the task asks for, in order, and returns their ops. */
async function approveAll(r: Running, taskId: string): Promise<string[]> {
  const approved: string[] = [];
  const seen = new Set<string>();
  const events = await readEvents(r.apiPort, {
    taskId,
    timeoutMs: 20_000,
    until: (e) => {
      if (e.type === "approval.requested" && !seen.has(String(e.payload.approvalId))) {
        seen.add(String(e.payload.approvalId));
        approved.push(String(e.payload.op));
        void r.api("/api/agents/agent-01/approval", { body: { approvalId: e.payload.approvalId, decision: "approve" } });
      }
      return e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled";
    },
  });
  expect(events.at(-1)?.type).toBe("task.completed");
  return approved;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

async function expectNoCanary(r: Running, root: string, model: ScriptedModel, taskId: string): Promise<void> {
  const forms = [CANARY, gitBasicAuth(CANARY)];
  // The database (events, jobs, steps), the journal and the task folders are all files under root.
  const events = await readEvents(r.apiPort, { taskId, until: (e) => e.type === "task.completed" });
  const seen = [JSON.stringify(model.calls), JSON.stringify(events), JSON.stringify((await r.api(`/api/tasks/${taskId}`)).body)];
  for (const file of await filesUnder(root)) {
    if ((await stat(file)).size > 20_000_000) continue;
    seen.push((await readFile(file)).toString("latin1"));
  }
  for (const text of seen) for (const form of forms) expect(text.includes(form)).toBe(false);
}

describe("GitHub through the user's account", () => {
  it("clones, asks before a push at level 2, pushes the branch, and never leaks the token", async () => {
    let taskDir = "";
    const marker = () => join(taskDir, "PWNED");
    const { r, root, bare, model } = await setup(
      [
        (input) => {
          expect(input.system).toContain("git.push");
          return act("git.clone", { repo: REPO, dir: "demo" });
        },
        (input) => {
          expect(input.prompt).toContain('"defaultBranch":"main"');
          const clone = join(taskDir, "demo");
          git(clone, "switch", "-q", "-c", "feature");
          execFileSync("git", ["-C", clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "change"]);
          // What the runner could plant: code to run, and a push redirected elsewhere.
          const cmd = `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker())}`;
          git(clone, "config", "core.fsmonitor", cmd);
          git(clone, "config", "core.hooksPath", ".githooks");
          git(clone, "config", `url.${pathToFileURL(join(root, "elsewhere.git")).href}.insteadOf`, pathToFileURL(bare).href);
          return act("git.push", { repo: REPO, dir: "demo", branch: "feature" });
        },
        { kind: "done", summary: "Pushed feature." },
      ],
      2,
    );
    const created = await r.api<{ task: Task }>("/api/tasks", { body: { prompt: "Change the demo repo", idempotencyKey: key() } });
    const taskId = created.body.task.id;
    taskDir = join(root, "workspace", "tasks", taskId);

    expect(await approveAll(r, taskId)).toEqual(["git.clone", "git.push"]);
    expect(git(bare, "rev-parse", "--verify", "refs/heads/feature")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(join(root, "elsewhere.git"))).toBe(false);
    // The copy in the task folder points at github.com, with no token in its config.
    expect(git(join(taskDir, "demo"), "remote", "get-url", "origin")).toBe(`https://github.com/${REPO}.git`);
    await expectNoCanary(r, root, model, taskId);
  });

  it("pushes a branch without asking at level 3, but a push to main still asks", async () => {
    let taskDir = "";
    const commit = (branch: string | null) => {
      const clone = join(taskDir, "demo");
      if (branch) git(clone, "switch", "-q", "-c", branch);
      execFileSync("git", ["-C", clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "c"]);
    };
    const { r, root, bare } = await setup(
      [
        act("git.clone", { repo: REPO, dir: "demo" }),
        () => {
          commit("feature");
          return act("git.push", { repo: REPO, dir: "demo", branch: "feature" });
        },
        () => {
          git(join(taskDir, "demo"), "switch", "-q", "main");
          commit(null);
          return act("git.push", { repo: REPO, dir: "demo", branch: "main" });
        },
        { kind: "done", summary: "Done." },
      ],
      3,
    );
    const created = await r.api<{ task: Task }>("/api/tasks", { body: { prompt: "Push twice", idempotencyKey: key() } });
    taskDir = join(root, "workspace", "tasks", created.body.task.id);
    expect(await approveAll(r, created.body.task.id)).toEqual(["git.push"]);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(git(join(taskDir, "demo"), "rev-parse", "main"));
  });

  it("refuses GitHub to an agent the user hasn't switched on, and the model can't switch it on", async () => {
    const { r } = await setup(
      [
        act("git.clone", { repo: REPO, dir: "demo" }),
        (input) => {
          expect(input.prompt).toContain("may not use the user's GitHub account");
          return { kind: "done", summary: "Blocked." };
        },
      ],
      4,
    );
    await r.api("/api/agents/agent-01/rules", { method: "PUT", body: { github: false } });
    // Only this route changes it, and it needs something to change.
    expect((await r.api("/api/agents/agent-01/rules", { method: "PUT", body: {} })).status).toBe(400);
    const created = await r.api<{ task: Task }>("/api/tasks", { body: { prompt: "Clone it", idempotencyKey: key() } });
    await waitFor(async () => {
      const task = (await r.api<{ task: Task }>(`/api/tasks/${created.body.task.id}`)).body.task;
      return task.status === "succeeded" ? task : null;
    }, 10_000, "the task to finish");
    const agent = (await r.api("/api/agents")).body.agents[0];
    expect(agent).toMatchObject({ githubAllowed: false, ruleLevel: 4 });
  });
});
