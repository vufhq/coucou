// The orchestrator in the island and the Tasks page: its events arrive as the
// hook payloads src-tauri/src/orchestrator.rs makes of them, its approval card
// is answered by the backend (not a relay), and the page's timeline reads them.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { agentLine, eventLine, modelLabel, newTaskKey, statusLabel } from "../src/core/orchestrator.ts";
import { miniOutfit } from "../src/mochi/minibots.ts";

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
  State.agentChats.clear();
  State.agentQuestions.clear();
  State.agentRuns.clear();
  State.chatAgent = null;
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
  assert.equal(statusLabel("waiting_for_answer"), "Waiting for answer");
  assert.equal(statusLabel("paused"), "Paused");
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

test("an agent's line says its state, then what is wrong with its computer", () => {
  assert.equal(agentLine({ id: "agent-01", name: "Agent 01", status: "ready", problems: [] }), "Ready");
  assert.equal(agentLine({ id: "agent-01", name: "Agent 01", status: "busy" }), "Busy");
  assert.equal(
    agentLine({ id: "agent-01", name: "Agent 01", status: "offline", problems: ["vm_stopped"] }),
    "Offline · Its Linux computer is not running.",
  );
  assert.equal(
    agentLine({ id: "agent-01", name: "Agent 01", status: "ready", problems: ["low_disk", "no_browser"] }),
    "Ready · Its disk is almost full. · Chromium is missing: web steps will fail.",
  );
  assert.equal(
    agentLine({ id: "agent-01", name: "Agent 01", status: "ready", paused: true, problems: ["daily_limit"] }),
    "Paused · Daily limit reached",
  );
});

// ── Agents that stay in the island, like ChatGPT's dots ──────────────────────

const agentInfo = (id, extra = {}) => ({
  agentId: id,
  name: id,
  color: "#4ADE80",
  kind: "coworker",
  role: null,
  outfit: null,
  teamId: null,
  teamName: null,
  teamOrder: null,
  order: 0,
  computerId: "agent-01",
  status: "ready",
  problems: [],
  paused: false,
  limits: { tasksPerDay: 30, stepsPerDay: 300 },
  usage: { tasksToday: 0, stepsToday: 0 },
  ...extra,
});

test("the backend's agents get pills that stay, after the catalog's", () => {
  emit("orchestrator-agents", {
    agents: [
      { id: "agent-01", name: "Scout", status: "ready", color: "#38BDF8", problems: [] },
      { id: "agent-02", name: "agent-02", status: "offline", color: null, problems: ["vm_stopped"] },
    ],
  });
  const ids = State.tasks.map((t) => t.id);
  assert.deepEqual(ids.slice(-2), ["agent_agent-01", "agent_agent-02"]);
  assert.equal(ids[0], State.settings.mainPill);
  const one = State.tasks.find((t) => t.id === "agent_agent-01");
  assert.equal(one.name, "Scout");
  assert.equal(one.color, "#38BDF8");
  assert.deepEqual(one.orchestrator, {
    agentId: "agent-01",
    kind: "chief",
    role: null,
    outfit: null,
    teamId: null,
    teamName: null,
    teamOrder: null,
    order: 0,
    computerId: "agent-01",
    status: "ready",
    problems: [],
    paused: false,
    limits: { tasksPerDay: 30, stepsPerDay: 300 },
    usage: { tasksToday: 0, stepsToday: 0 },
    last: null,
  });
  const two = State.tasks.find((t) => t.id === "agent_agent-02");
  assert.equal(two.orchestrator.status, "offline");
  assert.match(two.color, /^#[0-9A-F]{6}$/i); // the default colour for that id
});

test("a finished task leaves the agent's pill at rest, remembering how it ended", () => {
  State.syncOrchestratorAgents([agentInfo("agent-01")]);
  hook("UserPromptSubmit", { prompt: "go" });
  hook("Stop", { last_assistant_message: "Saved report.md." });
  mock.timers.tick(6_000);
  const pill = task();
  assert.ok(pill, "the pill is still there");
  assert.equal(pill.state, "idle");
  assert.deepEqual(pill.steps, []);
  assert.equal(pill.orchestrator.last, "Saved report.md.");
  hook("SessionEnd");
  assert.ok(task(), "a cancelled task does not take it away either");
});

test("an agent the backend drops goes once at rest; switching the orchestrator off takes them all", () => {
  State.syncOrchestratorAgents([agentInfo("agent-01"), agentInfo("agent-02")]);
  hook("UserPromptSubmit", { prompt: "go" });
  State.syncOrchestratorAgents([agentInfo("agent-02")]);
  assert.ok(task(), "busy: it stays until its session ends");
  assert.equal(task().orchestrator, null);
  hook("SessionEnd");
  assert.equal(task(), undefined);

  emit("orchestrator-status", { state: "unreachable", error: "x" });
  assert.equal(State.tasks.find((t) => t.id === "agent_agent-02").orchestrator.status, "offline");
  emit("orchestrator-status", { state: "off", error: null });
  assert.equal(State.tasks.some((t) => t.orchestrator), false);
});

test("renaming an agent renames its pill in place", () => {
  State.syncOrchestratorAgents([agentInfo("agent-01")]);
  State.syncOrchestratorAgents([agentInfo("agent-01", { name: "Scout", color: "#F4505E" })]);
  assert.equal(State.tasks.filter((t) => t.id === AGENT).length, 1);
  assert.equal(task().name, "Scout");
  assert.equal(task().color, "#F4505E");
});

test("the chief leads, then coworkers follow team order and their order", () => {
  State.syncOrchestratorAgents([
    agentInfo("linus", { name: "Linus", teamId: "dev", teamName: "Developers", teamOrder: 2, order: 1 }),
    agentInfo("ada", { name: "Ada", teamId: "research", teamName: "Research", teamOrder: 1, order: 3 }),
    agentInfo("grace", { name: "Grace", teamId: "research", teamName: "Research", teamOrder: 1, order: 1 }),
    agentInfo("agent-01", { name: "Mochi", kind: "chief", order: 99 }),
  ]);
  assert.deepEqual(
    State.tasks.filter((item) => item.orchestrator).map((item) => item.orchestrator.agentId),
    ["agent-01", "grace", "ada", "linus"],
  );
  assert.equal(State.chatAgent, "agent-01", "Mochi is the default chat agent");
});

test("a coworker mini selects its outfit while an undressed mini stays unchanged", () => {
  State.syncOrchestratorAgents([
    agentInfo("agent-01", { kind: "chief" }),
    agentInfo("ada", { outfit: "beanie" }),
    agentInfo("linus", { outfit: null }),
  ]);
  assert.equal(miniOutfit(State.tasks.find((item) => item.id === "agent_ada")), "beanie");
  assert.equal(miniOutfit(State.tasks.find((item) => item.id === "agent_linus")), "none");
});

// ── Chatting with an agent in the island's chat ──────────────────────────────

import { internals } from "./tauri.mjs";
import {
  agentHistory,
  conversationContext,
  loadAgentHistory,
  sendToAgent,
} from "../src/island/agent-chat.ts";

test("a message to an agent is a task for it, with the conversation so far, and its answer comes back", async () => {
  State.agentChats.clear();
  State.agentRuns.clear();
  agentHistory("agent-01").push(
    { id: 1, role: "user", content: "summarise the httpx docs" },
    { id: 2, role: "assistant", content: "Saved report.md." },
  );
  const invoke = internals.invoke;
  internals.invoke = async (cmd, args) =>
    cmd === "orchestrator_submit" ? (calls.push([cmd, args]), { task: { id: "t-9" }, created: true }) : invoke(cmd, args);
  try {
    await sendToAgent("agent-01", "now make it shorter");
  } finally {
    internals.invoke = invoke;
  }
  const [submitted] = sent("orchestrator_submit");
  assert.equal(submitted.prompt, "now make it shorter");
  assert.equal(submitted.agentId, "agent-01");
  assert.equal(submitted.source, "chat");
  assert.equal(submitted.context, "User: summarise the httpx docs\nYou (agent): Saved report.md.");
  assert.equal(State.agentRuns.get("agent-01").taskId, "t-9");

  const event = (type, payload = {}) => emit("orchestrator-event", { seq: 1, taskId: "t-9", agentId: "agent-01", type, timestamp: "", payload });
  event("tool.started", { jobId: "j", op: "fs.write_artifact", target: "Shortening report.md" });
  assert.equal(State.agentRuns.get("agent-01").line, "Shortening report.md");
  event("approval.requested", { approvalId: "a", op: "fs.write_artifact", target: "report.md", reason: "overwrite" });
  assert.match(State.agentRuns.get("agent-01").line, /report\.md/);
  event("task.completed", { summary: "Cut it to five lines.", artifacts: ["report.md"] });
  assert.equal(State.agentRuns.has("agent-01"), false);
  const last = agentHistory("agent-01").at(-1);
  assert.equal(last.role, "assistant");
  assert.match(last.content, /^Cut it to five lines\.\n\n.*`report\.md`/);
  // Another task's events change nothing here.
  emit("orchestrator-event", { seq: 2, taskId: "t-other", agentId: "agent-01", type: "task.failed", timestamp: "", payload: { reason: "timeout", message: "x" } });
  assert.equal(agentHistory("agent-01").length, 4);
});

test("a send that fails says so in the chat, and a failed task says why", async () => {
  State.agentChats.clear();
  State.agentRuns.clear();
  await sendToAgent("agent-02", "hello"); // the stand-in answers null: no task came back
  assert.equal(State.agentRuns.get("agent-02").taskId, null);
  State.agentRuns.get("agent-02").taskId = "t-1";
  emit("orchestrator-event", { seq: 3, taskId: "t-1", agentId: "agent-02", type: "task.failed", timestamp: "", payload: { reason: "rate_limited", message: "usage limit reached" } });
  assert.match(agentHistory("agent-02").at(-1).content, /usage limit reached/);
});

test("the conversation sent along keeps the newest turns, each cut short", () => {
  const long = "x".repeat(5_000);
  const history = Array.from({ length: 10 }, (_, i) => ({ id: i, role: i % 2 ? "assistant" : "user", content: `${i} ${long}` }));
  const context = conversationContext(history);
  assert.ok(context.length <= 6_000);
  assert.match(context, /^You \(agent\): 9 x+…$/m);
  assert.doesNotMatch(context, /: 0 x/);
});

test("an agent chat is rebuilt from its backend chat tasks", async () => {
  const invoke = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd !== "orchestrator_chat_history") return invoke(cmd, args);
    calls.push([cmd, args]);
    return {
      tasks: [
        {
          id: "t-3",
          prompt: "third",
          result: null,
          error: null,
          question: { id: "q-3", text: "Which audience?", options: ["Team", "Customers"] },
        },
        {
          id: "t-2",
          prompt: "second",
          result: null,
          error: { message: "could not finish" },
          question: null,
        },
        {
          id: "t-1",
          prompt: "first",
          result: { summary: "first answer" },
          error: null,
          question: null,
        },
      ],
    };
  };
  try {
    await loadAgentHistory("agent-01", true);
  } finally {
    internals.invoke = invoke;
  }
  assert.deepEqual(
    agentHistory("agent-01").map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second" },
      { role: "assistant", content: "could not finish" },
      { role: "user", content: "third" },
      { role: "assistant", content: "Which audience?" },
    ],
  );
  assert.deepEqual(State.agentQuestions.get("agent-01"), {
    taskId: "t-3",
    questionId: "q-3",
    text: "Which audience?",
    options: ["Team", "Customers"],
  });
  assert.deepEqual(sent("orchestrator_chat_history"), [{ agentId: "agent-01" }]);
});

test("a question goes into the agent chat and the next message answers it", async () => {
  State.syncOrchestratorAgents([agentInfo("agent-01")]);
  emit("orchestrator-event", {
    seq: 8,
    taskId: "t-question",
    agentId: "agent-01",
    type: "task.question",
    timestamp: "",
    payload: { questionId: "q-1", question: "Which format?", options: ["PDF", "Markdown"] },
  });
  assert.equal(task().state, "question");
  assert.equal(agentHistory("agent-01").at(-1).content, "Which format?");
  assert.deepEqual(State.agentQuestions.get("agent-01").options, ["PDF", "Markdown"]);

  const invoke = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === "orchestrator_answer") {
      calls.push([cmd, args]);
      return { task: { id: "t-question" } };
    }
    return invoke(cmd, args);
  };
  try {
    await sendToAgent("agent-01", "Markdown");
  } finally {
    internals.invoke = invoke;
  }
  assert.deepEqual(sent("orchestrator_answer"), [{
    taskId: "t-question",
    questionId: "q-1",
    answer: "Markdown",
  }]);
  assert.equal(sent("orchestrator_submit").length, 0);
  assert.equal(State.agentQuestions.has("agent-01"), false);
  assert.equal(agentHistory("agent-01").at(-1).content, "Markdown");
});

test("a goal check-in is labelled and appended to its agent chat", () => {
  emit("orchestrator-event", {
    seq: 9,
    taskId: "t-goal",
    agentId: "agent-02",
    type: "goal.checkin",
    timestamp: "",
    payload: { goalId: "g-1", title: "Watch releases", summary: "Version 2 shipped.", achieved: false },
  });
  assert.equal(agentHistory("agent-02").at(-1).content, "Goal: Watch releases\n\nVersion 2 shipped.");
});

test("delegation and reports are visible in Mochi's and the coworker's chats", () => {
  State.syncOrchestratorAgents([
    agentInfo("agent-01", { name: "Mochi", kind: "chief" }),
    agentInfo("ada", { name: "Ada" }),
  ]);
  emit("orchestrator-event", {
    seq: 10,
    taskId: "t-chief",
    agentId: "agent-01",
    type: "agent.delegated",
    timestamp: "",
    payload: { toAgentId: "ada", childTaskId: "t-child", message: "Review the API" },
  });
  assert.equal(agentHistory("agent-01").at(-1).content, "Asked Ada: Review the API");
  assert.equal(agentHistory("ada").at(-1).content, "From Mochi\n\nReview the API");

  emit("orchestrator-event", {
    seq: 11,
    taskId: "t-chief",
    agentId: "agent-01",
    type: "agent.reported",
    timestamp: "",
    payload: { fromAgentId: "ada", childTaskId: "t-child", status: "succeeded", summary: "The API is sound." },
  });
  assert.equal(agentHistory("agent-01").at(-1).content, "Ada: The API is sound.");
  assert.equal(agentHistory("ada").at(-1).content, "The API is sound.");
});

test("a delegated coworker question stays in chat without lighting its pill for the user", () => {
  State.syncOrchestratorAgents([
    agentInfo("agent-01", { name: "Mochi", kind: "chief" }),
    agentInfo("ada", { name: "Ada" }),
  ]);
  emit("orchestrator-event", {
    seq: 12,
    taskId: "t-chief-2",
    agentId: "agent-01",
    type: "agent.delegated",
    timestamp: "",
    payload: { toAgentId: "ada", childTaskId: "t-child-question", message: "Review the schema" },
  });
  emit("orchestrator-event", {
    seq: 13,
    taskId: "t-child-question",
    agentId: "ada",
    type: "task.question",
    timestamp: "",
    payload: { questionId: "q-delegated", question: "Should nullable fields be omitted?", options: ["Yes", "No"] },
  });
  const ada = State.tasks.find((item) => item.id === "agent_ada");
  assert.equal(agentHistory("ada").at(-1).content, "Should nullable fields be omitted?");
  assert.equal(State.agentQuestions.has("ada"), false);
  assert.equal(ada.state, "idle");
  assert.equal(ada.pillBadge ?? null, null);
});
