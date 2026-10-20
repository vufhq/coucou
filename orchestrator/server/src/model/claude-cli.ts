// Claude through the Claude Code CLI, on the user's own subscription.
//
// The CLI is an agent in its own right, so it runs here as a plain text
// model and nothing more: every built-in tool off (`--tools ""`), restricted
// mode, no MCP servers, no saved session, an empty working folder, and the
// answer forced into the decision schema. It can only reply; all actions go
// through the runner, the policy and the VM worker. Its sign-in stays its
// own: this module never reads or passes a credential.

import { mkdirSync } from "node:fs";
import type { ModelAdapter, ModelInput, ModelOutput } from "./adapter.ts";
import { parseCliResult, runCli, scrubbedEnv } from "./cli.ts";

export interface ClaudeCliOptions {
  /** `claude` on PATH unless set. */
  command?: string;
  /** An alias (`sonnet`, `opus`) or a full model id; the CLI's default when unset. */
  model?: string;
  /** Empty folder the CLI runs in, so it has no project to look at. */
  workDir: string;
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

export class ClaudeCliAdapter implements ModelAdapter {
  private readonly options: ClaudeCliOptions;

  constructor(options: ClaudeCliOptions) {
    this.options = options;
    mkdirSync(options.workDir, { recursive: true });
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const stdout = await runCli({
      command: this.options.command ?? "claude",
      args: claudeArgs(input, this.options.model),
      cwd: this.options.workDir,
      env: scrubbedEnv(),
      input: input.prompt,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      label: "claude",
    });
    return parseCliResult(stdout);
  }
}
