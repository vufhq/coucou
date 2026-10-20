// The orchestrator in the island and the Tasks page: its events arrive as the
// hook payloads src-tauri/src/orchestrator.rs makes of them, its approval card
// is answered by the backend (not a relay), and the page's timeline reads them.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { eventLine, modelLabel, newTaskKey, statusLabel } from "../src/core/orchestrator.ts";

const AGENT = "agent_agent-01";

let asked;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  setView: (view) => asked.push(`setView:${view}`),
  reveal: () => asked.push("reveal"),
  dropPin: () => asked.push("dropPin"),
};
registerHookHandlers(island);

/** Exactly what orchestrator.rs emits for each backend event. */
const hook = (name, extra = {}) =>
  emit("hook", { hook_event_name: name, coucou_agent: "agent-01", session_id: "orch:t-1", ...extra });
const task = () => State.tasks.find((t) => t.id === AGENT);

beforeEach(() => {
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
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

test("a running orchestrator task gets its own pill, its steps and its final line", () => {
  hook("UserPromptSubmit", { prompt: "Summarise the httpx install docs" });
  assert.equal(task().state, "thinking");
  hook("PreToolUse", { tool_name: "WebFetch", tool_input: { query: "Open the install docs" } });
  assert.equal(task().state, "working");
  assert.match(task().steps.at(-1), /Open the install docs/);
  hook("Stop", { last_assistant_message: "Saved the steps to report.md." });
  assert.equal(task().state, "finished");
  assert.equal(task().finalLine, "Saved the steps to report.md.");
});

test("its approval card comes up, and Allow goes back with the backend's request id", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  hook("PermissionRequest", {
    request_id: "orch:agent-01:a-9",
    tool_name: "browser.navigate",
    tool_input: { command: "https://www.python-httpx.org/" },
  });
  assert.equal(State.pendingApproval?.requestId, "orch:agent-01:a-9");
  assert.equal(State.pendingApproval?.command, "browser.navigate · https://www.python-httpx.org/");
  assert.deepEqual(sent("approval_decline"), []);
  assert.ok(asked.includes("alert:approval"));
});

test("an agent outside the orchestrator still cannot raise a card it cannot be answered on", () => {
  emit("hook", { hook_event_name: "PermissionRequest", request_id: "r1", coucou_agent: "agent-01", tool_name: "Bash" });
  assert.equal(State.pendingApproval, null);
  assert.deepEqual(sent("approval_decline"), [{ requestId: "r1" }]);
});

test("the card goes when the approval is answered on the Tasks page", () => {
  hook("PermissionRequest", { request_id: "orch:agent-01:a-9", tool_name: "fs.write_artifact", tool_input: { command: "report.md" } });
  assert.ok(State.pendingApproval);
  emit("orchestrator-approval-resolved", { requestId: "orch:agent-01:other" });
  assert.ok(State.pendingApproval, "another approval leaves this card alone");
  emit("orchestrator-approval-resolved", { requestId: "orch:agent-01:a-9" });
  assert.equal(State.pendingApproval, null);
});

test("a cancelled task takes its pill away", () => {
  hook("UserPromptSubmit", { prompt: "go" });
  assert.ok(task());
  hook("SessionEnd");
  assert.equal(task(), undefined);
});

test("the Tasks page timeline reads each event, and leaves out the noise", () => {
  const e = (type, payload = {}) => ({ seq: 1, taskId: "t-1", agentId: "agent-01", type, timestamp: "", payload });
  assert.equal(eventLine(e("tool.started", { op: "browser.navigate", target: "Open the docs" })), "▸ Open the docs");
  assert.equal(eventLine(e("tool.completed", { ok: false, summary: "timed out" })), "✗ timed out");
  assert.equal(eventLine(e("artifact.created", { path: "report.md" })), "＋ report.md");
  assert.equal(eventLine(e("approval.resolved", { decision: "reject" })), "Rejected");
  assert.equal(eventLine(e("task.failed", { message: "the task ran out of time" })), "Failed · the task ran out of time");
  assert.equal(eventLine(e("tool.output", { text: "…" })), null);
  assert.equal(eventLine(e("agent.heartbeat")), null);
  assert.equal(statusLabel("waiting_for_approval"), "Waiting for approval");
  assert.equal(statusLabel("succeeded"), "Done");
});

test("the Tasks page names a model by the subscription it runs on", () => {
  assert.equal(modelLabel("claude-cli"), "Claude");
  assert.equal(modelLabel("cursor-cli"), "Cursor");
  assert.equal(modelLabel("local-llm"), "local-llm");
});

test("every new task gets its own idempotency key, in the backend's alphabet", () => {
  const a = newTaskKey();
  const b = newTaskKey();
  assert.notEqual(a, b);
  for (const k of [a, b]) assert.match(k, /^[A-Za-z0-9_-]{8,64}$/);
});
