// Files and GitHub links sent with a message: uploaded to the backend, copied
// into the task folder by the backend's own first steps, shown to the model,
// and never something the model can ask for itself.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@coucou-orchestrator/protocol";
import { ScriptedModel } from "../../server/src/model/scripted.ts";
import { safeFileName } from "../../server/src/attachments.ts";
import type { Worker } from "../../worker/src/worker.ts";
import {
  API_TOKEN,
  FakeBrowser,
  PNG_BYTES,
  WORKER_TOKEN,
  cleanup,
  ended,
  key,
  readEvents,
  startBackend,
  startWorker,
  tempDir,
  type Running,
} from "./harness.ts";

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

async function setup(script: ConstructorParameters<typeof ScriptedModel>[0], withWorker = true) {
  const dataDir = await tempDir("orch-att-");
  const workspace = await tempDir("orch-att-ws-");
  dirs.push(dataDir, workspace);
  const model = new ScriptedModel(script);
  const r = await startBackend(dataDir, model);
  running.push(r);
  if (withWorker) workers.push(startWorker(workspace, r.workerPort, new FakeBrowser()).worker);
  return { r, model, workspace, dataDir };
}

async function upload(r: Running, name: string, bytes: Buffer) {
  const res = await fetch(`http://127.0.0.1:${r.apiPort}/api/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  return { status: res.status, body: (await res.json()) as { attachment: { id: string; name: string; bytes: number } } };
}

const taskEnd = (r: Running, taskId: string) => readEvents(r.apiPort, { taskId, until: ended, timeoutMs: 15_000 });

describe("attachments", () => {
  it("copies an attached file into the task folder before the model's first step, and tells the model", async () => {
    const { r, model, workspace, dataDir } = await setup([done("read it")]);
    const sent = await upload(r, "Rapport été (final).pdf", PNG_BYTES);
    expect(sent.status).toBe(201);
    expect(sent.body.attachment).toMatchObject({ name: "Rapport été (final).pdf", bytes: PNG_BYTES.length });

    const res = await r.api<{ task: Task }>("/api/tasks", {
      body: {
        prompt: "Read the report and the repo",
        idempotencyKey: key(),
        attachments: [sent.body.attachment.id],
        links: ["https://github.com/octo-org/hello.world/tree/main/src"],
      },
    });
    expect(res.status).toBe(201);
    const task = res.body.task;
    expect(task.attachments).toEqual([
      { kind: "file", name: "Rapport été (final).pdf", path: "attachments/Rapport_ete_final.pdf", bytes: PNG_BYTES.length, url: null },
      { kind: "repo", name: "octo-org/hello.world", path: "repos/hello.world", bytes: null, url: "https://github.com/octo-org/hello.world" },
    ]);
    // Two steps the model did not choose, on top of its own budget.
    expect(task.budget.maxSteps).toBe(22);

    await taskEnd(r, task.id);
    const copied = await readFile(join(workspace, "tasks", task.id, "attachments", "Rapport_ete_final.pdf"));
    expect(copied.equals(PNG_BYTES)).toBe(true);

    const steps = r.backend.store.steps(task.id);
    expect(steps.map((s) => [s.op, s.outcome?.status])).toEqual([
      ["fs.receive", "succeeded"],
      // The test worker has no shell: the clone fails, the task goes on.
      ["terminal.shell", "failed"],
    ]);
    expect(String(steps[1]!.args.command)).toContain("git clone --depth 1 --quiet -- 'https://github.com/octo-org/hello.world.git' 'repos/hello.world'");

    const prompt = model.calls[0]!.prompt;
    expect(prompt).toContain("- attachments/Rapport_ete_final.pdf (the file Rapport été (final).pdf");
    expect(prompt).toContain("- repos/hello.world/ (a clone of https://github.com/octo-org/hello.world)");
    expect(prompt).toMatch(/Step 1: fs\.receive/);

    // The backend's copy goes once the task is over; the user's file is not an artifact.
    expect(existsSync(join(dataDir, "uploads", sent.body.attachment.id))).toBe(false);
    expect(r.backend.store.upload(sent.body.attachment.id)).toBeNull();
    expect((await r.api<{ task: Task }>(`/api/tasks/${task.id}`)).body.task.result?.artifacts).toEqual([]);
  });

  it("takes an upload once, and gives a retried submit its task back", async () => {
    const { r } = await setup([done("one"), done("two")]);
    const sent = await upload(r, "notes.txt", Buffer.from("hello"));
    const idempotencyKey = key();
    const body = { prompt: "Use the notes", idempotencyKey, attachments: [sent.body.attachment.id] };
    const first = await r.api<{ task: Task }>("/api/tasks", { body });
    expect(first.status).toBe(201);
    const retry = await r.api<{ task: Task; created: boolean }>("/api/tasks", { body });
    expect(retry.status).toBe(200);
    expect(retry.body.task.id).toBe(first.body.task.id);
    const other = await r.api("/api/tasks", { body: { ...body, idempotencyKey: key() } });
    expect(other.status).toBe(400);
    const unknown = await r.api("/api/tasks", {
      body: { prompt: "x", idempotencyKey: key(), attachments: ["00000000-0000-4000-8000-000000000000"] },
    });
    expect(unknown.status).toBe(400);
    await taskEnd(r, first.body.task.id);
  });

  it("refuses links that are not GitHub repositories, and files that are too large", async () => {
    const { r } = await setup([], false);
    for (const link of ["https://example.com/repo", "http://github.com/a/b", "https://github.com/a", "https://github.com/a/.."]) {
      const res = await r.api("/api/tasks", { body: { prompt: "x", idempotencyKey: key(), links: [link] } });
      expect(res.status, link).toBe(400);
    }
    // Refused with a 413, or the connection dropped while the body still streams in.
    const big = await fetch(`http://127.0.0.1:${r.apiPort}/api/attachments?name=big.bin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(20 * 1024 * 1024 + 1),
    }).then((res) => res.status, () => 413);
    expect(big).toBe(413);
    expect(r.backend.store.db.prepare("SELECT COUNT(*) AS n FROM uploads").get()).toEqual({ n: 0 });
  });

  it("never lets the model copy a file in itself", async () => {
    const { r, model } = await setup([
      act("fs.receive", { path: "x.md", upload: "00000000-0000-4000-8000-000000000000", bytes: 1, sha256: "0".repeat(64) }),
      done("ok"),
    ]);
    const res = await r.api<{ task: Task }>("/api/tasks", { body: { prompt: "x", idempotencyKey: key() } });
    await taskEnd(r, res.body.task.id);
    expect(model.calls[1]?.prompt).toMatch(/refused: unknown operation fs\.receive/);
    expect(r.backend.store.steps(res.body.task.id)).toHaveLength(0);
  });

  it("fails the copy with a clear reason on a worker too old for it, instead of jamming the computer", async () => {
    const { r } = await setup([done("ok")], false);
    const gateway = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${r.workerPort}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${WORKER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((res) => res.json() as Promise<any>);
    // A 0.3 worker: no fs.receive in what it says it can do.
    await gateway("/worker/v1/hello", {
      agentId: "agent-01",
      version: "0.3.0",
      capabilities: ["fs.write_artifact", "fs.list", "fs.read", "fs.fetch", "terminal.shell"],
      journal: [],
    });
    const sent = await upload(r, "a.txt", Buffer.from("a"));
    const res = await r.api<{ task: Task }>("/api/tasks", {
      body: { prompt: "x", idempotencyKey: key(), attachments: [sent.body.attachment.id] },
    });
    const claim = await gateway("/worker/v1/jobs/claim", { agentId: "agent-01" });
    expect(claim.job).toBeNull();
    await taskEnd(r, res.body.task.id);
    const step = r.backend.store.steps(res.body.task.id)[0]!;
    expect(step.outcome?.error?.message).toMatch(/too old for fs\.receive/);
  });
});

describe("safe file names", () => {
  it("keeps what the worker accepts and the extension", () => {
    expect(safeFileName("Rapport été (2).pdf")).toBe("Rapport_ete_2.pdf");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("日本語.txt")).toBe("file.txt");
    expect(safeFileName("archive.tar.gz")).toBe("archive_tar.gz");
  });
});
