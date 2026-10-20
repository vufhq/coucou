import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTaskDir, inside, taskDir } from "../../worker/src/paths.ts";
import { checkArgv } from "../../worker/src/ops/terminal.ts";

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
