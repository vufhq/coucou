// Coucou HQ: what a conversation shows, made from the backend's tasks.
// Pure functions, no Tauri: store.ts feeds them, tests/hq.test.mjs checks them.
//
// A conversation reads oldest to newest, one block per task:
// - a chat task: what the user wrote, then the agent's reply (or why it failed);
// - a goal run: the agent's message, titled with the goal;
// - a task handed to a coworker (in its conversation): one exchange with
//   whoever asked (Mochi or a teammate), their message, what the coworker asked
//   its own teammates, and its reply;
// - a task that handed work out: the exchange (the messages, the teammates'
//   own exchanges below them, and the reports) goes before the reply;
// - then whatever is happening now: the live line, approvals, the question.

import { ACTIVE, type OrchAgent, type OrchApproval, type OrchTask } from "../core/orchestrator";
import { t } from "../i18n/i18n";
import type { ExchangeMessage, ThreadItem } from "./types";

/** How much of the conversation goes with a new task: the newest turns, up to this. */
export const CONTEXT_CHARS = 6_000;
const TURN_CHARS = 1_200;
/** A time separator goes in when more than this passed between two messages. */
export const TIME_GAP_MS = 60 * 60 * 1000;

export interface ThreadInput {
  /** The agent whose conversation this is. */
  agentId: string;
  /** The chief (Mochi), who hands work out; null when there is none. */
  chiefId: string | null;
  /** The agent's own tasks (chat, delegated, goal), in any order. */
  tasks: readonly OrchTask[];
  /** Delegated tasks by the task that handed them out (parentTaskId). */
  children?: ReadonlyMap<string, readonly OrchTask[]>;
  /** Every pending approval; only this agent's are kept. */
  approvals?: readonly OrchApproval[];
  /** The latest line of a running task, from its events. */
  lines?: ReadonlyMap<string, string>;
  /** Goal titles by goal id. */
  goalTitles?: ReadonlyMap<string, string>;
  /** An agent's name, for "Waiting for Ada…". */
  nameOf?: (agentId: string) => string;
}

/** Statuses whose task is still going but needs no live line (a card says why). */
const SHOWN_ELSEWHERE = new Set(["waiting_for_approval", "waiting_for_answer"]);
/** Statuses where the agent is busy with something. */
const BUSY = new Set(["queued", "starting", "running", "waiting_for_agents"]);

const byCreated = (a: OrchTask, b: OrchTask) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

/** What a finished (or stuck) delegated task says back: its summary, its error, or its question. */
function reportText(task: OrchTask): string | null {
  if (task.result?.summary) return task.result.summary;
  if (task.error?.message) return task.error.message;
  if (task.question?.text) return task.question.text;
  if (task.status === "cancelled") return t("Cancelled");
  return null;
}

const byAt = (a: { at: string }, b: { at: string }) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1);

/** The questions `task` asked `askerId` on the way and the answers it got. */
function answeredMessages(task: OrchTask, askerId: string): ExchangeMessage[] {
  return (task.answers ?? []).flatMap((item) => [
    { fromAgentId: task.agentId, toAgentId: askerId, text: item.question.text, at: item.askedAt ?? task.createdAt, taskId: task.id },
    { fromAgentId: askerId, toAgentId: task.agentId, text: item.answer, at: item.answeredAt ?? task.createdAt, taskId: task.id },
  ]);
}

/**
 * What `fromAgentId` said to each agent it asked (`kids`) and their reports,
 * with what those agents asked their own teammates in between, in time order.
 * `withAgentIds` is everyone asked, at any depth.
 */
function exchangeOf(
  fromAgentId: string,
  kids: readonly OrchTask[],
  children: ReadonlyMap<string, readonly OrchTask[]> | undefined,
  seen = new Set<string>(),
): { withAgentIds: string[]; messages: ExchangeMessage[] } {
  const withAgentIds: string[] = [];
  const messages: ExchangeMessage[] = [];
  const add = (id: string) => {
    if (!withAgentIds.includes(id)) withAgentIds.push(id);
  };
  for (const kid of [...kids].sort(byCreated)) {
    if (seen.has(kid.id)) continue;
    seen.add(kid.id);
    add(kid.agentId);
    messages.push({ fromAgentId, toAgentId: kid.agentId, text: kid.prompt, at: kid.createdAt, taskId: kid.id });
    messages.push(...answeredMessages(kid, fromAgentId));
    const below = exchangeOf(kid.agentId, children?.get(kid.id) ?? [], children, seen);
    below.withAgentIds.forEach(add);
    messages.push(...below.messages);
    const report = reportText(kid);
    if (report) messages.push({ fromAgentId: kid.agentId, toAgentId: fromAgentId, text: report, at: kid.updatedAt, taskId: kid.id });
  }
  messages.sort(byAt);
  return { withAgentIds, messages };
}

/** Who handed `task` out: the owner of its parent when that is a delegated task too, else Mochi. */
function askerOf(task: OrchTask, input: ThreadInput): string {
  for (const kids of input.children?.values() ?? []) {
    const parent = kids.find((other) => other.id === task.parentTaskId);
    if (parent) return parent.agentId;
  }
  return input.chiefId ?? "";
}

/** The agent's reply to a task, or null while it has none. */
function replyOf(task: OrchTask, markdown: (text: string) => string): ThreadItem | null {
  const base = { key: `a:${task.id}`, taskId: task.id, agentId: task.agentId, at: task.updatedAt };
  if (task.result?.summary || (task.status === "succeeded" && task.result)) {
    return { kind: "agent", ...base, markdown: markdown(task.result?.summary ?? ""), artifacts: task.result?.artifacts ?? [], failed: false };
  }
  if (task.status === "failed" || task.error) {
    const message = task.error?.message ?? "";
    return { kind: "agent", ...base, markdown: markdown(t("Couldn't finish: {message}", { message })), artifacts: [], failed: true };
  }
  if (task.status === "cancelled") {
    return { kind: "agent", ...base, markdown: markdown(t("Cancelled")), artifacts: [], failed: false };
  }
  return null;
}

/** The live line of a running task: its latest step, else what it waits for. */
function liveLine(task: OrchTask, input: ThreadInput, kids: readonly OrchTask[]): string {
  const line = input.lines?.get(task.id);
  if (task.status === "paused") return t("Paused");
  if (task.status === "waiting_for_agents") {
    const nameOf = input.nameOf ?? ((id: string) => id);
    const names = [...new Set(kids.filter((k) => ACTIVE.has(k.status)).map((k) => nameOf(k.agentId)))];
    return names.length ? t("Waiting for {names}…", { names: names.join(", ") }) : t("Waiting for agents");
  }
  if (line) return line;
  return task.status === "queued" || task.status === "starting" ? t("Starting…") : t("Working…");
}

/** The agent's conversation, oldest first. */
export function buildThread(input: ThreadInput): ThreadItem[] {
  const items: ThreadItem[] = [];
  const isChief = input.chiefId !== null && input.agentId === input.chiefId;
  const approvals = (input.approvals ?? []).filter((a) => a.agentId === input.agentId);
  const placed = new Set<string>();
  const seen = new Set<string>();

  for (const task of [...input.tasks].sort(byCreated)) {
    if (task.agentId !== input.agentId || seen.has(task.id)) continue;
    seen.add(task.id);
    const kids = input.children?.get(task.id) ?? [];
    const delegated = task.source === "delegated";

    if (delegated && !isChief) {
      // The asker's message, what this coworker asked its teammates, and its reply, folded into one line.
      const asker = askerOf(task, input);
      const below = exchangeOf(task.agentId, kids, input.children);
      const messages: ExchangeMessage[] = [
        { fromAgentId: asker, toAgentId: task.agentId, text: task.prompt, at: task.createdAt, taskId: task.id },
        ...answeredMessages(task, asker),
        ...below.messages,
      ].sort(byAt);
      const report = reportText(task);
      if (report) messages.push({ fromAgentId: task.agentId, toAgentId: asker, text: report, at: task.updatedAt, taskId: task.id });
      const withAgentIds = [...new Set([asker, ...below.withAgentIds].filter(Boolean))];
      items.push({ kind: "exchange", key: `x:${task.id}`, taskId: task.id, withAgentIds, messages });
    } else {
      if (task.source !== "goal") {
        items.push({ kind: "user", key: `u:${task.id}`, taskId: task.id, text: task.prompt, at: task.createdAt });
      }
      // In time order: the questions the agent asked the user and their answers,
      // and the exchange with the agents it asked (the chief's, or a coworker's the user wrote to).
      const middle: { at: string; item: ThreadItem }[] = (task.answers ?? []).flatMap((answered, i) => {
        const askedAt = answered.askedAt ?? task.createdAt;
        const answeredAt = answered.answeredAt ?? askedAt;
        return [
          {
            at: askedAt,
            item: {
              kind: "agent", key: `aq:${task.id}:${i}`, taskId: task.id, agentId: task.agentId, at: askedAt,
              markdown: answered.question.text, artifacts: [], failed: false,
            } satisfies ThreadItem,
          },
          { at: answeredAt, item: { kind: "user", key: `ua:${task.id}:${i}`, taskId: task.id, text: answered.answer, at: answeredAt } satisfies ThreadItem },
        ];
      });
      if (kids.length) {
        const { withAgentIds, messages } = exchangeOf(task.agentId, kids, input.children);
        middle.push({
          at: messages[0]?.at ?? task.createdAt,
          item: { kind: "exchange", key: `x:${task.id}`, taskId: task.id, withAgentIds, messages },
        });
      }
      items.push(...middle.sort(byAt).map((entry) => entry.item));
      const goalTitle = task.source === "goal"
        ? (task.goalId && input.goalTitles?.get(task.goalId)) || firstLine(task.prompt)
        : null;
      const reply = replyOf(task, (text) => (goalTitle ? `**${t("Goal: {title}", { title: goalTitle })}**\n\n${text}` : text));
      if (reply) items.push(reply);
    }

    if (ACTIVE.has(task.status) && !SHOWN_ELSEWHERE.has(task.status)) {
      items.push({ kind: "live", key: `l:${task.id}`, taskId: task.id, line: liveLine(task, input, kids) });
    }
    for (const approval of approvals) {
      if (approval.taskId !== task.id) continue;
      items.push({ kind: "approval", key: `p:${approval.id}`, approval });
      placed.add(approval.id);
    }
    // A delegated task's question is the chief's to answer, not the user's.
    if (!delegated && task.question && task.status === "waiting_for_answer") {
      items.push({
        kind: "question",
        key: `q:${task.id}:${task.question.id}`,
        taskId: task.id,
        questionId: task.question.id,
        text: task.question.text,
        options: task.question.options ?? [],
      });
    }
  }
  // Approvals of tasks not in the conversation (older than what was loaded) still show.
  for (const approval of approvals) {
    if (!placed.has(approval.id)) items.push({ kind: "approval", key: `p:${approval.id}`, approval });
  }
  return withTimes(items);
}

/** When a message was written, for the time separators. */
function itemTime(item: ThreadItem): { first: string; last: string } | null {
  switch (item.kind) {
    case "user":
    case "agent":
      return { first: item.at, last: item.at };
    case "exchange":
      return item.messages.length ? { first: item.messages[0].at, last: item.messages.at(-1)!.at } : null;
    default:
      return null;
  }
}

/** Puts a time separator before the first message, and before any written more than an hour after the last. */
export function withTimes(items: readonly ThreadItem[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  let previous: number | null = null;
  for (const item of items) {
    const at = itemTime(item);
    if (at) {
      const first = Date.parse(at.first);
      if (!Number.isNaN(first) && (previous === null || first - previous > TIME_GAP_MS)) {
        out.push({ kind: "time", key: `t:${item.key}`, at: at.first });
      }
      const last = Date.parse(at.last);
      if (!Number.isNaN(last)) previous = Math.max(previous ?? last, last);
    }
    out.push(item);
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** Markdown down to one plain line, for the sidebar. */
export function oneLine(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last message of a conversation, on one line. "" when there is none. */
export function threadPreview(items: readonly ThreadItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    switch (item.kind) {
      case "user":
        return oneLine(item.text);
      case "agent":
        return oneLine(item.markdown);
      case "question":
        return oneLine(item.text);
      case "exchange":
        if (item.messages.length) return oneLine(item.messages.at(-1)!.text);
        break;
    }
  }
  return "";
}

/** The question the user is asked in this conversation, the newest one, or null. */
export function pendingQuestion(items: readonly ThreadItem[]): Extract<ThreadItem, { kind: "question" }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "question") return item;
  }
  return null;
}

/** An approval or a question waits for the user. */
export function needsUser(items: readonly ThreadItem[]): boolean {
  return items.some((item) => item.kind === "approval" || item.kind === "question");
}

/** The agent is busy: its computer says so, or one of its tasks is going. */
export function isWorking(agent: Pick<OrchAgent, "status"> | undefined, tasks: readonly OrchTask[]): boolean {
  return agent?.status === "busy" || tasks.some((task) => BUSY.has(task.status));
}

/**
 * The newest turns of the conversation, as plain text, for the model (never shown):
 * its own earlier answers are "You (agent)". Newest kept first when it is too long.
 */
export function conversationContext(items: readonly ThreadItem[], limit = CONTEXT_CHARS): string {
  const lines: string[] = [];
  let size = 0;
  for (const item of [...items].reverse()) {
    let line: string;
    if (item.kind === "user") line = `User: ${clip(item.text)}`;
    else if (item.kind === "agent") line = `You (agent): ${clip(item.markdown)}`;
    else continue;
    if (size + line.length > limit) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

const clip = (text: string) => (text.length > TURN_CHARS ? `${text.slice(0, TURN_CHARS)}…` : text);

/** Delegated tasks grouped by the task that handed them out. */
export function groupChildren(tasks: readonly OrchTask[]): Map<string, OrchTask[]> {
  const out = new Map<string, OrchTask[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const list = out.get(task.parentTaskId) ?? [];
    if (!list.some((other) => other.id === task.id)) list.push(task);
    out.set(task.parentTaskId, list);
  }
  return out;
}
