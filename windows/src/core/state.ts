// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import {
  DEFAULT_MAIN_PILL, HOST_OS, availablePills, orderPills, pillDefinition, sanitizeDeclared,
  toggleDeclared, type HostOs, type PillDefinition,
} from "./pills";
import type { CodexPlanUsage, PlanUsage } from "./plan";
import type { ProviderId } from "./providers";
import type { FileDiff } from "./diff";
import type { Bindings } from "./shortcuts";
import { DEFAULT_OUTFIT, type Outfit } from "../mochi/wardrobe";
import { DEFAULT_CHARACTER, DEFAULT_TOFU_COLOR } from "../mochi/character";
import { pillColor } from "./pill-colors";
import { Spotify, musicPlaying } from "./spotify";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  /**
   * Position of the newest step in the whole session. `steps` is capped, so
   * `stepIndex` stops moving once it is full; this keeps counting.
   */
  stepSeq?: number;
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Claude Code's session, so "Open terminal" can find the window it runs in. */
  sessionId?: string | null;
  /** Claude's final message after Stop, one line; cleared when a new turn starts. */
  finalLine?: string | null;
  /**
   * An agent of the orchestrator backend: its pill stays in the island while
   * the backend is on, between tasks too (like a ChatGPT dot), instead of
   * going away when a session ends.
   */
  orchestrator?: OrchestratorPill | null;
}

export interface OrchestratorPill {
  agentId: string;
  kind: "chief" | "coworker";
  role: string | null;
  outfit: Outfit | null;
  teamId: string | null;
  teamName: string | null;
  teamOrder: number | null;
  order: number;
  computerId: string;
  status: "offline" | "starting" | "ready" | "busy" | "error";
  /** What is wrong with its computer, as codes (AgentProblem). */
  problems: string[];
  paused: boolean;
  limits: { tasksPerDay: number; stepsPerDay: number };
  usage: { tasksToday: number; stepsToday: number };
  /** The last task's final line, kept once the pill is back to rest. */
  last: string | null;
}

/** One agent as the backend lists it, with the colour it is painted with. */
export interface OrchestratorAgentInfo {
  agentId: string;
  name: string;
  color: string;
  kind: OrchestratorPill["kind"];
  role: string | null;
  outfit: Outfit | null;
  teamId: string | null;
  teamName: string | null;
  teamOrder: number | null;
  order: number;
  computerId: string;
  status: OrchestratorPill["status"];
  problems: string[];
  paused: boolean;
  limits: OrchestratorPill["limits"];
  usage: OrchestratorPill["usage"];
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** The pill the request belongs to: VS Code's or Cursor's (Claude Code), or an agent's (Codex…). */
  pillId: string;
  tool: string;
  command: string;
  /** Set when Claude Code is asking a question rather than for a permission. */
  questions?: AskedQuestion[];
}

/** One question of an AskUserQuestion call. */
export interface AskedQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export interface AgentQuestion {
  taskId: string;
  questionId: string;
  text: string;
  options: string[];
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

/** A fresh, idle task for a catalog pill, in the colour the user gave it if any. */
function taskFor(def: PillDefinition, colors: unknown, name = def.name): AgentTask {
  return {
    id: def.id, name, color: pillColor(def.id, def.color, colors), state: "idle", stepIndex: 0, steps: [],
    source: def.source, isIntegration: true,
  };
}

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Hovering the island opens it all the way (off: hovering only peeks). */
  openOnHover: boolean;
  /** Date and time in the middle of the compact island. */
  showClock: boolean;
  absenceInterval: number;
  /** Declared pills next to the main one (at most 4), in the order they were added. */
  activeIntegrations: string[];
  /** The always-on workspace pill: VS Code, Cursor, Codex or Antigravity. */
  mainPill: string;
  /** "primary", "cursor", or `at:<x>,<y>` for one display (logical origin). */
  screen: string;
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Show the Claude plan pill (5 h and weekly limits) in the island's header. */
  showPlanInNotch: boolean;
  /** Coucou's status line relay is installed in Claude Code's settings. */
  planRelayInstalled: boolean;
  /** Show the Codex plan pill in the island's header. */
  showCodexPlanInNotch: boolean;
  /** Who the chat talks to (see core/providers.ts); picked in the chat view. */
  chatProvider: ProviderId;
  /** The model picked for each provider other than Anthropic, by provider id. */
  chatModels: Record<string, string>;
  /** Model server addresses once connected; empty means not connected. */
  ollamaUrl: string;
  lmstudioUrl: string;
  customUrl: string;
  /** Global shortcuts the user changed, by action id (see core/shortcuts.ts). */
  shortcuts: Bindings;
  /**
   * Mochi's outfit: "auto" (dresses for the season), "none" or an outfit id.
   * Same raw values as the Mac's "mochiOutfit"; read it through parseOutfit.
   */
  mochiOutfit: string;
  /**
   * Who Coucou draws: "mochi" (the default) or "tofu", and Tofu's colour, a
   * name from its palette. Read them through mochi/character.ts.
   */
  character: string;
  tofuColor: string;
  /**
   * A colour of the user's own for a pill's Mochi, by pill ID ("#RRGGBB").
   * Empty means the catalog's colours; read it through core/pill-colors.ts.
   * Same key and values as the Mac's "pillColors".
   */
  pillColors: Record<string, string>;
  /**
   * Interface language: "" follows the system (when Coucou has its language,
   * else English), or one of src/i18n's ten codes ("fr", "pt-BR", "zh-Hans"…).
   */
  language: string;
  /**
   * The phone link for Coucou for Android is on. Rust owns it (only the switch in
   * Settings → Android phone turns it on): whatever the page sends back is ignored.
   */
  phoneLink?: boolean;
  /** The phone may chat through this computer's API keys. Rust owns it too. */
  phoneChat?: boolean;
  /** The phone may see session details (steps, last line, folder name, colour). Rust owns it too. */
  phoneDetails?: boolean;
  /** Which models the phone may use, "provider/model". Rust owns it too. */
  phoneChatModels?: string[];
  /** Mochi on the desktop. Rust owns it: whatever the page sends back is ignored. */
  desktopMochi?: {
    onDesktop: boolean;
    spot: { x: number; y: number; space: string } | null;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  openOnHover: false,
  showClock: false,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  mainPill: DEFAULT_MAIN_PILL,
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  showPlanInNotch: false,
  planRelayInstalled: false,
  showCodexPlanInNotch: false,
  chatProvider: "anthropic",
  chatModels: {},
  ollamaUrl: "",
  lmstudioUrl: "",
  customUrl: "",
  shortcuts: {},
  mochiOutfit: DEFAULT_OUTFIT,
  character: DEFAULT_CHARACTER,
  tofuColor: DEFAULT_TOFU_COLOR,
  pillColors: {},
  language: "",
};

type Listener = () => void;

/** Live diffs kept per pill (oldest dropped first) — same cap as macOS. */
export const MAX_DIFFS_PER_PILL = 50;
/** A pill's diffs are forgotten after an hour without a new one, as on macOS. */
export const DIFF_TTL_MS = 3_600_000;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  /** The orchestrator agent the chat talks to (its id), or null for the chosen model. */
  chatAgent: string | null = null;
  /** Each agent's conversation, kept apart from the model chat's. */
  agentChats = new Map<string, ChatMessage[]>();
  /** The pending question in each agent chat; a typed message or chip answers it. */
  agentQuestions = new Map<string, AgentQuestion>();
  /** An agent's task started from the chat and not finished: what it is doing now. */
  agentRuns = new Map<string, { taskId: string | null; line: string }>();
  pendingApproval: ApprovalInfo | null = null;
  /** The pill that was in front when the card came up; it comes back after. */
  focusBeforeApproval: string | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Claude's 5 h / weekly limits, from the status line (null until the first call). */
  planUsage: PlanUsage | null = null;
  /** Codex's limits, from `codex app-server` (null until it has answered). */
  codexPlanUsage: CodexPlanUsage | null = null;
  /** A plan card is open in place of the overview's left card. */
  showingPlanDetail = false;
  /** Which one: the Codex card rather than Claude's. */
  planDetailIsCodex = false;
  /** Per-pill file diffs, in order of reception. Steps carry their ids. */
  sessionDiffs = new Map<string, FileDiff[]>();
  private sessionDiffTimers = new Map<string, number>();
  /** Never reset, so an id can never point at a newer diff than the one tapped. */
  private nextDiffId = 0;
  /** Ctrl+↑ / Ctrl+↓: the highlighted row of the card's list (AppState.cardSelection). */
  cardSelection: number | null = null;
  /** Rows in the list on screen, 0 when there is none (AppState.cardItemCount). */
  cardItemCount = 0;
  /**
   * Mochi is out of the island — on the desktop, flying, or being dragged
   * there — so the island's own Mochi is hidden (AppState.mochiOnDesktop).
   */
  mochiOnDesktop = false;

  /** Outfit shown on Mochi while the pointer rests on a wardrobe button. */
  wardrobePreview: Outfit | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  /** Which pills this build offers depends on it (Claude Desktop is Windows only). */
  os: HostOs = HOST_OS;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** Spotify plays on a declared pill: Mochi dances (Linux; never on Windows yet). */
  get spotifyPlaying(): boolean {
    return musicPlaying(Spotify.state, sanitizeDeclared(this.settings, this.os).activeIntegrations);
  }

  /** How long the conversation on show is: an agent's when the chat talks to one, its run counting as a line. */
  get chatLength(): number {
    const agent = this.chatAgent;
    if (agent && this.tasks.some((t) => t.orchestrator?.agentId === agent)) {
      return (this.agentChats.get(agent)?.length ?? 0) + (this.agentRuns.has(agent) ? 1 : 0);
    }
    return this.chatHistory.length;
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    this.showingPlanDetail = false;
    t.pillBadge = null;
    this.notify();
  }

  /**
   * A permission card or a question comes up: its pill comes to the front, and
   * the pill that was there is remembered (HookServer.focusBeforeApproval).
   */
  beginApproval(info: ApprovalInfo) {
    this.pendingApproval = info;
    this.isPinned = true;
    if (this.focusBeforeApproval == null) this.focusBeforeApproval = this.focusId;
    this.setFocus(info.pillId);
  }

  /**
   * The card has its answer, or is withdrawn: the session carries on, and the
   * pill you were on comes back — unless you moved to another one meanwhile.
   */
  endApproval() {
    const req = this.pendingApproval;
    if (!req) return;
    this.pendingApproval = null;
    this.isPinned = false;
    this.updateTask(req.pillId, "working");
    this.setPillBadge(req.pillId, null);
    const previous = this.focusBeforeApproval;
    this.focusBeforeApproval = null;
    if (previous && this.focusId === req.pillId && this.tasks.some((t) => t.id === previous)) {
      this.focusId = previous;
    }
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const newest = t.stepSeq ?? t.steps.length - 1;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepSeq = newest + 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Stores a diff for a pill and returns its id (for the ticker step). */
  appendSessionDiff(pillId: string, diff: FileDiff): number {
    const id = this.nextDiffId++;
    const list = this.sessionDiffs.get(pillId) ?? [];
    list.push({ ...diff, id });
    while (list.length > MAX_DIFFS_PER_PILL) list.shift();
    this.sessionDiffs.set(pillId, list);
    // One timer per pill, re-armed on every diff — nothing polls.
    const prev = this.sessionDiffTimers.get(pillId);
    if (prev != null) window.clearTimeout(prev);
    this.sessionDiffTimers.set(
      pillId,
      window.setTimeout(() => this.clearSessionDiffs(pillId), DIFF_TTL_MS),
    );
    return id;
  }

  findDiff(pillId: string, id: number): FileDiff | null {
    return this.sessionDiffs.get(pillId)?.find((d) => d.id === id) ?? null;
  }

  clearSessionDiffs(pillId: string) {
    const timer = this.sessionDiffTimers.get(pillId);
    if (timer != null) window.clearTimeout(timer);
    this.sessionDiffTimers.delete(pillId);
    this.sessionDiffs.delete(pillId);
  }

  /** The always-on workspace pill, once the setting has been checked. */
  get mainPillId(): string {
    return sanitizeDeclared(this.settings, this.os).mainPill;
  }

  /**
   * True for a pill that stays when its session ends: the main pill and the
   * declared ones go back to idle instead of going away.
   */
  isKept(id: string): boolean {
    const d = sanitizeDeclared(this.settings, this.os);
    if (this.tasks.some((t) => t.id === id && t.orchestrator)) return true;
    return id === d.mainPill || d.activeIntegrations.includes(id);
  }

  /**
   * The orchestrator's agents, as pills that stay: one per agent, after the
   * catalog pills, named and coloured as the user chose. An agent the backend
   * no longer lists loses its pill once it is at rest; null (orchestrator
   * switched off) takes them all away the same way.
   */
  syncOrchestratorAgents(agents: OrchestratorAgentInfo[] | null) {
    const hadAgents = this.tasks.some((t) => t.orchestrator);
    const sorted = [...(agents ?? [])].sort((a, b) =>
      Number(b.kind === "chief") - Number(a.kind === "chief") ||
      (a.teamOrder ?? Number.MAX_SAFE_INTEGER) - (b.teamOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.order - b.order ||
      a.name.localeCompare(b.name) ||
      a.agentId.localeCompare(b.agentId),
    );
    const want = new Map(sorted.map((a) => [`agent_${a.agentId}`, a]));
    this.tasks = this.tasks.filter((t) => {
      if (!t.orchestrator || want.has(t.id)) return true;
      t.orchestrator = null;
      return t.state !== "idle" || t.steps.length > 0;
    });
    for (const [id, a] of want) {
      let t = this.tasks.find((x) => x.id === id);
      if (!t) {
        t = { id, name: a.name, color: a.color, state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false };
        this.tasks.push(t);
      }
      t.name = a.name;
      t.color = a.color;
      t.orchestrator = {
        agentId: a.agentId,
        kind: a.kind,
        role: a.role,
        outfit: a.outfit,
        teamId: a.teamId,
        teamName: a.teamName,
        teamOrder: a.teamOrder,
        order: a.order,
        computerId: a.computerId,
        status: a.status,
        problems: a.problems,
        paused: a.paused,
        limits: a.limits,
        usage: a.usage,
        last: t.orchestrator?.last ?? null,
      };
    }
    this.tasks = orderPills(this.tasks, this.mainPillId);
    const orderedAgents = sorted
      .map((a) => this.tasks.find((task) => task.orchestrator?.agentId === a.agentId))
      .filter((task): task is AgentTask => Boolean(task));
    this.tasks = [...this.tasks.filter((task) => !task.orchestrator), ...orderedAgents];
    if (!hadAgents && this.chatAgent == null) {
      this.chatAgent = sorted.find((agent) => agent.kind === "chief")?.agentId ?? null;
    }
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? this.mainPillId;
    this.notify();
  }

  /** The backend cannot be reached: its agents' pills stay, dimmed. */
  markOrchestratorOffline() {
    let changed = false;
    for (const t of this.tasks) {
      if (t.orchestrator && t.orchestrator.status !== "offline") {
        t.orchestrator.status = "offline";
        t.orchestrator.problems = [];
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /**
   * Loads the catalog pills: the main pill always, the declared ones, and none
   * of the others — a pill that is mid-session stays until its session ends.
   * Safe to call any number of times. AppState.loadIntegrationTasks on macOS.
   */
  loadIntegrationTasks() {
    const d = sanitizeDeclared(this.settings, this.os);
    this.settings.mainPill = d.mainPill;
    this.settings.activeIntegrations = d.activeIntegrations;
    for (const def of availablePills(this.os)) {
      const shouldLoad = def.id === d.mainPill || d.activeIntegrations.includes(def.id);
      const idx = this.tasks.findIndex((t) => t.id === def.id);
      if (shouldLoad && idx < 0) this.tasks.push(taskFor(def, this.settings.pillColors));
      const busy = idx >= 0 && (this.tasks[idx].state !== "idle" || this.tasks[idx].steps.length > 0);
      if (!shouldLoad && idx >= 0 && !busy) this.tasks.splice(idx, 1);
    }
    // A colour picked in Settings reaches the pills that are already up.
    for (const t of this.tasks) {
      const def = pillDefinition(t.id);
      if (def) t.color = pillColor(def.id, def.color, this.settings.pillColors);
    }
    this.tasks = orderPills(this.tasks, d.mainPill);
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = d.mainPill;
    this.notify();
  }

  /**
   * A session is over. The main and declared pills are put back as they were;
   * any other pill goes away (AppState.removeTask on macOS).
   */
  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (this.isKept(id)) {
      const t = this.tasks[idx];
      // An agent's pill remembers how its last task ended.
      if (t.orchestrator && t.finalLine) t.orchestrator.last = t.finalLine;
      t.state = "idle";
      t.steps = [];
      t.stepIndex = 0;
      delete t.stepSeq;
      t.pillBadge = null;
      t.finalLine = null;
      const def = pillDefinition(id);
      if (def) t.name = def.name;
      this.clearSessionDiffs(id);
      this.notify();
      return;
    }
    this.tasks.splice(idx, 1);
    this.clearSessionDiffs(id);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? this.mainPillId;
    this.notify();
  }

  /**
   * Creates the pill of a tagged agent on its first event; no-op if it exists.
   * Inserted right after the main pill so it is in the visible slice(0,4). A
   * catalog agent wears its catalog colour, as on macOS.
   */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const def = pillDefinition(id);
    this.insertAfterMain({
      id, name, color: def ? pillColor(def.id, def.color, this.settings.pillColors) : color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
  }

  /**
   * The pill a Claude Code session belongs to (VS Code or Cursor). It is made
   * for the session when it is neither the main pill nor declared, as
   * upsertWorkspaceTask does on macOS.
   */
  upsertWorkspacePill(id: string, name: string, cwd: string): AgentTask | null {
    let t = this.tasks.find((x) => x.id === id);
    if (!t) {
      const def = pillDefinition(id);
      if (!def) return null;
      t = taskFor(def, this.settings.pillColors, name);
      this.insertAfterMain(t);
    }
    t.name = name;
    if (cwd) t.sessionCwd = cwd;
    return t;
  }

  private insertAfterMain(t: AgentTask) {
    const at = this.tasks.findIndex((x) => x.id === this.mainPillId) + 1;
    this.tasks.splice(at, 0, t);
    if (!this.focusId) this.focusId = t.id;
    this.notify();
  }

  /** Declares or undeclares a pill (max 4 next to the main one). */
  toggleIntegration(id: string) {
    const next = toggleDeclared(sanitizeDeclared(this.settings, this.os), id, this.os);
    if (!next) return;
    this.settings.activeIntegrations = next;
    if (!next.includes(id) && this.focusId === id) this.focusId = this.mainPillId;
    this.loadIntegrationTasks();
  }

  /**
   * What the island opens on. A card waiting for an answer comes first, so
   * reopening a folded island shows it again (Mac #117, #290).
   */
  defaultView(): IslandViewName {
    if (this.pendingApproval) return this.pendingApproval.questions ? "question" : "approval";
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
