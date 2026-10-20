// Chatting with an orchestrator agent in the island's chat, as you would with
// a ChatGPT dot: each message becomes a task for that agent, what it does
// shows as it goes, and its final answer comes back as a reply. The earlier
// turns travel with each task as background, so a follow-up makes sense.
//
// Kept outside the chat view: an answer that arrives while the chat is closed
// is still there when it opens.

import { onEvent } from "../core/bridge";
import { OrchestratorBridge, newTaskKey, type OrchEvent, type OrchTask } from "../core/orchestrator";
import { State, type AgentQuestion, type ChatMessage } from "../core/state";
import { t } from "../i18n/i18n";

/** How much of the conversation goes with a task: the newest turns, up to this. */
const CONTEXT_CHARS = 6_000;
const TURN_CHARS = 1_200;

let nextId = 1;
const revisions = new Map<string, number>();
const loading = new Map<string, Promise<void>>();

function changed(agentId: string) {
  revisions.set(agentId, (revisions.get(agentId) ?? 0) + 1);
}

export function agentHistory(agentId: string): ChatMessage[] {
  let history = State.agentChats.get(agentId);
  if (!history) {
    history = [];
    State.agentChats.set(agentId, history);
  }
  return history;
}

/** The newest turns of the conversation, as plain text, newest kept first when it is too long. */
export function conversationContext(history: readonly ChatMessage[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const m of [...history].reverse()) {
    const text = m.content.length > TURN_CHARS ? `${m.content.slice(0, TURN_CHARS)}…` : m.content;
    // Written for the model, never shown: its own earlier answers are "You (agent)".
    const line = `${m.role === "user" ? "User" : "You (agent)"}: ${text}`;
    if (size + line.length > CONTEXT_CHARS) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

function reply(agentId: string, content: string) {
  agentHistory(agentId).push({ id: nextId++, role: "assistant", content });
  changed(agentId);
}

function rebuilt(tasks: OrchTask[]): { messages: ChatMessage[]; question: AgentQuestion | null } {
  const messages: ChatMessage[] = [];
  let question: AgentQuestion | null = null;
  // GET /api/tasks is newest first; chat reads oldest to newest.
  for (const task of [...tasks].reverse()) {
    messages.push({ id: nextId++, role: "user", content: task.prompt });
    if (task.result?.summary) {
      messages.push({ id: nextId++, role: "assistant", content: task.result.summary });
    } else if (task.error?.message) {
      messages.push({ id: nextId++, role: "assistant", content: task.error.message });
    } else if (task.question) {
      messages.push({ id: nextId++, role: "assistant", content: task.question.text });
      question = {
        taskId: task.id,
        questionId: task.question.id,
        text: task.question.text,
        options: task.question.options ?? [],
      };
    }
  }
  return { messages, question };
}

/** Rebuilds one persistent dot's conversation from the backend. */
export function loadAgentHistory(agentId: string, force = false): Promise<void> {
  if (!force && loading.has(agentId)) return loading.get(agentId)!;
  const revision = revisions.get(agentId) ?? 0;
  let request: Promise<void>;
  request = OrchestratorBridge.chatHistory(agentId)
    .then(({ tasks }) => {
      // Do not erase a turn that arrived while this request was in flight.
      if ((revisions.get(agentId) ?? 0) !== revision) return;
      const history = rebuilt(tasks ?? []);
      State.agentChats.set(agentId, history.messages);
      if (history.question) State.agentQuestions.set(agentId, history.question);
      else State.agentQuestions.delete(agentId);
      State.notify();
    })
    .catch(() => {})
    .finally(() => {
      if (loading.get(agentId) === request) loading.delete(agentId);
    });
  loading.set(agentId, request);
  return request;
}

/** Sends a message to an agent: a task for it, with the conversation so far. */
export async function sendToAgent(agentId: string, text: string): Promise<void> {
  const question = State.agentQuestions.get(agentId);
  if (question) {
    await answerAgentQuestion(agentId, text);
    return;
  }
  const history = agentHistory(agentId);
  const context = conversationContext(history);
  history.push({ id: nextId++, role: "user", content: text });
  changed(agentId);
  State.agentRuns.set(agentId, { taskId: null, line: t("Starting…") });
  State.notify();
  try {
    const created = await OrchestratorBridge.submit(text, newTaskKey(), null, agentId, context || null, "chat");
    const run = State.agentRuns.get(agentId);
    if (run && created?.task) run.taskId = created.task.id;
  } catch (err) {
    State.agentRuns.delete(agentId);
    reply(agentId, t("Couldn't send it: {error}", { error: String(err).replace(/^Error:\s*/, "") }));
  }
  State.notify();
}

/** A typed reply or an explicitly clicked quick reply answers the pending question. */
export async function answerAgentQuestion(agentId: string, answer: string): Promise<void> {
  const pending = State.agentQuestions.get(agentId);
  const text = answer.trim();
  if (!pending || !text) return;
  agentHistory(agentId).push({ id: nextId++, role: "user", content: text });
  changed(agentId);
  State.agentRuns.set(agentId, { taskId: pending.taskId, line: t("Working…") });
  State.notify();
  try {
    await OrchestratorBridge.answer(pending.taskId, pending.questionId, text);
    if (State.agentQuestions.get(agentId)?.questionId === pending.questionId) {
      State.agentQuestions.delete(agentId);
    }
    const pill = State.tasks.find((task) => task.orchestrator?.agentId === agentId);
    if (pill) {
      pill.state = "working";
      pill.pillBadge = null;
    }
  } catch (err) {
    State.agentRuns.delete(agentId);
    reply(agentId, t("Couldn't send it: {error}", { error: String(err).replace(/^Error:\s*/, "") }));
  }
  State.notify();
}

function pillState(agentId: string, state: "idle" | "working" | "question") {
  const pill = State.tasks.find((task) => task.orchestrator?.agentId === agentId);
  if (!pill) return;
  pill.state = state;
  pill.pillBadge = state === "question" && State.focusId !== pill.id ? "approval" : null;
}

/** What the agent's task did, as the chat shows it. Exported for the tests. */
export function onAgentEvent(e: OrchEvent) {
  if (e.type === "goal.checkin") {
    const title = typeof e.payload.title === "string" ? e.payload.title : "";
    const summary = typeof e.payload.summary === "string" ? e.payload.summary : "";
    reply(e.agentId, `${t("Goal: {title}", { title })}\n\n${summary}`);
    State.notify();
    return;
  }
  if (!e.taskId) return;
  const p = e.payload;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (e.type === "task.question") {
    const question = str(p.question);
    const questionId = str(p.questionId);
    if (!question || !questionId) return;
    reply(e.agentId, question);
    State.agentQuestions.set(e.agentId, {
      taskId: e.taskId,
      questionId,
      text: question,
      options: Array.isArray(p.options) ? p.options.map(String) : [],
    });
    const run = State.agentRuns.get(e.agentId);
    if (run) run.line = t("Waiting for your answer");
    pillState(e.agentId, "question");
    State.notify();
    return;
  }
  if (e.type === "task.answered") {
    const pending = State.agentQuestions.get(e.agentId);
    if (!pending || pending.questionId === str(p.questionId)) State.agentQuestions.delete(e.agentId);
    const run = State.agentRuns.get(e.agentId);
    if (run) run.line = t("Working…");
    pillState(e.agentId, "working");
    State.notify();
    return;
  }
  if (e.type === "task.paused") {
    const run = State.agentRuns.get(e.agentId);
    if (run) run.line = t("Paused");
    pillState(e.agentId, "idle");
    State.notify();
    return;
  }
  if (e.type === "task.resumed") {
    const run = State.agentRuns.get(e.agentId);
    if (run) run.line = t("Working…");
    pillState(e.agentId, "working");
    State.notify();
    return;
  }
  const entry = [...State.agentRuns.entries()].find(([, run]) => run.taskId === e.taskId);
  if (!entry) return;
  const [agentId, run] = entry;
  switch (e.type) {
    case "task.started":
      run.line = t("Working…");
      break;
    case "tool.started":
      run.line = str(p.target) || t("Working…");
      break;
    case "approval.requested":
      run.line = t("Waiting for your approval: {target}", { target: str(p.target) });
      break;
    case "approval.resolved":
      run.line = t("Working…");
      break;
    case "task.completed": {
      State.agentRuns.delete(agentId);
      const files = Array.isArray(p.artifacts) ? p.artifacts.map(String) : [];
      const list = files.length ? `\n\n${t("Files: {list}", { list: files.map((f) => `\`${f}\``).join(", ") })}` : "";
      reply(agentId, `${str(p.summary)}${list}`);
      break;
    }
    case "task.failed":
      State.agentRuns.delete(agentId);
      reply(agentId, t("Couldn't finish: {message}", { message: str(p.message) }));
      break;
    case "task.cancelled":
      State.agentRuns.delete(agentId);
      reply(agentId, t("Cancelled"));
      break;
    default:
      return;
  }
  State.notify();
}

export function registerAgentChat() {
  void onEvent<OrchEvent>("orchestrator-event", onAgentEvent);
  void onEvent<{ agentId: string; state: "idle" | "working" | "question" }>(
    "orchestrator-task-state",
    ({ agentId, state }) => {
      pillState(agentId, state);
      State.notify();
    },
  );
}
