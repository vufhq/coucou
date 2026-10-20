import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ModelAdapter, ModelInput, ModelOutput } from "./adapter.ts";
import { ModelError, extractJson } from "./adapter.ts";
import { runCli, scrubbedEnv } from "./cli.ts";

export interface CodexCliOptions {
  command?: string;
  model?: string;
  workDir: string;
}

export const CODEX_CLI_PROFILE = {
  id: "codex-cli",
  provider: "codex-cli",
  model: "default",
  capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
} as const;

export function codexArgs(model?: string): string[] {
  const args = ["exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never", "--skip-git-repo-check"];
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

export function codexResultReady(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message";
    } catch {
      return false;
    }
  });
}

function parseCodexResult(stdout: string): ModelOutput {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        return { text: event.item.text, json: extractJson(event.item.text) };
      }
    } catch {
      // Keep looking for the final agent message.
    }
  }
  throw new ModelError("malformed_output", "Codex did not return an agent message");
}

export class CodexCliAdapter implements ModelAdapter {
  static available(command = "codex", env: NodeJS.ProcessEnv = process.env): boolean {
    if (command.includes("/") || command.includes("\\")) return existsSync(command);
    return (env.PATH ?? "").split(delimiter).some((dir) =>
      [command, `${command}.cmd`, `${command}.exe`].some((name) => existsSync(join(dir, name))),
    );
  }

  private readonly options: CodexCliOptions;

  constructor(options: CodexCliOptions) {
    this.options = options;
    mkdirSync(options.workDir, { recursive: true });
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const stdout = await runCli({
      command: this.options.command ?? "codex",
      args: codexArgs(this.options.model),
      cwd: this.options.workDir,
      env: scrubbedEnv(),
      input: `${input.system}\n\n---\n\n${input.prompt}\n\nReply with one JSON object matching this schema:\n${JSON.stringify(input.jsonSchema ?? {})}`,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      label: "codex",
      resultReady: codexResultReady,
    });
    return parseCodexResult(stdout);
  }
}
