// Cursor's models through the Cursor Agent CLI, on the user's own subscription.
//
// Unlike Claude Code, the Cursor CLI has no switch that turns its tools off
// ("-p … has access to all tools, including write and shell"), and its sandbox
// is macOS/Linux only. So it is locked down three ways, each checked on
// Windows against a canary file (see orchestrator/README.md):
//
//   1. A private home folder. Cursor finds its config, hooks and MCP servers
//      through the home folder (and also reads Claude Code's hooks there), so
//      none of the user's own setup is loaded. The sign-in is not kept there
//      and still works.
//   2. That home's cli-config.json denies Shell, Read, Write, WebFetch and MCP.
//      Every attempt comes back "Permission denied", even inside the folder.
//   3. Read-only ask mode, no --force, no MCP approval, an empty working folder.
//
// What remains is the model answering. Actions still go through the runner,
// the policy and the VM worker, like every other model.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelAdapter, ModelInput, ModelOutput } from "./adapter.ts";
import { ModelError } from "./adapter.ts";
import { parseCliResult, runCli, scrubbedEnv } from "./cli.ts";

export interface CursorCliOptions {
  /**
   * The CLI's install folder (`%LOCALAPPDATA%\cursor-agent`). Its newest
   * `versions/<date>-<commit>` is run directly with its own node.exe, never
   * through the .cmd/.ps1 launchers, which would re-parse the prompt.
   */
  installDir: string;
  /** A Cursor model id (`gpt-5.3-codex`, `sonnet-4.5`…); Cursor's default when unset. */
  model?: string;
  /**
   * Where the private home and the empty working folder live. Cursor syncs the
   * account's plugins into that home (several GB is possible): put it on a
   * drive with room (ORCH_CURSOR_STATE_DIR).
   */
  stateDir: string;
}

/** What the private home's cli-config.json says. Exported for the tests. */
export const LOCKED_CONFIG = {
  version: 1,
  approvalMode: "allowlist",
  autoAcceptWebSearch: false,
  sandbox: { mode: "disabled" },
  permissions: {
    allow: [] as string[],
    deny: ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "Mcp(*:*)"],
  },
};

/** `2026.10.14-0f9edde` → 20261014, so versions sort by date. */
function versionKey(name: string): number {
  // Only finished installs: the updater leaves `<version>.previous` and
  // `extract-…` folders beside them while it swaps versions.
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-[0-9a-f]+$/.exec(name);
  if (!m) return -1;
  return Number(`${m[1]}${m[2]!.padStart(2, "0")}${m[3]!.padStart(2, "0")}`);
}

/** Installed version folders with their node.exe and index.js, newest first. */
export function versionDirs(installDir: string): string[] {
  const versions = join(installDir, "versions");
  if (!existsSync(versions)) return [];
  return readdirSync(versions)
    .filter((name) => versionKey(name) > 0)
    .sort((a, b) => versionKey(b) - versionKey(a))
    .map((name) => join(versions, name))
    .filter((dir) => existsSync(join(dir, "index.js")) && existsSync(join(dir, process.platform === "win32" ? "node.exe" : "node")));
}

export function latestVersionDir(installDir: string): string | null {
  return versionDirs(installDir)[0] ?? null;
}

export function cursorArgs(entry: string, model?: string): string[] {
  // stream-json: the result event arrives as soon as the answer does; plain
  // json is printed only when the CLI exits, a minute or more later.
  const args = [entry, "-p", "--output-format", "stream-json", "--mode", "ask", "--trust"];
  if (model) args.push("--model", model);
  return args;
}

/** The child's environment: the private home, and no shell hint (its hooks would break on Windows anyway). */
export function cursorEnv(home: string, base: NodeJS.ProcessEnv = scrubbedEnv()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.SHELL;
  delete env.CURSOR_API_KEY; // The subscription sign-in only, never a key from the environment.
  env.USERPROFILE = home;
  env.HOME = home;
  env.CURSOR_CONFIG_DIR = join(home, ".cursor");
  // What the launcher sets: a warm compile cache halves the CLI's start-up.
  if (env.LOCALAPPDATA && !env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = join(env.LOCALAPPDATA, "cursor-compile-cache");
  return env;
}

/** Cursor has no system-prompt or schema flag: both travel in the prompt. */
export function cursorPrompt(input: ModelInput): string {
  const schema = input.jsonSchema
    ? `\n\nReply with ONE JSON object that matches this JSON Schema, and nothing else (no prose, no code fence):\n${JSON.stringify(input.jsonSchema)}`
    : "";
  return `${input.system}\n\n---\n\n${input.prompt}${schema}`;
}

export class CursorCliAdapter implements ModelAdapter {
  private readonly options: CursorCliOptions;
  private readonly home: string;
  private readonly workDir: string;

  constructor(options: CursorCliOptions) {
    this.options = options;
    this.home = join(options.stateDir, "home");
    this.workDir = join(options.stateDir, "workspace");
    mkdirSync(join(this.home, ".cursor"), { recursive: true });
    mkdirSync(this.workDir, { recursive: true });
    this.lock();
  }

  /** True when the CLI is installed where expected. */
  static available(installDir: string): boolean {
    return latestVersionDir(installDir) !== null;
  }

  /**
   * Rewrites the locked config, drops any hooks or MCP servers, and empties
   * the working folder before every run. Cursor's own caches stay: the plugins
   * synced from the user's account alone can be gigabytes, downloaded once.
   */
  private lock(): void {
    const cursorDir = join(this.home, ".cursor");
    writeFileSync(join(cursorDir, "cli-config.json"), JSON.stringify(LOCKED_CONFIG, null, 2));
    for (const name of ["hooks.json", "mcp.json"]) rmSync(join(cursorDir, name), { force: true });
    for (const name of readdirSync(this.workDir)) rmSync(join(this.workDir, name), { recursive: true, force: true });
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const dirs = versionDirs(this.options.installDir);
    if (dirs.length === 0) throw new ModelError("unavailable", "the Cursor CLI is not installed (cursor.com/cli)");
    this.lock();
    let last: unknown;
    // The newest first; if it cannot even start (the updater is swapping it
    // in), the one before it.
    for (const dir of dirs.slice(0, 2)) {
      try {
        const stdout = await runCli({
          command: join(dir, process.platform === "win32" ? "node.exe" : "node"),
          args: cursorArgs(join(dir, "index.js"), this.options.model),
          cwd: this.workDir,
          env: cursorEnv(this.home),
          input: cursorPrompt(input),
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          label: "cursor-agent",
        });
        return parseCliResult(stdout);
      } catch (err) {
        last = err;
        if (!(err instanceof ModelError && err.message.startsWith("could not start"))) throw err;
      }
    }
    throw last;
  }
}
