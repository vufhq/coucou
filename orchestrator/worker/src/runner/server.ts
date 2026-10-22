// coucou-runner: the computer's shell. It runs the agents' bash commands as
// the `runner` user, which is not the worker's user: systemd hides the
// worker, its token, its journal, Windows and the local network from it (see
// coucou-runner.service). The computer is the boundary, as in rakazo, so a
// command here needs no click.
//
// The worker is its only client, over a unix socket only the worker's group
// can open. One connection is one command:
//   → {"command":"…","cwd":"/computer/…","home":"/computer/agents/…","taskDir":"…","timeoutMs":120000}\n
//   ← {"t":"out","d":"…"}\n …   {"t":"exit","code":0,"signal":null,"timedOut":false}\n
// Closing the connection stops the command.

import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, relative, resolve, sep } from "node:path";

const MAX_REQUEST = 32 * 1024;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** After the command exits, output still in flight gets this long. */
const DRAIN_MS = 200;
const KILL_GRACE_MS = 3_000;

export interface RunnerOptions {
  /** Every cwd and home must be inside it. */
  root: string;
  /** /bin/bash in the VM; tests may point elsewhere. */
  shell?: string;
  shellArgs?: (command: string) => string[];
}

export interface ShellRequest {
  command: string;
  cwd: string;
  home: string;
  taskDir: string;
  timeoutMs: number;
}

export class RequestError extends Error {}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && resolve(root, rel) === path);
}

export function parseRequest(line: string, root: string): ShellRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new RequestError("not JSON");
  }
  const r = raw as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof r[k] !== "string" || !(r[k] as string)) throw new RequestError(`${k} is required`);
    return r[k] as string;
  };
  const req: ShellRequest = {
    command: str("command"),
    cwd: resolve(str("cwd")),
    home: resolve(str("home")),
    taskDir: resolve(str("taskDir")),
    timeoutMs: typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? Math.min(r.timeoutMs, MAX_TIMEOUT_MS) : 120_000,
  };
  for (const k of ["cwd", "home", "taskDir"] as const) {
    if (!within(root, req[k])) throw new RequestError(`${k} is outside the computer's folder`);
  }
  return req;
}

/** Runs one request on one connection. */
async function serve(socket: Socket, o: Required<RunnerOptions>): Promise<void> {
  const send = (msg: Record<string, unknown>) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
  };
  const line = await new Promise<string>((done, fail) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        socket.off("data", onData);
        done(buf.slice(0, nl));
      } else if (buf.length > MAX_REQUEST) {
        fail(new RequestError("request too long"));
      }
    };
    socket.on("data", onData);
    socket.once("end", () => fail(new RequestError("no request")));
  });

  const req = parseRequest(line, o.root);
  await mkdir(req.home, { recursive: true });
  const cwd = await realpath(req.cwd).catch(() => {
    throw new RequestError(`no folder ${req.cwd}`);
  });
  if (!within(o.root, cwd)) throw new RequestError("cwd is outside the computer's folder");

  const child = spawn(o.shell, o.shellArgs(req.command), {
    cwd,
    // Its own process group, so a timeout or a stop takes its children too.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: `${join(req.home, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin`,
      HOME: req.home,
      TASK_DIR: req.taskDir,
      SHARED: join(o.root, "shared"),
      LANG: "C.UTF-8",
      TERM: "dumb",
      NO_COLOR: "1",
      PYTHONUNBUFFERED: "1",
    },
  });

  let timedOut = false;
  let finished = false;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone, or no process groups (Windows, in tests).
      child.kill(signal);
    }
  };
  const stop = () => {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, req.timeoutMs);
  // The worker hung up: the job was stopped or timed out on its side.
  socket.once("close", () => {
    if (!finished) stop();
  });

  const out = (chunk: Buffer) => send({ t: "out", d: chunk.toString("utf8") });
  child.stdout.on("data", out);
  child.stderr.on("data", out);

  await new Promise<void>((done) => {
    child.once("error", (err) => {
      send({ t: "out", d: `could not start the shell: ${err.message}\n` });
      finished = true;
      clearTimeout(timer);
      send({ t: "exit", code: 127, signal: null, timedOut: false });
      done();
    });
    // `exit`, not `close`: a server started with `&` keeps the pipes open but
    // must not hold the command. Its output after this point is dropped.
    child.once("exit", (code, signal) => {
      finished = true;
      clearTimeout(timer);
      setTimeout(() => {
        child.stdout.off("data", out);
        child.stderr.off("data", out);
        child.stdout.destroy();
        child.stderr.destroy();
        send({ t: "exit", code, signal, timedOut });
        done();
      }, DRAIN_MS);
    });
  });
}

export function createRunner(options: RunnerOptions): Server {
  const o: Required<RunnerOptions> = {
    shell: "/bin/bash",
    shellArgs: (command) => ["-lc", command],
    ...options,
  };
  return createServer((socket) => {
    socket.on("error", () => {});
    serve(socket, o)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!socket.destroyed) socket.write(`${JSON.stringify({ t: "error", message })}\n`);
      })
      .finally(() => socket.end());
  });
}
