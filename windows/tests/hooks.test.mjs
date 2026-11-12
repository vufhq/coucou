// The orchestrator agents' events → island state (src/island/hooks.ts), driven
// through the real bridge: events come in as src-tauri/src/orchestrator.rs
// emits them, and what the island answers is read from the commands it invokes.
// tests/orchestrator.test.mjs covers the agent pills and the Tasks page; this
// file covers the timing and the approval card.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { Sound } from "../src/core/sound.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

const ONE = "agent_agent-01";
const TWO = "agent_agent-02";

/** What the handler asked the island to do, in order. */
let asked;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  setView: (view) => asked.push(`setView:${view}`),
  reveal: () => asked.push("reveal"),
  dropPin: () => asked.push("dropPin"),
};
registerHookHandlers(island);

/** An event of `agent`'s task `task`, as orchestrator.rs emits it. */
const hook = (name, extra = {}, agent = "agent-01", taskId = "t-1") =>
  emit("hook", { hook_event_name: name, coucou_agent: agent, session_id: `orch:${taskId}`, ...extra });
const request = (approvalId = "a-1", agent = "agent-01", taskId = "t-1") =>
  hook("PermissionRequest", {
    request_id: `orch:${agent}:${approvalId}`,
    tool_name: "terminal.run",
    tool_input: { command: "pytest -q" },
  }, agent, taskId);
const task = (id = ONE) => State.tasks.find((t) => t.id === id);
const seconds = (n) => mock.timers.tick(n * 1000);

beforeEach(() => {
  setLanguage("en");
  mock.timers.enable({ apis: ["setTimeout"] });
  asked = [];
  calls.length = 0;
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.isPinned = false;
  State.pendingApproval = null;
  State.focusBeforeApproval = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

// hooks.ts keeps timer handles between events: the 110 s card timeout, and one
// 5.2 s return to idle per pill that has stopped. Letting every timer fire
// before the reset clears them all.
afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

// ── What is ignored ───────────────────────────────────────────────────────────

test("a paused island ignores every event, approvals included", () => {
  State.paused = true;
  hook("UserPromptSubmit", { prompt: "go" });
  request();
  assert.equal(task(), undefined);
  assert.equal(State.pendingApproval, null);
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
});

test("an untagged event or an invalid tag is ignored", () => {
  emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
  emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go", coucou_agent: "Not An Id" });
  assert.equal(State.tasks.some((t) => t.id.startsWith("agent_")), false);
  assert.deepEqual(asked, []);
});

test("an unknown event changes nothing", () => {
  hook("SomethingNew");
  assert.equal(task(), undefined);
  assert.deepEqual(asked, []);
});

// ── A task's life ─────────────────────────────────────────────────────────────

test("a task shows as thinking, then working with what it acts on, and reveals the island", () => {
  hook("UserPromptSubmit", { prompt: "Summarise the docs" });
  assert.equal(task().state, "thinking");
  assert.deepEqual(task().steps, ["Summarise the docs"]);
  assert.deepEqual(asked, ["reveal"]);
  hook("PreToolUse", { tool_name: "Bash", tool_input: { query: "pytest -q" } });
  assert.equal(task().state, "working");
  assert.equal(task().steps.at(-1), "Runs · pytest -q");
  hook("PreToolUse", { tool_name: "Tool", tool_input: {} });
  assert.equal(task().steps.at(-1), "Tool");
});

test("a failed tool call leaves its step and keeps working", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  hook("PostToolUseFailure", { tool_name: "Bash" });
  assert.equal(task().state, "working");
  assert.equal(task().steps.at(-1), "⚠ failed");
});

test("a finished task opens the finished view with its summary, then goes idle after 5.2 s", () => {
  const played = mock.method(Sound, "play", () => {});
  hook("UserPromptSubmit", { prompt: "go" });
  State.setFocus(ONE);
  hook("Stop", { last_assistant_message: "**Done.** Saved report.md.\n\nMore below." });
  assert.equal(task().state, "finished");
  assert.equal(task().finalLine, "Done. Saved report.md.");
  assert.ok(asked.includes("alert:finished"));
  assert.ok(played.mock.calls.some((c) => c.arguments[0] === "finish"));
  seconds(5.2);
  // The agent's pill is the backend's, or made for the task: back to rest or gone.
  assert.equal(task(), undefined);
  played.mock.restore();
});

test("a task finishing behind another pill only badges its own", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  State.setFocus("integration_github");
  hook("Stop", { last_assistant_message: "Done." });
  assert.equal(task().pillBadge, "finished");
  assert.ok(!asked.includes("alert:finished"));
});

test("a new task within 5.2 s of a stop is not put back to idle, and drops the badge", () => {
  hook("UserPromptSubmit", { prompt: "first" });
  State.setFocus("integration_github");
  hook("Stop", { last_assistant_message: "Done." });
  seconds(2);
  hook("UserPromptSubmit", { prompt: "second" }, "agent-01", "t-2");
  assert.equal(task().pillBadge, null);
  assert.equal(task().finalLine, null);
  seconds(4);
  assert.equal(task().state, "thinking");
});

test("a failed task shows the error view, or the error badge behind another pill", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  State.setFocus(ONE);
  hook("StopFailure", { message: "model timed out" });
  assert.equal(task().state, "error");
  assert.ok(asked.includes("alert:error"));

  asked = [];
  hook("UserPromptSubmit", { prompt: "go" }, "agent-02", "t-9");
  hook("StopFailure", {}, "agent-02", "t-9");
  assert.equal(task(TWO).pillBadge, "error");
  assert.ok(!asked.includes("alert:error"));
});

test("a failure within 5.2 s of a stop stays an error", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  hook("Stop", { last_assistant_message: "Done." });
  hook("StopFailure", {});
  seconds(6);
  assert.equal(task().state, "error");
});

test("a cancelled task takes its stop timer with it", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  hook("Stop", { last_assistant_message: "Done." });
  hook("SessionEnd");
  assert.equal(task(), undefined);
  // A pill made again right after must not be removed by the old timer.
  hook("UserPromptSubmit", { prompt: "again" }, "agent-01", "t-2");
  seconds(6);
  assert.equal(task().state, "thinking");
});

// ── The approval card ─────────────────────────────────────────────────────────

test("an approval puts the card up and says exactly what it authorises", () => {
  const played = mock.method(Sound, "play", () => {});
  request();
  assert.deepEqual(State.pendingApproval, {
    requestId: "orch:agent-01:a-1", sessionId: "orch:t-1", pillId: ONE, tool: "terminal.run", command: "terminal.run · pytest -q",
  });
  assert.equal(task().state, "approval");
  assert.equal(State.focusId, ONE);
  assert.ok(State.isPinned);
  assert.deepEqual(asked, ["alert:approval"]);
  assert.ok(played.mock.calls.some((c) => c.arguments[0] === "approval"));
  assert.equal(State.defaultView(), "approval", "reopening the island shows the card");
  played.mock.restore();
});

test("a request the backend does not own raises no card", () => {
  hook("PermissionRequest", { request_id: "r1", tool_name: "Bash" });
  assert.equal(State.pendingApproval, null);
  assert.deepEqual(asked, []);
});

test("a second request never replaces the card: it waits in HQ", () => {
  request("a-1");
  request("a-2", "agent-02", "t-2");
  assert.equal(State.pendingApproval.requestId, "orch:agent-01:a-1");
});

test("the pill that was in front comes back once the card goes", () => {
  State.setFocus("integration_github");
  request();
  assert.equal(State.focusId, ONE);
  hook("Stop", { last_assistant_message: "Done." });
  assert.equal(State.pendingApproval, null);
  assert.equal(State.focusId, "integration_github");
});

test("the task ending or moving on takes its card down; another task's events leave it", () => {
  request();
  hook("PreToolUse", { tool_name: "Bash" }, "agent-02", "t-2");
  hook("Stop", {}, "agent-01", "t-other");
  assert.ok(State.pendingApproval, "another task's events leave the card alone");
  hook("UserPromptSubmit", { prompt: "next" });
  assert.equal(State.pendingApproval, null);
  assert.ok(asked.includes("dropPin"));
});

test("an unanswered card is withdrawn after 110 s, and the request stays in HQ", () => {
  request();
  seconds(109);
  assert.ok(State.pendingApproval);
  seconds(1);
  assert.equal(State.pendingApproval, null);
  assert.deepEqual(sent("approval_decision"), []);
});

test("an approval answered in HQ takes the card down", () => {
  request();
  emit("orchestrator-approval-resolved", { requestId: "orch:agent-01:a-1" });
  assert.equal(State.pendingApproval, null);
  // Nothing left for the 110 s timer to undo.
  asked = [];
  seconds(120);
  assert.deepEqual(asked, []);
});

test("a finished or failed task behind a waiting card only badges its pill", () => {
  request();
  hook("UserPromptSubmit", { prompt: "go" }, "agent-02", "t-2");
  State.setFocus(TWO);
  asked = [];
  hook("Stop", { last_assistant_message: "Done." }, "agent-02", "t-2");
  assert.equal(task(TWO).pillBadge, "finished");
  assert.ok(!asked.includes("alert:finished"));
});
