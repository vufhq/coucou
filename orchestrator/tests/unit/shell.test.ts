import { execSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOperation } from "../../protocol/src/ops.ts";
import { jobDeadlineMs } from "../../server/src/runner.ts";
import { agentHome, runShell, shellCwd, socketShell, type ShellExit, type ShellRunner } from "../../worker/src/ops/shell.ts";
import { createRunner, parseRequest } from "../../worker/src/runner/server.ts";
import type { OpContext } from "../../worker/src/worker.ts";

const isWindows = process.platform === "win32";
const bash = execSync(isWindows ? "where bash" : "command -v bash", { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();

let root: string;
let taskDir: string;
let home: string;
let socketPath: string;
let server: Server;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orch-computer-")));
  taskDir = join(root, "tasks", "11111111-2222-3333-4444-555555555555");
  home = agentHome(root, "mochi");
  await mkdir(join(taskDir, "app"), { recursive: true });
  socketPath = isWindows ? `\\\\.\\pipe\\orch-runner-${process.pid}-${Date.now()}` : join(root, "runner.sock");
  // `-c`, not `-lc`: a login shell on the test machine reads its profile.
  server = createRunner({ root, shell: bash, shellArgs: (command) => ["-c", command] });
  await new Promise<void>((done) => server.listen(socketPath, done));
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
});

function ctx(signal = new AbortController().signal): OpContext & { events: string[] } {
  const events: string[] = [];
  return {
    taskId: "t",
    jobId: "j",
    dir: taskDir,
    home,
    deadlineMs: 60_000,
    signal,
    report: (_type, payload) => events.push(String(payload.text)),
    upload: async () => {},
    download: async () => Buffer.alloc(0),
    events,
  };
}

describe("terminal.shell arguments", () => {
  it("accepts a command line with a folder in the task folder or ~", () => {
    expect(parseOperation("terminal.shell", { command: "python3 main.py | tee out.txt && echo ok" }).ok).toBe(true);
    expect(parseOperation("terminal.shell", { command: "ls", cwd: "app/src" }).ok).toBe(true);
    expect(parseOperation("terminal.shell", { command: "ls", cwd: "~/proj" }).ok).toBe(true);
    expect(parseOperation("terminal.shell", { command: "ls", cwd: "~" }).ok).toBe(true);
  });

  it.each(["/etc", "../x", "~/../x", "a/../../x", "~root"])("refuses the cwd %j", (cwd) => {
    expect(parseOperation("terminal.shell", { command: "ls", cwd }).ok).toBe(false);
  });

  it("caps the timeout at ten minutes", () => {
    expect(parseOperation("terminal.shell", { command: "ls", timeoutSec: 601 }).ok).toBe(false);
  });

  it("gives a shell job as long as it asked for, plus time to report", () => {
    expect(jobDeadlineMs("terminal.shell", { command: "x", timeoutSec: 300 }, 60_000)).toBe(315_000);
    expect(jobDeadlineMs("terminal.shell", { command: "x" }, 60_000)).toBe(135_000);
    expect(jobDeadlineMs("fs.list", {}, 60_000)).toBe(60_000);
  });
});

describe("where a command starts", () => {
  it("is the task folder, a folder in it, or the agent's own folder", () => {
    expect(shellCwd(taskDir, home, undefined)).toBe(taskDir);
    expect(shellCwd(taskDir, home, "app")).toBe(join(taskDir, "app"));
    expect(shellCwd(taskDir, home, "~")).toBe(home);
    expect(shellCwd(taskDir, home, "~/proj/src")).toBe(join(home, "proj", "src"));
  });
});

describe("the runner", () => {
  it("refuses folders outside the computer", () => {
    const line = (cwd: string) => JSON.stringify({ command: "ls", cwd, home, taskDir, timeoutMs: 1000 });
    expect(() => parseRequest(line(join(root, "..")), root)).toThrow(/outside/);
    expect(() => parseRequest(line(taskDir), root)).not.toThrow();
  });

  it("runs a command line in the task folder and returns its output and exit code", async () => {
    const c = ctx();
    const out = await runShell(c, { command: 'echo "hi from $HOME" && echo oops >&2 && exit 3' }, socketShell(socketPath));
    expect(out.failed).toBe(true);
    expect(out.result).toMatch(/^exit 3\n/);
    expect(out.result).toContain("hi from");
    expect(out.result).toContain("oops");
  });

  it("creates the agent's own folder and runs there with cwd ~", async () => {
    const out = await runShell(ctx(), { command: "echo made > note.txt && cat note.txt", cwd: "~" }, socketShell(socketPath));
    expect(out).toEqual({ result: "exit 0\nmade", failed: false });
  });

  it("stops a command at its timeout", async () => {
    const out = await runShell(ctx(), { command: "while :; do :; done", timeoutSec: 1 }, socketShell(socketPath));
    expect(out.failed).toBe(true);
    expect(out.result).toMatch(/^timed out after 1 s/);
  }, 15_000);

  it("stops the command when the job is stopped", async () => {
    const controller = new AbortController();
    const run = runShell(ctx(controller.signal), { command: "while :; do :; done" }, socketShell(socketPath));
    setTimeout(() => controller.abort(new Error("cancelled")), 300);
    await expect(run).rejects.toThrow("cancelled");
  });

  it.skipIf(isWindows)("does not wait for a server started in the background", async () => {
    const started = Date.now();
    const out = await runShell(ctx(), { command: "sleep 30 & echo started" }, socketShell(socketPath));
    expect(out.result).toBe("exit 0\nstarted");
    expect(Date.now() - started).toBeLessThan(5_000);
    execSync("pkill -f 'sleep 30' || true");
  });

  it("says how to fix a computer without a runner", async () => {
    const missing = isWindows ? "\\\\.\\pipe\\orch-runner-missing" : join(root, "missing.sock");
    await expect(runShell(ctx(), { command: "ls" }, socketShell(missing))).rejects.toThrow(/provision\.ps1 -Update/);
  });
});

describe("shell output", () => {
  const fake = (chunks: string[], exit: ShellExit): ShellRunner => ({
    run: async (_req, onOutput) => {
      for (const chunk of chunks) onOutput(chunk);
      return exit;
    },
  });

  it("keeps the tail of a long output, where the error is", async () => {
    const long = `${"x".repeat(70 * 1024)}\nTraceback: boom`;
    const out = await runShell(ctx(), { command: "make" }, fake([long], { code: 1, signal: null, timedOut: false }));
    expect(out.result.startsWith("exit 1\n…(earlier output cut)\n")).toBe(true);
    expect(out.result.endsWith("Traceback: boom")).toBe(true);
    expect(out.result.length).toBeLessThan(66 * 1024);
  });

  it("streams output as it comes", async () => {
    const c = ctx();
    await runShell(c, { command: "x" }, fake(["a", "b"], { code: 0, signal: null, timedOut: false }));
    expect(c.events.join("")).toBe("ab");
  });
});
