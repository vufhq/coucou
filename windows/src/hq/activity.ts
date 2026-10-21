// Coucou HQ: Activity, the middle pane that lists every agent's tasks, newest
// first (rakazo's runs list). Chips filter by what the task is doing, a box by
// its prompt and its agent; a click opens that agent's conversation. It reads
// the tasks from the store when it opens, then again (debounced) when the store
// changes, only while it is on screen.

import type { OrchAgent, OrchTask, TaskStatus } from "../core/orchestrator";
import { OrchestratorBridge, statusLabel } from "../core/orchestrator";
import { language, N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "../views/dom";
import { agentAvatar, avatarSignature } from "./avatar";
import type { HqStore } from "./types";

const AVATAR_SIZE = 28;
const PAGE = 100;
const DEBOUNCE_MS = 500;
const SEARCH_GLYPH = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3 20 20";

// ── Pure helpers (tested in tests/hq.test.mjs) ───────────────────────────────

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(language(), options).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

/** A row's time: "4:10 PM" today, "Yesterday", "Mon" within a week, else "Oct 3" (with the year when not this one). */
export function rowTime(at: string | null, now = new Date()): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return format(date, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return t("Yesterday");
  if (days < 7) return format(date, { weekday: "short" });
  if (date.getFullYear() === now.getFullYear()) return format(date, { month: "short", day: "numeric" });
  return format(date, { year: "numeric", month: "short", day: "numeric" });
}

export type ActivityFilter = "all" | "working" | "waiting" | "needs" | "failed" | "done";

export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: N_("All") },
  { id: "working", label: N_("Working") },
  { id: "waiting", label: N_("Waiting") },
  { id: "needs", label: N_("Needs you") },
  { id: "failed", label: N_("Failed") },
  { id: "done", label: N_("Done") },
];

const WORKING: ReadonlySet<TaskStatus> = new Set(["starting", "running"]);
const WAITING: ReadonlySet<TaskStatus> = new Set(["queued", "paused", "waiting_for_agents"]);
const DONE: ReadonlySet<TaskStatus> = new Set(["succeeded", "cancelled"]);

/** The task waits for the user's click: an approval, or a question in a task Mochi didn't hand out. */
export function taskNeedsYou(task: Pick<OrchTask, "status" | "source">): boolean {
  return task.status === "waiting_for_approval" || (task.status === "waiting_for_answer" && task.source !== "delegated");
}

export function inFilter(task: Pick<OrchTask, "status" | "source">, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "working":
      return WORKING.has(task.status);
    case "waiting":
      return WAITING.has(task.status);
    case "needs":
      return taskNeedsYou(task);
    case "failed":
      return task.status === "failed";
    case "done":
      return DONE.has(task.status);
  }
}

/** The search box: the prompt or the agent's name holds every word typed. */
export function matchesQuery(task: Pick<OrchTask, "prompt">, agentName: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${task.prompt}\n${agentName}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The prompt on one line. */
function firstLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Tone = "working" | "waiting" | "needs" | "failed" | "done";

function toneOf(task: OrchTask): Tone {
  if (taskNeedsYou(task)) return "needs";
  if (task.status === "failed") return "failed";
  if (WORKING.has(task.status)) return "working";
  if (DONE.has(task.status)) return "done";
  return "waiting";
}

// ── The view ──────────────────────────────────────────────────────────────────

export function mountActivity(root: HTMLElement, store: HqStore): void {
  let filter: ActivityFilter = "all";
  let query = "";
  let tasks: OrchTask[] | null = null;
  let error: string | null = null;
  let shownCount = PAGE;
  let open = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  // Goal titles, fetched per agent while Activity is open ("Goal: Weekly report").
  const goalTitles = new Map<string, string>();
  const goalsMissing = new Set<string>();

  // Avatars are live canvases: kept between renders while their look holds.
  const avatars = new Map<string, { sig: string; el: HTMLElement }>();
  let used = new Set<string>();

  function avatarFor(task: OrchTask, agent: OrchAgent): HTMLElement {
    const opts = { working: WORKING.has(task.status), star: agent.kind === "chief" };
    const sig = avatarSignature(agent, AVATAR_SIZE, opts);
    used.add(task.id);
    const kept = avatars.get(task.id);
    if (kept && kept.sig === sig) return kept.el;
    const el = agentAvatar(agent, AVATAR_SIZE, opts);
    avatars.set(task.id, { sig, el });
    return el;
  }

  // ── Header, chips and search ──

  const header = h("header", { class: "hq-act-header" }, h("h1", { class: "hq-act-title", text: tl("Activity") }));

  const chips = h("div", { class: "hq-act-chips", role: "toolbar", "aria-label": tl("Activity") });

  const searchInput = h("input", {
    class: "hq-act-search-input",
    type: "search",
    placeholder: tl("Search tasks"),
    "aria-label": tl("Search tasks"),
    spellcheck: "false",
  }) as HTMLInputElement;
  const search = h("label", { class: "hq-act-search" }, svg(SEARCH_GLYPH, 14, { stroke: 1.8 }), searchInput);
  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim();
    shownCount = PAGE;
    render();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !searchInput.value) return;
    e.stopPropagation();
    searchInput.value = "";
    query = "";
    render();
  });

  const tools = h("div", { class: "hq-act-tools" }, chips, search);
  const list = h("div", { class: "hq-act-list hq-scroll" });
  root.append(header, tools, list);

  function drawChips(counts: Map<ActivityFilter, number>) {
    clear(chips);
    for (const f of ACTIVITY_FILTERS) {
      const count = counts.get(f.id) ?? 0;
      const chip = h("button", {
        type: "button",
        class: f.id === filter ? "hq-act-chip on" : "hq-act-chip",
        "aria-pressed": f.id === filter,
      }, h("span", { text: t(f.label) }));
      if (f.id !== "all" && count) chip.append(h("span", { class: "hq-act-count", text: String(count) }));
      chip.addEventListener("click", () => {
        filter = f.id;
        shownCount = PAGE;
        list.scrollTop = 0;
        render();
      });
      chips.append(chip);
    }
  }

  // ── Rows ──

  function row(task: OrchTask, agent: OrchAgent, chief: OrchAgent | undefined): HTMLElement {
    const goal = task.source === "goal" && task.goalId ? goalTitles.get(task.goalId) : undefined;
    const text = goal ? t("Goal: {title}", { title: goal }) : firstLine(task.prompt);
    const head = h("span", { class: "hq-act-head" }, h("span", { class: "hq-act-name", text: agent.name }));
    if (task.source === "delegated" && chief && chief.id !== agent.id) {
      head.append(h("span", { class: "hq-act-from", text: t("from {name}", { name: chief.name }) }));
    }
    head.append(h("span", { class: "hq-act-time", text: rowTime(task.updatedAt) }));
    const tone = toneOf(task);
    const el = h("button", { type: "button", class: "hq-act-row", title: firstLine(task.prompt) },
      avatarFor(task, agent),
      h("span", { class: "hq-act-text" },
        head,
        h("span", { class: "hq-act-line" },
          h("span", { class: "hq-act-prompt", text }),
          h("span", { class: `hq-act-status ${tone}`, text: statusLabel(task.status) }),
        ),
      ),
    );
    el.addEventListener("click", () => store.select(agent.id));
    return el;
  }

  function note(text: string): HTMLElement {
    return h("div", { class: "hq-act-note", role: "status", text });
  }

  function render() {
    used = new Set();
    const snap = store.snapshot();
    const byId = new Map(snap.agents.map((a) => [a.id, a]));
    const chief = snap.agents.find((a) => a.kind === "chief");
    const known = (tasks ?? []).filter((task) => byId.has(task.agentId));

    const counts = new Map<ActivityFilter, number>();
    for (const task of known) {
      for (const f of ACTIVITY_FILTERS) if (inFilter(task, f.id)) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
    }
    drawChips(counts);

    const scroll = list.scrollTop;
    clear(list);
    if (error && !tasks) {
      const retry = h("button", { type: "button", class: "hq-btn", text: t("Retry") });
      retry.addEventListener("click", () => void load());
      list.append(h("div", { class: "hq-act-error", role: "alert" }, h("div", { text: error }), retry));
    } else if (!tasks) {
      list.append(note(t("Loading…")));
    } else {
      const hits = known.filter((task) =>
        inFilter(task, filter) && matchesQuery(task, byId.get(task.agentId)!.name, query));
      if (!known.length) list.append(note(t("No tasks yet.")));
      else if (!hits.length) list.append(note(t("No tasks match.")));
      for (const task of hits.slice(0, shownCount)) list.append(row(task, byId.get(task.agentId)!, chief));
      if (hits.length > shownCount) {
        const more = h("button", { type: "button", class: "hq-btn hq-act-more", text: t("Show more") });
        more.addEventListener("click", () => {
          shownCount += PAGE;
          render();
        });
        list.append(more);
      }
      if (error) list.prepend(h("div", { class: "hq-act-error inline", role: "alert", text: error }));
    }
    list.scrollTop = scroll;

    // Forget the avatars no longer shown; main.ts prunes their canvases.
    for (const key of avatars.keys()) if (!used.has(key)) avatars.delete(key);
  }

  // ── Data ──

  async function load() {
    const mine = ++generation;
    if (!tasks) {
      error = null;
      render();
    }
    try {
      const next = await store.activity();
      if (mine !== generation) return;
      tasks = next;
      error = null;
    } catch (err) {
      if (mine !== generation) return;
      error = String(err);
    }
    if (!open) return;
    render();
    void loadGoalTitles(mine);
  }

  /** Asks each agent with an unnamed goal run for its goals, once per open. */
  async function loadGoalTitles(mine: number) {
    const agentIds = new Set<string>();
    for (const task of tasks ?? []) {
      if (task.source === "goal" && task.goalId && !goalTitles.has(task.goalId) && !goalsMissing.has(task.goalId)) {
        agentIds.add(task.agentId);
      }
    }
    if (!agentIds.size) return;
    const results = await Promise.allSettled([...agentIds].map((id) => OrchestratorBridge.goals(id)));
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const goal of r.value.goals ?? []) goalTitles.set(goal.id, goal.title);
    }
    // Goals that are gone keep their prompt; don't ask again for them.
    for (const task of tasks ?? []) {
      if (task.source === "goal" && task.goalId && agentIds.has(task.agentId) && !goalTitles.has(task.goalId)) {
        goalsMissing.add(task.goalId);
      }
    }
    if (open && mine === generation) render();
  }

  function schedule() {
    if (document.visibilityState !== "visible") {
      dirty = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (open) void load();
    }, DEBOUNCE_MS);
  }

  function onStore() {
    const isOpen = store.snapshot().view === "activity";
    if (!isOpen) {
      open = false;
      dirty = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!open) {
      open = true;
      goalTitles.clear();
      goalsMissing.clear();
      shownCount = PAGE;
      list.scrollTop = 0;
      void load();
      return;
    }
    // Names and faces follow the store at once; the tasks after the debounce.
    render();
    schedule();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !open || !dirty) return;
    dirty = false;
    schedule();
  });

  store.subscribe(onStore);
  onStore();
}
