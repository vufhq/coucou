// The pill catalog (src/core/pills.ts) and the pills in the app state: the
// orchestrator's agents first, then the declared catalog pills.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DECLARED, PILL_CATALOG, PILL_CATEGORIES, availablePills, isComingSoon, orderPills, pillDefinition,
  sanitizeDeclared, toggleDeclared,
} from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

// ── The catalog itself ────────────────────────────────────────────────────────

test("the catalog holds the chat providers and the services", () => {
  // An ID is a contract value (settings, keys), and a colour or subtitle that
  // drifts is a visible bug.
  assert.deepEqual(PILL_CATALOG.map((p) => [p.id, p.name, p.color, p.category, p.subtitle]), [
    ["ai_anthropic", "Anthropic", "#E07950", "ai", "Chat"],
    ["ai_google", "Google AI", "#4285F4", "ai", "Chat"],
    ["ai_openai", "OpenAI", "#10A37F", "ai", "Chat"],
    ["ai_ollama", "Ollama", "#FACC15", "ai", "Chat"],
    ["ai_lmstudio", "LM Studio", "#A3E635", "ai", "Chat"],
    ["integration_resend", "Resend", "#22C55E", "service", "Integration"],
    ["integration_n8n", "n8n", "#F29B38", "service", "Integration"],
    ["integration_vercel", "Vercel", "#7C5CFF", "service", "Integration"],
    ["integration_github", "GitHub", "#F4505E", "service", "Integration"],
    ["integration_notion", "Notion", "#8C8C8C", "service", "Integration"],
    ["integration_calcom", "Cal.com", "#C9956A", "service", "Integration"],
    ["integration_stripe", "Stripe", "#0570DE", "service", "Integration"],
    ["integration_music", "Apple Music", "#FA2D48", "service", "Integration"],
    ["integration_spotify", "Spotify", "#1DB954", "service", "Integration"],
  ]);
  assert.deepEqual(PILL_CATEGORIES.map((c) => c.title), ["AI for the chat", "Services"]);
});

test("IDs are unique", () => {
  const ids = PILL_CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("this build leaves out Apple Music, and offers every chat provider and Spotify", () => {
  const windows = availablePills("windows").map((p) => p.id);
  assert.ok(!windows.includes("integration_music"));
  for (const id of ["ai_google", "ai_openai", "ai_ollama", "ai_lmstudio", "integration_spotify"]) {
    assert.ok(windows.includes(id), id);
  }
});

test("Spotify: a service with nothing to set up", () => {
  const def = pillDefinition("integration_spotify");
  assert.deepEqual(def.connect, { kind: "none" });
  assert.equal(def.category, "service");
  assert.ok(!isComingSoon("integration_spotify"));
});

test("no chat provider that works here says Coming soon", () => {
  for (const id of ["ai_anthropic", "ai_google", "ai_openai", "ai_ollama", "ai_lmstudio"]) {
    assert.ok(!isComingSoon(id), id);
  }
  // The local servers are connected through Settings → Local models, not a key.
  assert.deepEqual(pillDefinition("ai_ollama").connect, { kind: "server", field: "ollamaUrl" });
  assert.deepEqual(pillDefinition("ai_lmstudio").connect, { kind: "server", field: "lmstudioUrl" });
  assert.equal(pillDefinition("ai_google").connect.key, "google-api-key");
});

// ── Declaring pills ──────────────────────────────────────────────────────────

test("a declaration from an older or edited settings file is made usable", () => {
  // Pills that are gone (Claude Code, the agents) and unknown ones are dropped,
  // as are duplicates and anything past the fourth.
  assert.deepEqual(
    sanitizeDeclared(["integration_claude", "agent_cursor", "integration_n8n", "integration_n8n", "integration_music", "x"], "windows"),
    ["integration_n8n"],
  );
  assert.deepEqual(sanitizeDeclared(undefined, "windows"), []);
  assert.equal(
    sanitizeDeclared(["ai_anthropic", "ai_google", "ai_openai", "ai_ollama", "ai_lmstudio"], "windows").length,
    MAX_DECLARED,
  );
});

test("up to four pills can be declared", () => {
  const three = ["integration_n8n", "integration_github", "integration_stripe"];
  const four = toggleDeclared(three, "ai_google", "windows");
  assert.equal(four.length, MAX_DECLARED);
  assert.equal(toggleDeclared(four, "ai_anthropic", "windows"), null);
  assert.equal(toggleDeclared(three, "integration_music", "windows"), null);
  assert.equal(toggleDeclared(three, "integration_claude", "windows"), null);
  assert.deepEqual(toggleDeclared(three, "integration_github", "windows"), ["integration_n8n", "integration_stripe"]);
});

test("pills are ordered agents first, then the catalog's order, then anything else", () => {
  const ids = (list) => list.map((t) => t.id);
  const tasks = [
    { id: "integration_stripe" }, { id: "stray" }, { id: "integration_n8n" },
    { id: "agent_agent-02", orchestrator: {} }, { id: "ai_anthropic" }, { id: "agent_agent-01", orchestrator: {} },
  ];
  assert.deepEqual(ids(orderPills(tasks)), [
    "agent_agent-02", "agent_agent-01", "ai_anthropic", "integration_n8n", "integration_stripe", "stray",
  ]);
});

// ── In the app state ─────────────────────────────────────────────────────────

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.chatAgent = null;
  State.os = "windows";
  State.settings = { ...DEFAULT_SETTINGS };
});

const ids = () => State.tasks.map((t) => t.id);

/** One agent as the backend lists it. */
const agent = (agentId, kind = "coworker", order = 0) => ({
  agentId, name: agentId, color: "#22C55E", kind, role: null, outfit: null, teamId: null, teamName: null,
  teamOrder: null, order, computerId: "agent-01", status: "ready", problems: [], paused: false,
  limits: { tasksPerDay: 30, stepsPerDay: 300 }, usage: { tasksToday: 0, stepsToday: 0 },
});

test("the declared pills load in catalog order, and focus starts on the first", () => {
  State.settings.activeIntegrations = ["integration_github", "ai_anthropic"];
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["ai_anthropic", "integration_github"]);
  assert.equal(State.focusId, "ai_anthropic");
});

test("an old settings file keeps its integrations and drops what is gone", () => {
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: ["integration_claude", "integration_github"] };
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_github"]);
  assert.deepEqual(State.settings.activeIntegrations, ["integration_github"]);
});

test("the agents come first, the chief leading, and the chat starts with the chief", () => {
  State.loadIntegrationTasks();
  State.syncOrchestratorAgents([agent("agent-02", "coworker", 1), agent("agent-01", "chief")]);
  assert.deepEqual(ids().slice(0, 2), ["agent_agent-01", "agent_agent-02"]);
  assert.equal(State.chatAgent, "agent-01");
  // The catalog pills stay after them.
  assert.deepEqual(ids().slice(2), ["integration_resend", "integration_n8n", "integration_vercel", "integration_github"]);
});

test("a busy pill stays until it is done", () => {
  State.loadIntegrationTasks();
  State.tasks.find((t) => t.id === "integration_n8n").state = "working";
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();
  assert.deepEqual(ids(), ["integration_n8n"]);
  State.removeTask("integration_n8n");
  assert.deepEqual(ids(), []);
});

test("the end of a task puts a kept pill back as it was, and removes any other", () => {
  State.settings.activeIntegrations = ["integration_n8n"];
  State.loadIntegrationTasks();
  const n8n = State.tasks.find((t) => t.id === "integration_n8n");
  Object.assign(n8n, { state: "finished", steps: ["a"], pillBadge: "finished" });
  State.removeTask("integration_n8n");
  assert.deepEqual([n8n.name, n8n.state, n8n.steps, n8n.pillBadge], ["n8n", "idle", [], null]);
  State.upsertExternalAgent("agent_mine", "mine", "#22C55E");
  State.setFocus("agent_mine");
  State.removeTask("agent_mine");
  assert.ok(!ids().includes("agent_mine"));
  assert.equal(State.focusId, "integration_n8n");
});

test("an agent's pill made before the agent list goes first, and is adopted by it", () => {
  State.loadIntegrationTasks();
  State.upsertExternalAgent("agent_agent-01", "agent-01", "#22C55E");
  assert.equal(ids()[0], "agent_agent-01");
  State.syncOrchestratorAgents([{ ...agent("agent-01", "chief"), name: "Tofu" }]);
  const pill = State.tasks.find((t) => t.id === "agent_agent-01");
  assert.equal(pill.name, "Tofu");
  assert.ok(pill.orchestrator);
  assert.ok(State.isKept("agent_agent-01"));
});

test("toggling declares up to four pills", () => {
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();
  for (const id of ["integration_n8n", "ai_google", "ai_anthropic", "integration_stripe", "integration_github"]) {
    State.toggleIntegration(id);
  }
  assert.deepEqual(State.settings.activeIntegrations, [
    "integration_n8n", "ai_google", "ai_anthropic", "integration_stripe",
  ]);
  State.setFocus("ai_google");
  State.toggleIntegration("ai_google");
  assert.ok(!ids().includes("ai_google"));
  assert.equal(State.focusId, "ai_anthropic");
});
