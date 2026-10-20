// Claude through the Claude Code CLI, on the user's own subscription.
//
// The CLI is an agent in its own right, so it runs here as a plain text
// model and nothing more: every built-in tool off (`--tools ""`), restricted
// mode, no MCP servers, no saved session, an empty working folder, and the
// answer forced into the decision schema. It can only reply; all actions go
// through the runner, the policy and the VM worker. Its sign-in stays its
// own: this module never reads or passes a credential.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ModelError, extractJson, type ModelAdapter, type ModelInput, type ModelOutput } from "./adapter.ts";

export interface ClaudeCliOptions {
  /** `claude` on PATH unless set. */
  command?: string;
  /** An alias (`sonnet`, `opus`) or a full model id; the CLI's default when unset. */
  model?: string;
  /** Empty folder the CLI runs in, so it has no project to look at. */
  workDir: string;
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const LIMIT_WORDS = /rate limit|usage limit|limit reached|too many requests|overloaded|\b429\b/i;

/** Environment for the child: ours, minus anything that is the backend's own secret. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("ORCH_")) env[k] = v;
  }
  return env;
}

export function claudeArgs(input: ModelInput, model?: string): string[] {
  const args = [
    "-p",
    "--restricted",
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", input.system,
  ];
  if (input.jsonSchema) args.push("--json-schema", JSON.stringify(input.jsonSchema));
  if (model) args.push("--model", model);
  return args;
}

/** Reads the CLI's `--output-format json` result into a model answer. */
export function parseClaudeResult(stdout: string): ModelOutput {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new ModelError("malformed_output", "the CLI did not return JSON");
  }
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true) {
    throw new ModelError(LIMIT_WORDS.test(text) ? "rate_limited" : "unavailable", text.slice(0, 300) || "the CLI reported an error");
  }
  if (result.structured_output && typeof result.structured_output === "object") {
    return { text: text || JSON.stringify(result.structured_output), json: result.structured_output };
  }
  return { text, json: extractJson(text) };
}

export class ClaudeCliAdapter implements ModelAdapter {
  private readonly options: ClaudeCliOptions;

  constructor(options: ClaudeCliOptions) {
    this.options = options;
    mkdirSync(options.workDir, { recursive: true });
  }

  generate(input: ModelInput): Promise<ModelOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command ?? "claude", claudeArgs(input, this.options.model), {
        cwd: this.options.workDir,
        env: childEnv(),
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
        input.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new ModelError("timeout", `no answer within ${Math.round(input.timeoutMs / 1000)} s`)));
      }, input.timeoutMs);
      const onAbort = () => {
        child.kill();
        finish(() => reject(new ModelError("cancelled", "cancelled")));
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        stdout += d;
        if (stdout.length > MAX_OUTPUT) child.kill();
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        if (stderr.length < 4_096) stderr += d;
      });
      child.on("error", (err) => finish(() => reject(new ModelError("unavailable", `could not start claude: ${err.message}`))));
      child.on("close", (code) => {
        finish(() => {
          if (stdout.trim()) {
            try {
              resolve(parseClaudeResult(stdout));
            } catch (err) {
              reject(err);
            }
            return;
          }
          const why = stderr.trim().slice(0, 300) || `claude exited with code ${code}`;
          reject(new ModelError(LIMIT_WORDS.test(why) ? "rate_limited" : "unavailable", why));
        });
      });
      child.stdin.end(input.prompt);
    });
  }
}
