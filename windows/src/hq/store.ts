// Coucou HQ: what the window knows about Mochi and his team, kept up to date
// from the backend. The sidebar and the conversation read it through HqStore
// (types.ts) and never call the backend themselves for what is listed here.
//
// Loading: the agents first (with teams, computers and approvals), then each
// agent's conversation (its chat and delegated tasks, plus its goal runs) and
// the delegated tasks for Mochi's exchanges. After that, the backend's events
// say what changed: they are gathered for a moment, then only the agents they
// touch are fetched again. Nothing runs between events (0 % CPU hidden).

import { onEvent } from "../core/bridge";
import {
  OrchestratorBridge,
  eventLine,
  newTaskKey,
  type OrchAgent,
  type OrchApproval,
  type OrchComputer,
  type OrchEvent,
  type OrchTask,
  type OrchTeam,
} from "../core/orchestrator";
import { t } from "../i18n/i18n";
import {
  buildThread,
  conversationContext,
  groupChildren,
  isWorking,
  needsUser,
  pendingQuestion,
  threadPreview,
} from "./model";
import type { HqPanel, HqSnapshot, HqStore, HqView, ThreadItem } from "./types";

/** Events are gathered this long before anything is fetched again. */
const DEBOUNCE_MS = 250;
const DELEGATED_LIMIT = 200;
const GOAL_LIMIT = 20;

const reason = (err: unknown) => String(err).replace(/^Error:\s*/, "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function createHqStore(): HqStore {
  let connected = false;
  let error: string | null = null;
  let agents: OrchAgent[] = [];
  let teams: OrchTeam[] = [];
  let computers: OrchComputer[] = [];
  let approvals: OrchApproval[] = [];
  let selectedId: string | null = null;
  let view: HqView = "chat";
  let panel: HqPanel | null = null;
  let snap: HqSnapshot | null = null;

  /** Each agent's own tasks, as the backend last listed them. */
  const tasks = new Map<string, OrchTask[]>();
  /** Messages sent from here that the backend has not listed yet, or that failed to go. */
  const local = new Map<string, OrchTask[]>();
  /** Every delegated task, by the task that handed it out. */
  let children = new Map<string, OrchTask[]>();
  /** A delegated task's parent task, to know whose exchange it belongs to. */
  const parentOf = new Map<string, string>();
  /** The latest step of a running task. */
  const lines = new Map<string, string>();
  const goalTitles = new Map<string, string>();
  /** Built conversations; dropped when what they are made of changes. */
  const threads = new Map<string, ThreadItem[]>();
  const loading = new Map<string, Promise<void>>();
  /** Bumped by every local change, so a reply in flight does not undo it. */
  const revisions = new Map<string, number>();

  const listeners = new Set<() => void>();
  let started = false;

  // What the events asked for, until the debounce fires.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dirtyAgents = new Set<string>();
  let dirtyRoster = false;
  let dirtyDelegated = false;

  function notify() {
    snap = null;
    for (const listener of [...listeners]) listener();
  }

  function invalidate(agentId?: string) {
    if (agentId) threads.delete(agentId);
    else threads.clear();
  }

  function bump(agentId: string) {
    revisions.set(agentId, (revisions.get(agentId) ?? 0) + 1);
  }

  const chief = () => agents.find((a) => a.kind === "chief");
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  function ensureSelection() {
    if (selectedId && agents.some((a) => a.id === selectedId)) return;
    selectedId = chief()?.id ?? agents[0]?.id ?? selectedId;
  }

  /** Why the backend did not answer, in words for the user. */
  async function offlineText(): Promise<string> {
    const s = await OrchestratorBridge.status().catch(() => null);
    if (s && !s.prefs.enabled) return t("The orchestrator is turned off. Turn it on in Tasks.");
    if (s?.status.state === "noToken") return t("Start the orchestrator backend once: it creates the key Coucou needs.");
    return s?.status.error ?? t("The backend stopped answering.");
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /** The agents, teams, computers and approvals. False when the backend did not answer. */
  async function loadRoster(): Promise<boolean> {
    try {
      const data = await OrchestratorBridge.agents();
      // /api/agents also lists the pending approvals (the Tasks page reads them there).
      const raw = data as typeof data & { approvals?: OrchApproval[] | null };
      agents = data?.agents ?? [];
      teams = data?.teams ?? [];
      computers = data?.computers ?? [];
      approvals = raw?.approvals ?? [];
      connected = true;
      error = null;
      ensureSelection();
      invalidate();
      return true;
    } catch {
      connected = false;
      error = await offlineText();
      return false;
    }
  }

  /** One agent's conversation: its chat and delegated tasks, and its goal runs. */
  function loadAgent(agentId: string): Promise<void> {
    const pending = loading.get(agentId);
    if (pending) return pending;
    const revision = revisions.get(agentId) ?? 0;
    const request = Promise.all([
      OrchestratorBridge.chatHistory(agentId),
      OrchestratorBridge.listTasks({ agentId, source: "goal", limit: GOAL_LIMIT }).catch(() => ({ tasks: [] })),
    ])
      .then(async ([chat, goals]) => {
        const list = [...(chat?.tasks ?? []), ...(goals?.tasks ?? [])];
        if (list.some((task) => task.goalId && !goalTitles.has(task.goalId))) {
          const found = await OrchestratorBridge.goals(agentId).catch(() => null);
          for (const goal of found?.goals ?? []) goalTitles.set(goal.id, goal.title);
        }
        // A message sent while this was in flight is kept as it is.
        if ((revisions.get(agentId) ?? 0) !== revision) return;
        tasks.set(agentId, list);
        settleLocal(agentId);
        invalidate(agentId);
        notify();
      })
      .catch(() => {})
      .finally(() => {
        if (loading.get(agentId) === request) loading.delete(agentId);
      });
    loading.set(agentId, request);
    return request;
  }

  /** Every delegated task, for the exchanges: Mochi's, and coworkers' with their teammates. */
  async function loadDelegated(): Promise<void> {
    const data = await OrchestratorBridge.listTasks({ source: "delegated", limit: DELEGATED_LIMIT }).catch(() => null);
    if (!data) return;
    children = groupChildren(data.tasks ?? []);
    parentOf.clear();
    for (const [parent, kids] of children) for (const kid of kids) parentOf.set(kid.id, parent);
    invalidate();
    notify();
  }

  /** A sent message whose task the backend now lists is no longer kept here. */
  function settleLocal(agentId: string) {
    const mine = local.get(agentId);
    if (!mine) return;
    const known = new Set((tasks.get(agentId) ?? []).map((task) => task.id));
    const left = mine.filter((task) => !known.has(task.id));
    if (left.length) local.set(agentId, left);
    else local.delete(agentId);
  }

  async function reload(): Promise<void> {
    const ok = await loadRoster();
    notify();
    if (!ok) return;
    await Promise.all([...agents.map((a) => loadAgent(a.id)), loadDelegated()]);
  }

  // ── Live events ────────────────────────────────────────────────────────────

  /** The agent whose conversation shows a task: the owner, and Mochi for a delegated one. */
  function chiefOfTask(taskId: string | null): string | null {
    if (!taskId || !parentOf.has(taskId)) return null;
    return chief()?.id ?? null;
  }

  function onBackendEvent(e: OrchEvent) {
    const p = e.payload ?? {};
    // A step only changes the live line: no fetch for it.
    if (e.type === "tool.started" && e.taskId) {
      const line = eventLine(e);
      if (line) lines.set(e.taskId, line);
      invalidate(e.agentId);
    }
    if (e.type.startsWith("tool.") || e.type.startsWith("browser.") || e.type === "artifact.created") {
      if (!known(e.agentId, e.taskId)) dirtyAgents.add(e.agentId);
      schedule();
      return;
    }
    dirtyAgents.add(e.agentId);
    if (e.type.startsWith("agent.") || e.type.startsWith("team.") || e.type.startsWith("approval.")) dirtyRoster = true;
    if (e.type === "agent.delegated") {
      const to = str(p.toAgentId);
      if (to) dirtyAgents.add(to);
      dirtyDelegated = true;
    }
    if (e.type === "agent.reported") {
      const from = str(p.fromAgentId);
      if (from) dirtyAgents.add(from);
      dirtyDelegated = true;
    }
    const parentChief = chiefOfTask(e.taskId);
    if (parentChief || p.source === "delegated") {
      dirtyDelegated = true;
      const id = parentChief ?? chief()?.id;
      if (id) dirtyAgents.add(id);
    }
    if (e.taskId && (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled")) {
      lines.delete(e.taskId);
    }
    schedule();
  }

  function known(agentId: string, taskId: string | null): boolean {
    return Boolean(taskId && tasks.get(agentId)?.some((task) => task.id === taskId));
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  }

  async function flush() {
    timer = null;
    const ids = [...dirtyAgents];
    const roster = dirtyRoster;
    const delegated = dirtyDelegated;
    dirtyAgents.clear();
    dirtyRoster = false;
    dirtyDelegated = false;
    if (roster && !(await loadRoster())) {
      notify();
      return;
    }
    await Promise.all([
      ...ids.filter((id) => agents.some((a) => a.id === id)).map((id) => loadAgent(id)),
      delegated ? loadDelegated() : Promise.resolve(),
    ]);
    // Only a live line changed (or the roster): show it.
    notify();
  }

  // ── Building what is shown ─────────────────────────────────────────────────

  function allTasks(agentId: string): OrchTask[] {
    return [...(tasks.get(agentId) ?? []), ...(local.get(agentId) ?? [])];
  }

  function thread(agentId: string): ThreadItem[] {
    const cached = threads.get(agentId);
    if (cached) return cached;
    if (connected && !tasks.has(agentId) && !loading.has(agentId)) void loadAgent(agentId);
    const built = buildThread({
      agentId,
      chiefId: chief()?.id ?? null,
      tasks: allTasks(agentId),
      children,
      approvals,
      lines,
      goalTitles,
      nameOf,
    });
    threads.set(agentId, built);
    return built;
  }

  // ── What the user does ─────────────────────────────────────────────────────

  /** A message waiting for the backend, shown as sent. */
  function draftTask(agentId: string, text: string): OrchTask {
    const now = new Date().toISOString();
    return {
      id: `local:${newTaskKey()}`,
      agentId,
      prompt: text,
      modelProfileId: "",
      status: "queued",
      steps: 0,
      result: null,
      error: null,
      source: "chat",
      parentTaskId: null,
      goalId: null,
      question: null,
      waitingReason: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function replaceLocal(agentId: string, id: string, next: OrchTask | null) {
    const list = (local.get(agentId) ?? []).filter((task) => task.id !== id);
    if (next) list.push(next);
    if (list.length) local.set(agentId, list);
    else local.delete(agentId);
    bump(agentId);
    invalidate(agentId);
    notify();
  }

  /** Puts the backend's copy of a task in place of the one listed. */
  function upsert(task: OrchTask) {
    const list = tasks.get(task.agentId) ?? [];
    const at = list.findIndex((other) => other.id === task.id);
    if (at >= 0) list[at] = task;
    else list.unshift(task);
    tasks.set(task.agentId, list);
    bump(task.agentId);
    invalidate(task.agentId);
  }

  async function send(agentId: string, text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    const items = thread(agentId);
    const question = pendingQuestion(items);
    if (question) {
      await answer(question.taskId, question.questionId, message);
      return;
    }
    const context = conversationContext(items);
    const draft = draftTask(agentId, message);
    replaceLocal(agentId, "", draft);
    try {
      const created = await OrchestratorBridge.submit(message, newTaskKey(), null, agentId, context || null, "chat");
      if (created?.task) {
        upsert(created.task);
        replaceLocal(agentId, draft.id, null);
      }
    } catch (err) {
      const now = new Date().toISOString();
      replaceLocal(agentId, draft.id, {
        ...draft,
        status: "failed",
        error: { reason: "send", message: t("Couldn't send it: {error}", { error: reason(err) }) },
        updatedAt: now,
      });
    }
  }

  /** Rejects when the backend refused the answer. */
  async function answer(taskId: string, questionId: string, text: string): Promise<void> {
    const reply = text.trim();
    if (!reply) return;
    const res = await OrchestratorBridge.answer(taskId, questionId, reply);
    if (res?.task) upsert(res.task);
    notify();
  }

  /** Rejects when the backend refused the decision. Called only from an explicit click. */
  async function decide(approval: OrchApproval, approve: boolean): Promise<void> {
    await OrchestratorBridge.decide(approval.agentId, approval.id, approve);
    approvals = approvals.filter((a) => a.id !== approval.id);
    invalidate(approval.agentId);
    dirtyAgents.add(approval.agentId);
    dirtyRoster = true;
    notify();
    schedule();
  }

  const UNFINISHED = new Set<OrchTask["status"]>([
    "queued", "starting", "running", "waiting_for_approval", "waiting_for_answer", "waiting_for_agents", "paused",
  ]);

  const newest = (list: OrchTask[]) =>
    list.reduce<OrchTask | null>((best, task) => (!best || task.updatedAt > best.updatedAt ? task : best), null);

  async function stop(taskId: string): Promise<void> {
    const res = await OrchestratorBridge.cancel(taskId);
    if (res?.task) upsert(res.task);
    notify();
  }

  async function activity(): Promise<OrchTask[]> {
    const data = await OrchestratorBridge.tasks();
    return [...(data?.tasks ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return {
    snapshot() {
      snap ??= { connected, error, agents, teams, computers, approvals, selectedId, view, panel };
      return snap;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (!started) {
        started = true;
        void onEvent<OrchEvent>("orchestrator-event", onBackendEvent);
      }
      await reload();
    },
    async reload() {
      invalidate();
      await reload();
    },
    select(agentId) {
      if (selectedId === agentId && view === "chat") return;
      selectedId = agentId;
      view = "chat";
      if (connected && !tasks.has(agentId)) void loadAgent(agentId);
      notify();
    },
    setView(next) {
      if (view === next) return;
      view = next;
      notify();
    },
    setPanel(next) {
      if (panel === next) return;
      panel = next;
      notify();
    },
    agent: (agentId) => agents.find((a) => a.id === agentId),
    chief,
    thread,
    preview: (agentId) => threadPreview(thread(agentId)),
    needsYou: (agentId) => approvals.some((a) => a.agentId === agentId) || needsUser(thread(agentId)),
    working: (agentId) => isWorking(agents.find((a) => a.id === agentId), allTasks(agentId)),
    lastAt: (agentId) => newest(allTasks(agentId))?.updatedAt ?? null,
    current: (agentId) => newest(allTasks(agentId).filter((task) => UNFINISHED.has(task.status) && !task.id.startsWith("local:"))),
    activity,
    stop,
    send,
    answer,
    decide,
    saveFile: (agentId, taskId, path) => OrchestratorBridge.saveFile(agentId, taskId, path),
  };
}
