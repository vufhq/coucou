// Coucou HQ: the conversations model.ts makes of the backend's tasks, and the
// store that loads them, live-updates them and sends what the user types.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, internals, sent } from "./tauri.mjs";
import {
  buildThread,
  conversationContext,
  groupChildren,
  isWorking,
  needsUser,
  oneLine,
  pendingQuestion,
  threadPreview,
  withTimes,
} from "../src/hq/model.ts";
import { createHqStore } from "../src/hq/store.ts";

const CHIEF = "mochi";
const ADA = "ada";
const LINUS = "linus";

let seq = 0;
/** A task as GET /api/tasks lists it. */
function task(extra = {}) {
  seq += 1;
  return {
    id: `t-${seq}`,
    agentId: CHIEF,
    prompt: "Hello",
    modelProfileId: "claude-cli",
    status: "succeeded",
    steps: 1,
    result: { summary: "Hi!", artifacts: [] },
    error: null,
    source: "chat",
    parentTaskId: null,
    goalId: null,
    question: null,
    waitingReason: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:01:00.000Z",
    ...extra,
  };
}

const kinds = (items) => items.map((i) => i.kind);
const keys = (items) => items.map((i) => i.key);

// ── model.ts ────────────────────────────────────────────────────────────────

test("a chat task is the user's message, then the agent's reply with its files", () => {
  const a = task({ prompt: "Write the report", result: { summary: "**Done**", artifacts: ["report.md"] } });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [a] });
  assert.deepEqual(kinds(items), ["time", "user", "agent"]);
  assert.equal(items[1].text, "Write the report");
  assert.equal(items[2].markdown, "**Done**");
  assert.deepEqual(items[2].artifacts, ["report.md"]);
  assert.equal(items[2].failed, false);
  assert.equal(items[2].agentId, CHIEF);
});

test("a failed chat task ends on its failure", () => {
  const a = task({ status: "failed", result: null, error: { reason: "timeout", message: "it ran out of time" } });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [a] });
  const reply = items.at(-1);
  assert.equal(reply.kind, "agent");
  assert.equal(reply.failed, true);
  assert.match(reply.markdown, /it ran out of time/);
});

test("the conversation reads oldest first, whatever order the backend lists it in", () => {
  const first = task({ prompt: "one", createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:30Z" });
  const second = task({ prompt: "two", createdAt: "2026-10-20T10:05:00Z", updatedAt: "2026-10-20T10:05:30Z" });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [second, first] });
  assert.deepEqual(items.filter((i) => i.kind === "user").map((i) => i.text), ["one", "two"]);
});

test("Mochi's task that handed work out gets one exchange, before his reply", () => {
  const parent = task({ prompt: "Build me a site", result: { summary: "The site is up.", artifacts: [] },
    createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:30:00Z" });
  const toAda = task({ agentId: ADA, source: "delegated", parentTaskId: parent.id, prompt: "Design the page",
    result: { summary: "Here is the design.", artifacts: [] },
    createdAt: "2026-10-20T10:01:00Z", updatedAt: "2026-10-20T10:10:00Z" });
  const toLinus = task({ agentId: LINUS, source: "delegated", parentTaskId: parent.id, prompt: "Deploy it",
    status: "failed", result: null, error: { reason: "x", message: "no server" },
    createdAt: "2026-10-20T10:02:00Z", updatedAt: "2026-10-20T10:05:00Z" });
  const children = groupChildren([toAda, toLinus]);
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [parent], children });
  assert.deepEqual(kinds(items), ["time", "user", "exchange", "agent"]);
  const exchange = items[2];
  assert.equal(exchange.key, `x:${parent.id}`);
  assert.deepEqual(exchange.withAgentIds, [ADA, LINUS]);
  assert.deepEqual(exchange.messages.map((m) => [m.fromAgentId, m.toAgentId, m.text]), [
    [CHIEF, ADA, "Design the page"],
    [CHIEF, LINUS, "Deploy it"],
    [LINUS, CHIEF, "no server"],
    [ADA, CHIEF, "Here is the design."],
  ]);
  assert.equal(items[3].markdown, "The site is up.");
});

test("a coworker's delegated task is one exchange with Mochi: his message and the reply", () => {
  const job = task({ agentId: ADA, source: "delegated", parentTaskId: "t-parent", prompt: "Design the page",
    result: { summary: "Here is the design.", artifacts: [] } });
  const items = buildThread({ agentId: ADA, chiefId: CHIEF, tasks: [job] });
  assert.deepEqual(kinds(items), ["time", "exchange"]);
  assert.deepEqual(items[1].withAgentIds, [CHIEF]);
  assert.deepEqual(items[1].messages.map((m) => [m.fromAgentId, m.toAgentId, m.text]), [
    [CHIEF, ADA, "Design the page"],
    [ADA, CHIEF, "Here is the design."],
  ]);
});

test("a delegated task's question is the chief's, not the user's", () => {
  const job = task({ agentId: ADA, source: "delegated", parentTaskId: "t-parent", status: "waiting_for_answer",
    result: null, question: { id: "q1", text: "Which colour?", options: ["Red", "Blue"] } });
  const items = buildThread({ agentId: ADA, chiefId: CHIEF, tasks: [job] });
  assert.equal(items.some((i) => i.kind === "question"), false);
  assert.equal(items.find((i) => i.kind === "exchange").messages.at(-1).text, "Which colour?");
  assert.equal(needsUser(items), false);
  assert.equal(pendingQuestion(items), null);
});

test("a question in a task the user started waits for the user, with its options", () => {
  const ask = task({ status: "waiting_for_answer", result: null, question: { id: "q1", text: "Which colour?", options: ["Red", "Blue"] } });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [ask] });
  const q = items.at(-1);
  assert.equal(q.kind, "question");
  assert.equal(q.key, `q:${ask.id}:q1`);
  assert.deepEqual(q.options, ["Red", "Blue"]);
  assert.equal(items.some((i) => i.kind === "live"), false, "the question says what it waits for");
  assert.equal(needsUser(items), true);
  assert.equal(pendingQuestion(items).questionId, "q1");
});

test("a goal run is an agent message titled with the goal", () => {
  const run = task({ source: "goal", goalId: "g1", prompt: "Check the inbox", result: { summary: "3 new mails.", artifacts: [] } });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [run], goalTitles: new Map([["g1", "Inbox zero"]]) });
  assert.deepEqual(kinds(items), ["time", "agent"]);
  assert.equal(items[1].markdown, "**Goal: Inbox zero**\n\n3 new mails.");
  const untitled = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [run] });
  assert.match(untitled.at(-1).markdown, /Goal: Check the inbox/);
});

test("a time separator goes in before the first message and after more than an hour", () => {
  const a = task({ createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:01:00Z" });
  const b = task({ createdAt: "2026-10-20T10:30:00Z", updatedAt: "2026-10-20T10:31:00Z" });
  const c = task({ createdAt: "2026-10-20T13:00:00Z", updatedAt: "2026-10-20T13:01:00Z" });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [a, b, c] });
  assert.deepEqual(kinds(items), ["time", "user", "agent", "user", "agent", "time", "user", "agent"]);
  assert.equal(items[5].at, "2026-10-20T13:00:00Z");
  assert.equal(items[5].key, `t:u:${c.id}`);
  assert.deepEqual(withTimes([]), []);
});

test("a running task shows its latest step, else Working…", () => {
  const run = task({ status: "running", result: null });
  const plain = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [run] });
  assert.deepEqual(plain.at(-1), { kind: "live", key: `l:${run.id}`, taskId: run.id, line: "Working…" });
  const stepped = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [run], lines: new Map([[run.id, "▸ Open the docs"]]) });
  assert.equal(stepped.at(-1).line, "▸ Open the docs");
  const queued = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [task({ status: "queued", result: null })] });
  assert.equal(queued.at(-1).line, "Starting…");
  const paused = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [task({ status: "paused", result: null })] });
  assert.equal(paused.at(-1).line, "Paused");
});

test("Mochi waiting for his team names who he waits for", () => {
  const parent = task({ status: "waiting_for_agents", result: null });
  const kid = task({ agentId: ADA, source: "delegated", parentTaskId: parent.id, status: "running", result: null });
  const names = { [ADA]: "Ada" };
  const items = buildThread({
    agentId: CHIEF, chiefId: CHIEF, tasks: [parent], children: groupChildren([kid]), nameOf: (id) => names[id] ?? id,
  });
  assert.equal(items.at(-1).line, "Waiting for Ada…");
});

test("approvals go under their task, other agents' are left out, and unplaced ones still show", () => {
  const run = task({ status: "waiting_for_approval", result: null });
  const mine = { id: "a1", taskId: run.id, agentId: CHIEF, op: "fs.write", target: "x.md", reason: "" };
  const orphan = { id: "a2", taskId: "t-old", agentId: CHIEF, op: "team.propose", target: "Devs", reason: "" };
  const theirs = { id: "a3", taskId: "t-other", agentId: ADA, op: "fs.write", target: "y.md", reason: "" };
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [run], approvals: [orphan, mine, theirs] });
  assert.deepEqual(keys(items).slice(1), [`u:${run.id}`, "p:a1", "p:a2"]);
  assert.equal(needsUser(items), true);
});

test("keys stay the same when the same tasks are listed again", () => {
  const parent = task({ status: "running", result: null });
  const kid = task({ agentId: ADA, source: "delegated", parentTaskId: parent.id });
  const input = { agentId: CHIEF, chiefId: CHIEF, tasks: [parent], children: groupChildren([kid]) };
  assert.deepEqual(keys(buildThread(input)), keys(buildThread({ ...input, tasks: [{ ...parent }] })));
  assert.deepEqual(keys(buildThread(input)), ["t:u:" + parent.id, `u:${parent.id}`, `x:${parent.id}`, `l:${parent.id}`]);
});

test("another agent's tasks never show in this conversation", () => {
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [task({ agentId: ADA })] });
  assert.deepEqual(items, []);
});

test("the sidebar preview is the last message, on one plain line", () => {
  const a = task({ result: { summary: "**Done**: see\n\n- [the report](report.md)", artifacts: [] } });
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [a] });
  assert.equal(threadPreview(items), "Done: see - the report");
  assert.equal(threadPreview([]), "");
  assert.equal(oneLine("a\n\n`b`   c"), "a b c");
});

test("the conversation context keeps the newest turns, within the limit", () => {
  const items = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: [
    task({ prompt: "first", result: { summary: "one", artifacts: [] }, createdAt: "2026-10-20T10:00:00Z" }),
    task({ prompt: "second", result: { summary: "two", artifacts: [] }, createdAt: "2026-10-20T10:10:00Z" }),
  ] });
  assert.equal(conversationContext(items), "User: first\nYou (agent): one\nUser: second\nYou (agent): two");
  assert.equal(conversationContext(items, 40), "User: second\nYou (agent): two");
  const long = buildThread({ agentId: CHIEF, chiefId: CHIEF, tasks: Array.from({ length: 20 }, (_, i) =>
    task({ prompt: "x".repeat(2000), createdAt: `2026-10-20T10:${String(i).padStart(2, "0")}:00Z` })) });
  assert.ok(conversationContext(long).length <= 6000);
});

test("an agent is working while its computer is busy or a task of its runs", () => {
  assert.equal(isWorking({ status: "busy" }, []), true);
  assert.equal(isWorking({ status: "ready" }, [task({ status: "running" })]), true);
  assert.equal(isWorking({ status: "ready" }, [task({ status: "waiting_for_answer" }), task()]), false);
});

// ── store.ts ────────────────────────────────────────────────────────────────

const AGENTS = [
  { id: ADA, name: "Ada", kind: "coworker", status: "ready" },
  { id: CHIEF, name: "Mochi", kind: "chief", status: "ready" },
];
let backend;
const realInvoke = internals.invoke;

/** Answers the orchestrator commands from `backend`, and records them like tauri.mjs does. */
function fakeBackend() {
  internals.invoke = async (cmd, args) => {
    if (cmd === "plugin:event|listen") return realInvoke(cmd, args);
    calls.push([cmd, args]);
    const answer = backend[cmd];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer ?? null;
  };
}

beforeEach(() => {
  calls.length = 0;
  backend = {
    orchestrator_agents: { agents: AGENTS, teams: [], computers: [], approvals: [] },
    orchestrator_chat_history: ({ agentId }) => ({ tasks: agentId === CHIEF ? [task()] : [] }),
    orchestrator_list_tasks: { tasks: [] },
  };
  fakeBackend();
});

afterEach(() => {
  internals.invoke = realInvoke;
  mock.timers.reset();
});

test("the store loads the agents, selects Mochi and loads every conversation", async () => {
  const store = createHqStore();
  await store.start();
  const snap = store.snapshot();
  assert.equal(snap.connected, true);
  assert.equal(snap.selectedId, CHIEF);
  assert.equal(store.chief()?.id, CHIEF);
  assert.deepEqual(sent("orchestrator_chat_history").map((a) => a.agentId).sort(), [ADA, CHIEF]);
  assert.ok(sent("orchestrator_list_tasks").some((a) => a.source === "delegated" && a.limit === 200));
  assert.equal(store.preview(CHIEF), "Hi!");
  assert.deepEqual(store.thread(ADA), []);
});

test("a backend that does not answer leaves the store offline, with words for the user", async () => {
  backend.orchestrator_agents = new Error("connection refused");
  backend.orchestrator_status = { prefs: { enabled: true, url: "" }, status: { state: "unreachable", error: null }, hasToken: true };
  const store = createHqStore();
  await store.start();
  assert.equal(store.snapshot().connected, false);
  assert.equal(store.snapshot().error, "The backend stopped answering.");
  backend.orchestrator_status = { prefs: { enabled: false, url: "" }, status: { state: "off", error: null }, hasToken: true };
  await store.reload();
  assert.equal(store.snapshot().error, "The orchestrator is turned off. Turn it on in Tasks.");
});

test("send starts a chat task with the conversation so far", async () => {
  const store = createHqStore();
  await store.start();
  backend.orchestrator_submit = (args) => ({ task: task({ id: "t-new", prompt: args.prompt, status: "queued", result: null }), created: true });
  await store.send(CHIEF, "  And now?  ");
  const [args] = sent("orchestrator_submit");
  assert.equal(args.prompt, "And now?");
  assert.equal(args.agentId, CHIEF);
  assert.equal(args.source, "chat");
  assert.equal(args.context, "User: Hello\nYou (agent): Hi!");
  assert.equal(store.thread(CHIEF).at(-1).kind, "live");
  assert.ok(store.thread(CHIEF).some((i) => i.key === "u:t-new"));
  assert.equal(store.working(CHIEF), true);
});

test("a message that could not go stays in the conversation, with why", async () => {
  const store = createHqStore();
  await store.start();
  backend.orchestrator_submit = new Error("backend down");
  await store.send(CHIEF, "Hello again");
  const last = store.thread(CHIEF).at(-1);
  assert.equal(last.kind, "agent");
  assert.equal(last.failed, true);
  assert.match(last.markdown, /Couldn't send it: backend down/);
});

test("send answers the pending question instead of starting a task", async () => {
  backend.orchestrator_chat_history = ({ agentId }) => ({
    tasks: agentId === CHIEF
      ? [task({ id: "t-ask", status: "waiting_for_answer", result: null, question: { id: "q1", text: "Which?", options: [] } })]
      : [],
  });
  backend.orchestrator_answer = ({ taskId }) => ({ task: task({ id: taskId, status: "running", result: null }) });
  const store = createHqStore();
  await store.start();
  assert.equal(store.needsYou(CHIEF), true);
  await store.send(CHIEF, "Blue");
  assert.deepEqual(sent("orchestrator_answer"), [{ taskId: "t-ask", questionId: "q1", answer: "Blue" }]);
  assert.deepEqual(sent("orchestrator_submit"), []);
  assert.equal(store.needsYou(CHIEF), false);
});

test("events are gathered, then only the agents they touch are fetched again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const store = createHqStore();
  await store.start();
  calls.length = 0;
  let changes = 0;
  store.subscribe(() => changes++);
  const e = (type, extra = {}) => ({ seq: 1, taskId: "t-x", agentId: ADA, type, timestamp: "", payload: {}, ...extra });
  emit("orchestrator-event", e("task.started"));
  emit("orchestrator-event", e("task.completed"));
  assert.deepEqual(sent("orchestrator_chat_history"), [], "nothing before the debounce");
  mock.timers.tick(300);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent("orchestrator_chat_history"), [{ agentId: ADA }]);
  assert.deepEqual(sent("orchestrator_agents"), [], "no agent change, no roster fetch");
  assert.ok(changes > 0);
});

test("a delegation refetches Mochi, the coworker, the roster and the exchanges", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const store = createHqStore();
  await store.start();
  calls.length = 0;
  emit("orchestrator-event", {
    seq: 2, taskId: "t-1", agentId: CHIEF, type: "agent.delegated", timestamp: "",
    payload: { toAgentId: ADA, childTaskId: "t-kid", message: "Do it" },
  });
  mock.timers.tick(300);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent("orchestrator_chat_history").map((a) => a.agentId).sort(), [ADA, CHIEF]);
  assert.equal(sent("orchestrator_agents").length, 1);
  assert.ok(sent("orchestrator_list_tasks").some((a) => a.source === "delegated"));
});

test("a step only changes the live line, without fetching", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  backend.orchestrator_chat_history = ({ agentId }) => ({
    tasks: agentId === CHIEF ? [task({ id: "t-run", status: "running", result: null })] : [],
  });
  const store = createHqStore();
  await store.start();
  calls.length = 0;
  emit("orchestrator-event", {
    seq: 3, taskId: "t-run", agentId: CHIEF, type: "tool.started", timestamp: "",
    payload: { op: "browser.navigate", target: "Open the docs" },
  });
  assert.equal(store.thread(CHIEF).at(-1).line, "▸ Open the docs");
  mock.timers.tick(300);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent("orchestrator_chat_history"), []);
});

test("an approval is decided only through decide(), and leaves the list", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const approval = { id: "a1", taskId: "t-9", agentId: CHIEF, op: "fs.write", target: "x.md", reason: "" };
  backend.orchestrator_agents = { agents: AGENTS, teams: [], computers: [], approvals: [approval] };
  const store = createHqStore();
  await store.start();
  assert.equal(store.needsYou(CHIEF), true);
  assert.deepEqual(sent("orchestrator_decide"), []);
  backend.orchestrator_agents = { agents: AGENTS, teams: [], computers: [], approvals: [] };
  await store.decide(approval, false);
  assert.deepEqual(sent("orchestrator_decide"), [{ agentId: CHIEF, approvalId: "a1", approve: false }]);
  assert.equal(store.needsYou(CHIEF), false);
});

// ── Activity and the sidebar's row times (activity.ts) ────────────────────────

const { inFilter, matchesQuery, rowTime, taskNeedsYou } = await import("../src/hq/activity.ts");

test("rowTime: the time today, Yesterday, the weekday within a week, else a short date", () => {
  const now = new Date(2026, 9, 20, 15, 0);
  const at = (d) => d.toISOString();
  assert.match(rowTime(at(new Date(2026, 9, 20, 9, 5)), now), /9:05/);
  assert.equal(rowTime(at(new Date(2026, 9, 19, 23, 0)), now), "Yesterday");
  assert.equal(rowTime(at(new Date(2026, 9, 16, 12, 0)), now), "Fri");
  assert.equal(rowTime(at(new Date(2026, 9, 3, 12, 0)), now), "Oct 3");
  assert.equal(rowTime(at(new Date(2025, 9, 3, 12, 0)), now), "Oct 3, 2025");
  assert.equal(rowTime(null, now), "");
  assert.equal(rowTime("not a date", now), "");
});

test("Activity's filters sort the statuses as the spec says", () => {
  const is = (status, source = "chat") => ({ status, source });
  assert.ok(inFilter(is("running"), "working") && inFilter(is("starting"), "working"));
  assert.ok(!inFilter(is("queued"), "working"));
  for (const s of ["queued", "paused", "waiting_for_agents"]) assert.ok(inFilter(is(s), "waiting"), s);
  assert.ok(inFilter(is("waiting_for_approval", "delegated"), "needs"));
  assert.ok(inFilter(is("waiting_for_answer"), "needs"));
  // A question in a task Mochi handed out is his to answer, not the user's.
  assert.ok(!taskNeedsYou(is("waiting_for_answer", "delegated")));
  assert.ok(inFilter(is("succeeded"), "done") && inFilter(is("cancelled"), "done"));
  assert.ok(!inFilter(is("failed"), "done") && inFilter(is("failed"), "failed"));
  assert.ok(inFilter(is("failed"), "all"));
});

test("Activity's search matches every word in the prompt or the agent's name", () => {
  const task = { prompt: "Write the weekly report" };
  assert.ok(matchesQuery(task, "Ada", ""));
  assert.ok(matchesQuery(task, "Ada", "weekly ada"));
  assert.ok(matchesQuery(task, "Ada", "REPORT"));
  assert.ok(!matchesQuery(task, "Ada", "weekly linus"));
});

// ── The conversation's niceties and the palette (conversation.ts, composer.ts, palette.ts) ──

test("workState: what the line above the composer says", async () => {
  const { workState } = await import("../src/hq/composer.ts");
  assert.equal(workState(null, false), null);
  assert.equal(workState({ status: "running" }, false), "working");
  assert.equal(workState({ status: "starting" }, true), "working");
  assert.equal(workState({ status: "queued" }, true), "computer");
  assert.equal(workState({ status: "queued" }, false), "queued");
  assert.equal(workState({ status: "waiting_for_agents" }, false), "team");
  assert.equal(workState({ status: "paused" }, false), "paused");
  // Waiting for the user: the thread's card says it.
  assert.equal(workState({ status: "waiting_for_approval" }, false), null);
  assert.equal(workState({ status: "waiting_for_answer" }, false), null);
});

test("windowStart: the last page, then stays on its first item as messages arrive", async () => {
  const { windowStart } = await import("../src/hq/conversation.ts");
  const items = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}` }));
  assert.equal(windowStart(items(10), null, 80), 0);
  assert.equal(windowStart(items(100), null, 80), 20);
  // New messages at the end do not push the first one shown off the top.
  assert.equal(windowStart(items(105), "k20", 80), 20);
  // Its first item gone: the same count from the end.
  assert.equal(windowStart(items(105), "gone", 80), 25);
});

test("palette: matches every word, any case and accents; Ctrl+K and Cmd+K only", async () => {
  const { isPaletteKey, matches } = await import("../src/hq/palette.ts");
  assert.ok(matches("", "Go to Ada"));
  assert.ok(matches("ada go", "Go to Ada"));
  assert.ok(matches("zoe", "Go to Zoé"));
  assert.ok(!matches("linus", "Go to Ada"));
  const key = (extra) => ({ key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.ok(isPaletteKey(key({ ctrlKey: true })));
  assert.ok(isPaletteKey(key({ metaKey: true, key: "K" })));
  assert.ok(!isPaletteKey(key({})));
  assert.ok(!isPaletteKey(key({ ctrlKey: true, shiftKey: true })));
});

test("side chat: everyone in order of appearance, and runs of the same author", async () => {
  const { participants, runs } = await import("../src/hq/sidechat.ts");
  const msg = (fromAgentId, toAgentId, text) => ({ fromAgentId, toAgentId, text, at: "", taskId: "t" });
  const messages = [msg(CHIEF, ADA, "a"), msg(CHIEF, LINUS, "b"), msg(LINUS, CHIEF, "c"), msg(ADA, CHIEF, "d"), msg(ADA, CHIEF, "e")];
  assert.deepEqual(participants({ withAgentIds: [ADA, LINUS], messages }), [CHIEF, ADA, LINUS]);
  // Someone asked but not yet in a message still counts.
  assert.deepEqual(participants({ withAgentIds: [CHIEF], messages: [] }), [CHIEF]);
  assert.deepEqual(runs(messages).map((r) => r.map((m) => m.text).join("")), ["ab", "c", "de"]);
});
