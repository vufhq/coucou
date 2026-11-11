// Every catalog pill the island can show: the chat's AI providers and the
// services. IDs are contract values (settings, keys in the credential store),
// so an ID here never changes once shipped. The orchestrator's agents have
// pills too, made from the backend's list (State.syncOrchestratorAgents).
//
// `support` says where a pill works, and `connect` what makes it "connected":
// a key in the OS credential store, a model server, or nothing at all.

import type { AgentSource } from "./state";
import { N_ } from "../i18n/i18n";

export type PillCategory = "ai" | "service";

/** Section titles (English keys, shown with `t()`), in display order. */
export const PILL_CATEGORIES: { id: PillCategory; title: string }[] = [
  { id: "ai", title: N_("AI for the chat") },
  { id: "service", title: N_("Services") },
];

/**
 * Whether the pill does anything on this build:
 * - `yes`: works on Windows and Linux;
 * - `windows`: Windows only (the app behind it has no Linux build);
 * - `linux`: Linux only (what drives it is Linux's);
 * - `soon`: can be declared, shows "Coming soon" (macOS has it, this build not yet);
 * - `no`: macOS only, never offered here.
 */
export type PillSupport = "yes" | "windows" | "linux" | "soon" | "no";

/** What makes the pill connected. */
export type PillConnect =
  /** A key in the credential store. */
  | { kind: "key"; key: string }
  /** A model server the chat is connected to (Settings → Local models). */
  | { kind: "server"; field: "ollamaUrl" | "lmstudioUrl" }
  /** Nothing to set up. */
  | { kind: "none" };

export interface PillDefinition {
  id: string;
  name: string;
  color: string;
  category: PillCategory;
  /** Label next to the pill name in the idle card header (an English key, shown with `t()`). */
  subtitle: string;
  source: AgentSource;
  support: PillSupport;
  connect: PillConnect;
}

export type HostOs = "windows" | "linux";

const key = (k: string): PillConnect => ({ kind: "key", key: k });
const none: PillConnect = { kind: "none" };
const server = (field: "ollamaUrl" | "lmstudioUrl"): PillConnect => ({ kind: "server", field });

/** ChatProvider.accentHex on macOS. */
const ACCENT = {
  anthropic: "#E07950",
  google: "#4285F4",
  openai: "#10A37F",
  ollama: "#FACC15",
  lmstudio: "#A3E635",
};

export const PILL_CATALOG: readonly PillDefinition[] = [
  // ── AI for the chat ────────────────────────────────────────────────────────
  { id: "ai_anthropic", name: "Anthropic", color: ACCENT.anthropic, category: "ai",
    subtitle: N_("Chat"), source: "n8n", support: "yes", connect: key("anthropic-api-key") },
  // The chat talks to each of them (src-tauri/src/chat.rs): a key for the
  // cloud ones, a connected server for the local ones.
  { id: "ai_google", name: "Google AI", color: ACCENT.google, category: "ai",
    subtitle: N_("Chat"), source: "n8n", support: "yes", connect: key("google-api-key") },
  { id: "ai_openai", name: "OpenAI", color: ACCENT.openai, category: "ai",
    subtitle: N_("Chat"), source: "n8n", support: "yes", connect: key("openai-api-key") },
  { id: "ai_ollama", name: "Ollama", color: ACCENT.ollama, category: "ai",
    subtitle: N_("Chat"), source: "n8n", support: "yes", connect: server("ollamaUrl") },
  { id: "ai_lmstudio", name: "LM Studio", color: ACCENT.lmstudio, category: "ai",
    subtitle: N_("Chat"), source: "n8n", support: "yes", connect: server("lmstudioUrl") },
  // ── Services ───────────────────────────────────────────────────────────────
  { id: "integration_resend", name: "Resend", color: "#22C55E", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("resend-api-key") },
  { id: "integration_n8n", name: "n8n", color: "#F29B38", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("n8n-api-key") },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("vercel-token") },
  { id: "integration_github", name: "GitHub", color: "#F4505E", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("github-token") },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("notion-api-key") },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("calcom-api-key") },
  { id: "integration_stripe", name: "Stripe", color: "#0570DE", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: key("stripe-api-key") },
  { id: "integration_music", name: "Apple Music", color: "#FA2D48", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "no", connect: none },
  // Spotify through MPRIS on Linux and the system media controls on Windows
  // (src-tauri/src/spotify.rs).
  { id: "integration_spotify", name: "Spotify", color: "#1DB954", category: "service",
    subtitle: N_("Integration"), source: "n8n", support: "yes", connect: none },
];

/** How many catalog pills may be declared. */
export const MAX_DECLARED = 4;

/** The OS this page runs on. Only the Windows webview says "Windows". */
export const HOST_OS: HostOs =
  typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent ?? "") ? "windows" : "linux";

export function pillDefinition(id: string): PillDefinition | undefined {
  return PILL_CATALOG.find((p) => p.id === id);
}

function offeredOn(def: PillDefinition, os: HostOs): boolean {
  return def.support === "yes" || def.support === "soon" || def.support === os;
}

/** The pills this build offers, in catalog order. */
export function availablePills(os: HostOs = HOST_OS): PillDefinition[] {
  return PILL_CATALOG.filter((p) => offeredOn(p, os));
}

export function isComingSoon(id: string): boolean {
  return pillDefinition(id)?.support === "soon";
}

/**
 * The declared pills as they may be used: pills this build offers, without
 * duplicates, at most MAX_DECLARED.
 */
export function sanitizeDeclared(ids: readonly string[] | undefined, os: HostOs = HOST_OS): string[] {
  const offered = new Set(availablePills(os).map((p) => p.id));
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (offered.has(id) && !out.includes(id) && out.length < MAX_DECLARED) out.push(id);
  }
  return out;
}

/**
 * Declares or undeclares a pill. Returns the new list, or null when the click
 * changes nothing: an unknown pill is never declared, and a fifth never added.
 */
export function toggleDeclared(declared: readonly string[], id: string, os: HostOs = HOST_OS): string[] | null {
  if (!availablePills(os).some((p) => p.id === id)) return null;
  if (declared.includes(id)) return declared.filter((x) => x !== id);
  if (declared.length >= MAX_DECLARED) return null;
  return [...declared, id];
}

/**
 * Pill order: the orchestrator's agents first (the backend orders them among
 * themselves), then the catalog's pills in catalog order, then anything else.
 * Pills of equal rank keep their order.
 */
export function orderPills<T extends { id: string; orchestrator?: unknown }>(tasks: T[]): T[] {
  const index = new Map(PILL_CATALOG.map((p, i) => [p.id, i]));
  const rank = (t: T) => (t.orchestrator ? -1 : index.get(t.id) ?? PILL_CATALOG.length);
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}
