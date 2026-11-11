// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import {
  HOST_OS, availablePills, orderPills, pillDefinition, sanitizeDeclared, toggleDeclared,
  type HostOs, type PillDefinition,
} from "./pills";
import type { ProviderId } from "./providers";
import type { Bindings } from "./shortcuts";
import { DEFAULT_OUTFIT, type Outfit } from "../mochi/wardrobe";
import { DEFAULT_CHARACTER, DEFAULT_TOFU_COLOR } from "../mochi/character";
import { pillColor } from "./pill-colors";
import { Spotify, musicPlaying } from "./spotify";

export type AgentSource = "n8n" | "agent";
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
  /** The task's summary after Stop, one line; cleared when a new task starts. */
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

/** An orchestrator agent's approval request, on the island's card. */
export interface ApprovalInfo {
  requestId: string;
  /** `orch:<taskId>`: the task that asked. */
  sessionId: string;
  /** The agent's pill. */
  pillId: string;
  tool: string;
  command: string;
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
  /** Declared catalog pills (at most 4), in the order they were added. */
  activeIntegrations: string[];
  /** "primary", "cursor", or `at:<x>,<y>` for one display (logical origin). */
  screen: string;
  autostart: boolean;
  /** Claude model used by the chat. */
  model: string;
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
  screen: "primary",
  autostart: false,
  model: "claude-opus-5",
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
    return musicPlaying(Spotify.state, this.declared);
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
    t.pillBadge = null;
    this.notify();
  }

  /**
   * An approval card comes up: its pill comes to the front, and the pill that
   * was there is remembered.
   */
  beginApproval(info: ApprovalInfo) {
    this.pendingApproval = info;
    this.isPinned = true;
    if (this.focusBeforeApproval == null) this.focusBeforeApproval = this.focusId;
    this.setFocus(info.pillId);
  }

  /**
   * The card has its answer, or is withdrawn: the task carries on, and the
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

  /** The declared catalog pills, once the setting has been checked. */
  get declared(): string[] {
    return sanitizeDeclared(this.settings.activeIntegrations, this.os);
  }

  /**
   * True for a pill that stays when its task ends: the agents' and the
   * declared ones go back to idle instead of going away.
   */
  isKept(id: string): boolean {
    if (this.tasks.some((t) => t.id === id && t.orchestrator)) return true;
    return this.declared.includes(id);
  }

  /**
   * The orchestrator's agents, as pills that stay: one per agent, before the
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
    const orderedAgents = sorted
      .map((a) => this.tasks.find((task) => task.orchestrator?.agentId === a.agentId))
      .filter((task): task is AgentTask => Boolean(task));
    this.tasks = [...orderedAgents, ...orderPills(this.tasks.filter((task) => !task.orchestrator))];
    if (!hadAgents && this.chatAgent == null) {
      this.chatAgent = sorted.find((agent) => agent.kind === "chief")?.agentId ?? null;
    }
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? null;
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
   * Loads the catalog pills: the declared ones, and none of the others — a
   * pill that is busy stays until it is done. Safe to call any number of times.
   */
  loadIntegrationTasks() {
    const declared = this.declared;
    this.settings.activeIntegrations = declared;
    for (const def of availablePills(this.os)) {
      const shouldLoad = declared.includes(def.id);
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
    this.tasks = orderPills(this.tasks);
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = this.tasks[0]?.id ?? null;
    this.notify();
  }

  /**
   * A task is over. The agents' and declared pills are put back as they were;
   * any other pill goes away.
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
      this.notify();
      return;
    }
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? null;
    this.notify();
  }

  /**
   * The pill of an agent whose event came before the backend's agent list:
   * made with its id and a colour, and named once the list arrives. No-op if
   * it exists.
   */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    this.tasks.unshift({ id, name, color, state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: false });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  /** Declares or undeclares a catalog pill (max 4). */
  toggleIntegration(id: string) {
    const next = toggleDeclared(this.declared, id, this.os);
    if (!next) return;
    this.settings.activeIntegrations = next;
    if (!next.includes(id) && this.focusId === id) this.focusId = null;
    this.loadIntegrationTasks();
  }

  /**
   * What the island opens on. A card waiting for an answer comes first, so
   * reopening a folded island shows it again.
   */
  defaultView(): IslandViewName {
    if (this.pendingApproval) return "approval";
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
