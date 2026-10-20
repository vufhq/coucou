import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelError } from "../../server/src/model/adapter.ts";
import { codexArgs, codexResultReady, CODEX_CLI_PROFILE } from "../../server/src/model/codex-cli.ts";
import { claudeArgs } from "../../server/src/model/claude-cli.ts";
import { parseCliResult } from "../../server/src/model/cli.ts";
import {
  CursorCliAdapter,
  LOCKED_CONFIG,
  cursorArgs,
  cursorEnv,
  cursorPrompt,
  latestVersionDir,
} from "../../server/src/model/cursor-cli.ts";
import { ModelRouter } from "../../server/src/model/router.ts";
import { ScriptedModel } from "../../server/src/model/scripted.ts";

const tmp = mkdtempSync(join(tmpdir(), "orch-models-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("Claude Code CLI adapter", () => {
  it("runs the CLI with every tool off and no session saved", () => {
    const args = claudeArgs({ system: "sys", prompt: "p", timeoutMs: 1, jsonSchema: { type: "object" } }, "sonnet");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });
});

describe("Codex CLI adapter", () => {
  it("runs exec read-only without asking for tool approval", () => {
    expect(codexArgs("gpt-5-codex")).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--model",
      "gpt-5-codex",
      "-",
    ]);
    expect(CODEX_CLI_PROFILE.id).toBe("codex-cli");
  });

  it("recognises the completed agent message in Codex JSONL", () => {
    expect(codexResultReady('{"type":"turn.started"}\n')).toBe(false);
    expect(codexResultReady('{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}\n')).toBe(true);
  });
});

describe("CLI results", () => {
  it("reads structured output, falls back to JSON in the text, and maps limits", () => {
    expect(parseCliResult(JSON.stringify({ result: "", structured_output: { kind: "done", summary: "x" } })).json).toEqual({
      kind: "done",
      summary: "x",
    });
    expect(parseCliResult(JSON.stringify({ result: '```json\n{"kind":"done","summary":"y"}\n```' })).json).toEqual({
      kind: "done",
      summary: "y",
    });
    expect(() => parseCliResult(JSON.stringify({ is_error: true, result: "Claude usage limit reached" }))).toThrow(
      expect.objectContaining({ code: "rate_limited" }),
    );
  });

  it("does not mistake a code block inside the answer for a fence around it", () => {
    // Cursor's real answer that failed a task: a report whose content has a ```bash block.
    const answer = JSON.stringify({
      kind: "action",
      op: "fs.write_artifact",
      args: { path: "report.md", content: "# HTTPX\n\n```bash\npip install httpx\n```\n" },
    });
    expect(parseCliResult(JSON.stringify({ type: "result", result: answer })).json).toEqual(JSON.parse(answer));
    // Still read: a fenced answer, and an answer with a sentence around it.
    const fenced = "```json\n" + answer + "\n```";
    expect(parseCliResult(JSON.stringify({ type: "result", result: fenced })).json).toEqual(JSON.parse(answer));
    expect(parseCliResult(JSON.stringify({ type: "result", result: `Here you go: ${answer} Done.` })).json).toEqual(JSON.parse(answer));
    expect(() => parseCliResult(JSON.stringify({ type: "result", result: "I cannot do that." }))).toThrow(/no JSON object/);
  });

  it("takes the result line when a CLI prints something before it", () => {
    const out = `Update available\n${JSON.stringify({ type: "result", is_error: false, result: '{"kind":"done","summary":"z"}' })}\n`;
    expect(parseCliResult(out).json).toEqual({ kind: "done", summary: "z" });
  });
});

describe("Cursor CLI adapter", () => {
  it("runs read-only: ask mode, no --force, no MCP approval", () => {
    const args = cursorArgs("index.js", "gpt-5.3-codex");
    expect(args.slice(0, 7)).toEqual(["index.js", "-p", "--output-format", "stream-json", "--mode", "ask", "--trust"]);
    for (const flag of ["--force", "--yolo", "-f", "--approve-mcps", "--sandbox"]) expect(args).not.toContain(flag);
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.3-codex");
  });

  it("denies every tool in the private home's config", () => {
    expect(LOCKED_CONFIG.permissions.allow).toEqual([]);
    expect(LOCKED_CONFIG.permissions.deny).toEqual(
      expect.arrayContaining(["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "Mcp(*:*)"]),
    );
  });

  it("runs from a private home, without the shell hint or an API key", () => {
    const env = cursorEnv("C:\\priv", { SHELL: "/usr/bin/bash", CURSOR_API_KEY: "k", USERPROFILE: "C:\\Users\\me", PATH: "x" });
    expect(env).toMatchObject({ USERPROFILE: "C:\\priv", HOME: "C:\\priv", CURSOR_CONFIG_DIR: join("C:\\priv", ".cursor"), PATH: "x" });
    expect(env.SHELL).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  it("carries the instructions and the schema in the prompt", () => {
    const text = cursorPrompt({ system: "SYS", prompt: "TASK", timeoutMs: 1, jsonSchema: { type: "object" } });
    expect(text.indexOf("SYS")).toBeLessThan(text.indexOf("TASK"));
    expect(text).toContain('{"type":"object"}');
  });

  it("runs the newest installed version, skipping incomplete ones", () => {
    const install = join(tmp, "cursor-agent");
    const exe = process.platform === "win32" ? "node.exe" : "node";
    for (const [name, complete] of [
      ["2026.9.30-aaaa", true],
      ["2026.10.14-bbbb", true],
      ["2026.11.2-cccc", false],
      ["2026.10.20-dddd.previous", true],
      ["extract-1234", true],
    ] as const) {
      mkdirSync(join(install, "versions", name), { recursive: true });
      if (complete) {
        writeFileSync(join(install, "versions", name, "index.js"), "");
        writeFileSync(join(install, "versions", name, exe), "");
      }
    }
    expect(latestVersionDir(install)).toBe(join(install, "versions", "2026.10.14-bbbb"));
    expect(latestVersionDir(join(tmp, "missing"))).toBeNull();
  });

  it("writes the lock, drops hooks and MCP servers, and keeps Cursor's caches", () => {
    const state = join(tmp, "state");
    const cursorDir = join(state, "home", ".cursor");
    mkdirSync(join(cursorDir, "plugins", "cache"), { recursive: true });
    writeFileSync(join(cursorDir, "hooks.json"), "{}");
    writeFileSync(join(cursorDir, "mcp.json"), "{}");
    writeFileSync(join(cursorDir, "plugins", "cache", "big.bin"), "x");
    mkdirSync(join(state, "workspace"), { recursive: true });
    writeFileSync(join(state, "workspace", "left-over.txt"), "x");
    new CursorCliAdapter({ installDir: join(tmp, "cursor-agent"), stateDir: state });
    const config = JSON.parse(readFileSync(join(cursorDir, "cli-config.json"), "utf8"));
    expect(config.permissions.deny).toContain("Read(**)");
    expect(() => readFileSync(join(cursorDir, "hooks.json"))).toThrow();
    expect(() => readFileSync(join(cursorDir, "mcp.json"))).toThrow();
    expect(readFileSync(join(cursorDir, "plugins", "cache", "big.bin"), "utf8")).toBe("x");
    expect(() => readFileSync(join(state, "workspace", "left-over.txt"))).toThrow();
  });
});

describe("model router", () => {
  const profile = (id: string) => ({
    id,
    provider: "test",
    model: id,
    capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
  });
  const input = { system: "", prompt: "", timeoutMs: 1 };

  it("falls back on a rate limit, and says which profile answered", async () => {
    const router = new ModelRouter();
    router.register(profile("a"), new ScriptedModel([new ModelError("rate_limited", "limit")]), ["b"]);
    router.register(profile("b"), new ScriptedModel([{ kind: "done", summary: "from b" }]));
    const out = await router.generate("a", input);
    expect(out.profileId).toBe("b");
    expect(out.json).toEqual({ kind: "done", summary: "from b" });
  });

  it("never falls back on a bad answer or a cancellation", async () => {
    for (const code of ["malformed_output", "cancelled", "timeout"] as const) {
      const router = new ModelRouter();
      const b = new ScriptedModel([{ kind: "done", summary: "b" }]);
      router.register(profile("a"), new ScriptedModel([new ModelError(code, code)]), ["b"]);
      router.register(profile("b"), b);
      await expect(router.generate("a", input)).rejects.toMatchObject({ code });
      expect(b.calls).toHaveLength(0);
    }
  });

  it("lists each profile with its fallbacks", () => {
    const router = new ModelRouter();
    router.register(profile("a"), new ScriptedModel([]), ["b"]);
    expect(router.list()).toEqual([expect.objectContaining({ id: "a", fallbacks: ["b"] })]);
  });
});
