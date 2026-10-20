// One command, no shell, in the task's folder, with a scrubbed environment
// and a deadline. Arguments that point outside the folder are refused here,
// whatever the policy allowed, so a read-only `cat` cannot read the worker's
// own credentials or anything else on the VM.

import { spawn } from "node:child_process";
import type { OpArgs } from "@coucou-orchestrator/protocol";
import type { OpContext, OpResult } from "../worker.ts";

const MAX_OUTPUT = 64 * 1024;
const OUTPUT_EVENT_MS = 500;

export class CommandError extends Error {}

export function checkArgv(argv: readonly string[]): void {
  const [bin, ...rest] = argv;
  if (!bin || !/^[A-Za-z0-9._+-]+$/.test(bin)) throw new CommandError("the program must be a plain name on PATH");
  for (const arg of rest) {
    // `/etc`, `~/x`, `--file=/etc/x`, `../x`, `a/../../x`
    if (/(^|=)[/~]/.test(arg) || /(^|[/=])\.\.(\/|$)/.test(arg)) {
      throw new CommandError(`argument ${JSON.stringify(arg.slice(0, 60))} reaches outside the task folder`);
    }
  }
}

export function runCommand(ctx: OpContext, args: OpArgs<"terminal.run">): Promise<OpResult> {
  checkArgv(args.argv);
  const [bin, ...rest] = args.argv as [string, ...string[]];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, rest, {
      cwd: ctx.dir,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: ctx.dir, LANG: "C.UTF-8", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
      signal: ctx.signal,
    });
    let output = "";
    let pending = "";
    const flush = () => {
      if (pending) ctx.report("tool.output", { text: pending.slice(-4_000) });
      pending = "";
    };
    const ticker = setInterval(flush, OUTPUT_EVENT_MS);
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (output.length < MAX_OUTPUT) output += text;
      pending += text;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearInterval(ticker);
      reject(err.name === "AbortError" ? err : new CommandError(`could not run ${bin}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      clearInterval(ticker);
      flush();
      const body = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…(cut)` : output;
      resolve({ result: `exit ${code ?? signal}\n${body}`.trimEnd(), failed: code !== 0 });
    });
  });
}
