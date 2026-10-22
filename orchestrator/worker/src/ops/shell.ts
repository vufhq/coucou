// terminal.shell: a bash command line, run by the computer's runner (see
// runner/server.ts) and never by the worker itself, so the code an agent
// writes cannot reach the worker's token or journal. Output streams back as
// tool.output events; the model gets the exit code and the last 64 KiB.

import { connect } from "node:net";
import { join } from "node:path";
import { SHELL_DEFAULT_TIMEOUT_SEC, type OpArgs } from "@coucou-orchestrator/protocol";
import type { OpContext, OpResult } from "../worker.ts";
import { CommandError } from "./terminal.ts";

const MAX_OUTPUT = 64 * 1024;
const OUTPUT_EVENT_MS = 500;

export interface ShellRequest {
  command: string;
  cwd: string;
  home: string;
  taskDir: string;
  timeoutMs: number;
}

export interface ShellExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

/** How the worker reaches the runner: its unix socket in the VM, a fake in tests. */
export interface ShellRunner {
  run(req: ShellRequest, onOutput: (text: string) => void, signal: AbortSignal): Promise<ShellExit>;
}

/** The agent's own folder on the computer, kept between tasks. */
export function agentHome(computer: string, agentId: string): string {
  return join(computer, "agents", agentId);
}

/** Talks to coucou-runner over its socket. */
export function socketShell(path: string): ShellRunner {
  return {
    run: (req, onOutput, signal) =>
      new Promise((resolve, reject) => {
        const socket = connect(path);
        let buf = "";
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          fn();
          socket.destroy();
        };
        const onAbort = () => settle(() => reject(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
        socket.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (msg.t === "out") onOutput(String(msg.d ?? ""));
            else if (msg.t === "exit") {
              const exit: ShellExit = {
                code: typeof msg.code === "number" ? msg.code : null,
                signal: typeof msg.signal === "string" ? msg.signal : null,
                timedOut: msg.timedOut === true,
              };
              settle(() => resolve(exit));
            } else if (msg.t === "error") settle(() => reject(new CommandError(String(msg.message ?? "the runner refused the command"))));
          }
        });
        socket.on("error", (err: NodeJS.ErrnoException) => {
          const missing = err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "EACCES";
          settle(() =>
            reject(
              new CommandError(
                missing
                  ? "this computer cannot run shell commands yet: run provision.ps1 -Update for it"
                  : `could not reach the computer's runner: ${err.message}`,
              ),
            ),
          );
        });
        socket.on("close", () => settle(() => reject(new CommandError("the computer's runner stopped before the command finished"))));
      }),
  };
}

/** Where the command starts: the task folder, a folder in it, or `~/…`. */
export function shellCwd(taskDir: string, home: string, cwd: string | undefined): string {
  if (!cwd) return taskDir;
  if (cwd === "~") return home;
  if (cwd.startsWith("~/")) return join(home, ...cwd.slice(2).split("/"));
  return join(taskDir, ...cwd.split("/"));
}

export async function runShell(ctx: OpContext, args: OpArgs<"terminal.shell">, shell: ShellRunner): Promise<OpResult> {
  const timeoutSec = args.timeoutSec ?? SHELL_DEFAULT_TIMEOUT_SEC;
  const req: ShellRequest = {
    command: args.command,
    cwd: shellCwd(ctx.dir, ctx.home, args.cwd),
    home: ctx.home,
    taskDir: ctx.dir,
    timeoutMs: timeoutSec * 1_000,
  };
  let output = "";
  let cut = false;
  let pending = "";
  const flush = () => {
    if (pending) ctx.report("tool.output", { text: pending.slice(-4_000) });
    pending = "";
  };
  const ticker = setInterval(flush, OUTPUT_EVENT_MS);
  try {
    const exit = await shell.run(
      req,
      (text) => {
        output += text;
        // The tail matters most: that is where the error is.
        if (output.length > MAX_OUTPUT) {
          output = output.slice(-MAX_OUTPUT);
          cut = true;
        }
        pending += text;
      },
      ctx.signal,
    );
    flush();
    const body = `${cut ? "…(earlier output cut)\n" : ""}${output}`;
    if (exit.timedOut) {
      return { result: `timed out after ${timeoutSec} s and was stopped\n${body}`.trimEnd(), failed: true };
    }
    return { result: `exit ${exit.code ?? exit.signal}\n${body}`.trimEnd(), failed: exit.code !== 0 };
  } finally {
    clearInterval(ticker);
  }
}
