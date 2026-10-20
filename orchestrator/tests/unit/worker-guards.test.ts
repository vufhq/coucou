import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTaskDir, inside, taskDir } from "../../worker/src/paths.ts";
import { checkArgv } from "../../worker/src/ops/terminal.ts";
import { pruneTaskDirs } from "../../worker/src/retention.ts";

const TASK = "11111111-2222-3333-4444-555555555555";
let workspace: string;
let dir: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "orch-guard-"));
  dir = await ensureTaskDir(workspace, TASK);
});
afterAll(() => rm(workspace, { recursive: true, force: true }));

describe("task folder confinement", () => {
  it("refuses task ids that are not UUIDs", () => {
    expect(() => taskDir(workspace, "../../etc")).toThrow();
  });

  it("resolves paths inside the folder and refuses ones that leave it", async () => {
    expect(await inside(dir, "out/report.md")).toBe(join(dir, "out", "report.md"));
    await expect(inside(dir, "../other")).rejects.toThrow(/leaves/);
  });

  it("does not follow a symlink planted in the folder", async (t) => {
    const outside = join(workspace, "secret.txt");
    await writeFile(outside, "x");
    await mkdir(join(dir, "sub"), { recursive: true });
    try {
      await symlink(outside, join(dir, "sub", "link.txt"));
    } catch {
      t.skip(); // Creating symlinks needs Developer Mode on Windows.
      return;
    }
    await expect(inside(dir, "sub/link.txt")).rejects.toThrow(/symlink/);
  });
});

describe("terminal arguments", () => {
  it.each([["cat", "/etc/shadow"], ["cat", "~/.ssh/id_rsa"], ["grep", "--file=/etc/x", "a"], ["cat", "../x"], ["cat", "a/../../x"], ["/bin/sh"], ["sh;rm"]])(
    "refuses %j",
    (...argv) => expect(() => checkArgv(argv)).toThrow(),
  );

  it("allows arguments that stay in the folder", () => {
    expect(() => checkArgv(["grep", "-n", "install", "report.md"])).not.toThrow();
  });
});

describe("task folder retention", () => {
  it("removes folders left alone past the period, and keeps the rest", async () => {
    const ws = await mkdtemp(join(tmpdir(), "orch-retain-"));
    try {
      const day = 24 * 60 * 60_000;
      const old = "aaaaaaaa-0000-0000-0000-000000000001";
      const recent = "aaaaaaaa-0000-0000-0000-000000000002";
      const touched = "aaaaaaaa-0000-0000-0000-000000000003";
      const stamp = async (path: string, ms: number) => utimes(path, new Date(ms), new Date(ms));
      for (const id of [old, recent, touched]) {
        await mkdir(join(ws, "tasks", id, "sub"), { recursive: true });
        await writeFile(join(ws, "tasks", id, "sub", "f.md"), "x");
      }
      await mkdir(join(ws, "tasks", "not-a-task"), { recursive: true });
      const now = Date.now();
      for (const id of [old, touched]) {
        for (const p of ["sub/f.md", "sub", ""]) await stamp(join(ws, "tasks", id, p), now - 40 * day);
      }
      // One file changed lately keeps its whole folder.
      await stamp(join(ws, "tasks", touched, "sub", "f.md"), now - day);
      await stamp(join(ws, "tasks", "not-a-task"), now - 400 * day);

      expect(await pruneTaskDirs(ws, 0, now)).toEqual([]);
      expect(await pruneTaskDirs(ws, 30, now)).toEqual([old]);
      expect((await readdir(join(ws, "tasks"))).sort()).toEqual([recent, touched, "not-a-task"].sort());
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
