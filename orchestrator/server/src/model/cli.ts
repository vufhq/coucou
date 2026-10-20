// Running a vendor's agent CLI as a plain text model: the part every
// subscription adapter shares (Claude Code, Cursor). Prompt on stdin, one JSON
// result on stdout, a deadline, cancellation, and the vendors' common
// `--output-format json` result shape read into a model answer.

import { spawn } from "node:child_process";
import { ModelError, extractJson, type ModelOutput } from "./adapter.ts";

const MAX_OUTPUT = 2 * 1024 * 1024;
const LIMIT_WORDS = /rate limit|usage limit|limit reached|too many requests|overloaded|quota|\b429\b/i;

export interface CliRun {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Named in errors: "claude", "cursor-agent". */
  label: string;
  /** Optional readiness check for CLIs that emit a vendor-specific stream. */
  resultReady?: (stdout: string) => boolean;
}

/** A complete `{"type":"result",…}` line: the answer is in, whatever the CLI does next. */
function hasResultLine(stdout: string): boolean {
  for (const line of stdout.split("\n").slice(0, -1)) {
    if (!line.includes('"result"')) continue;
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === "result") return true;
    } catch {
      // Not a JSON line; keep looking.
    }
  }
  return false;
}

/** The backend's environment minus its own secrets, the base for every child. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("ORCH_")) env[k] = v;
  }
  return env;
}

/**
 * Runs the CLI until it prints its result line (or exits) and returns its
 * stdout, or a typed ModelError. A CLI that lingers after answering (Cursor's
 * stays up a minute or more flushing in the background) is stopped then.
 */
export function runCli(run: CliRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      env: run.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ModelError("timeout", `no answer within ${Math.round(run.timeoutMs / 1000)} s`)));
    }, run.timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(() => reject(new ModelError("cancelled", "cancelled")));
    };
    run.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT) child.kill();
      else if (d.includes("\n") && (run.resultReady?.(stdout) ?? hasResultLine(stdout))) {
        finish(() => resolve(stdout));
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < 4_096) stderr += d;
    });
    child.on("error", (err) =>
      finish(() => reject(new ModelError("unavailable", `could not start ${run.label}: ${err.message}`))),
    );
    child.on("close", (code) => {
      finish(() => {
        if (stdout.trim()) return resolve(stdout);
        const why = stderr.trim().slice(0, 300) || `${run.label} exited with code ${code}`;
        reject(new ModelError(LIMIT_WORDS.test(why) ? "rate_limited" : "unavailable", why));
      });
    });
    child.stdin.on("error", () => {}); // A CLI that exits early closes its stdin; the close handler reports it.
    child.stdin.end(run.input);
  });
}

/**
 * Reads a `--output-format json` result: `{type:"result", is_error, result,
 * structured_output?}`, the shape Claude Code and Cursor both print.
 */
export function parseCliResult(stdout: string): ModelOutput {
  // One JSON object (json), or one per line with the result among them
  // (stream-json, or a notice printed first): the last `type: "result"` wins.
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "result" || !result) result = value;
      if (value.type === "result") break;
    } catch {
      // Not a JSON line.
    }
  }
  if (!result) throw new ModelError("malformed_output", "the CLI did not return JSON");
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true) {
    throw new ModelError(LIMIT_WORDS.test(text) ? "rate_limited" : "unavailable", text.slice(0, 300) || "the CLI reported an error");
  }
  if (result.structured_output && typeof result.structured_output === "object") {
    return { text: text || JSON.stringify(result.structured_output), json: result.structured_output };
  }
  return { text, json: extractJson(text) };
}
