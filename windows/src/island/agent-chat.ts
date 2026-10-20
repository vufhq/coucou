// Chatting with an orchestrator agent in the island's chat, as you would with
// a ChatGPT dot: each message becomes a task for that agent, what it does
// shows as it goes, and its final answer comes back as a reply. The earlier
// turns travel with each task as background, so a follow-up makes sense.
//
// Kept outside the chat view: an answer that arrives while the chat is closed
// is still there when it opens.

import { onEvent } from "../core/bridge";
import { OrchestratorBridge, newTaskKey, type OrchEvent } from "../core/orchestrator";
import { State, type ChatMessage } from "../core/state";
import { t } from "../i18n/i18n";

/** How much of the conversation goes with a task: the newest turns, up to this. */
const CONTEXT_CHARS = 6_000;
const TURN_CHARS = 1_200;

let nextId = 1;

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
}

/** Sends a message to an agent: a task for it, with the conversation so far. */
export async function sendToAgent(agentId: string, text: string): Promise<void> {
  const history = agentHistory(agentId);
  const context = conversationContext(history);
  history.push({ id: nextId++, role: "user", content: text });
  State.agentRuns.set(agentId, { taskId: null, line: t("Starting…") });
  State.notify();
  try {
    const created = await OrchestratorBridge.submit(text, newTaskKey(), null, agentId, context || null);
    const run = State.agentRuns.get(agentId);
    if (run && created?.task) run.taskId = created.task.id;
  } catch (err) {
    State.agentRuns.delete(agentId);
    reply(agentId, t("Couldn't send it: {error}", { error: String(err).replace(/^Error:\s*/, "") }));
  }
  State.notify();
}

/** What the agent's task did, as the chat shows it. Exported for the tests. */
export function onAgentEvent(e: OrchEvent) {
  if (!e.taskId) return;
  const entry = [...State.agentRuns.entries()].find(([, run]) => run.taskId === e.taskId);
  if (!entry) return;
  const [agentId, run] = entry;
  const p = e.payload;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
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
}
