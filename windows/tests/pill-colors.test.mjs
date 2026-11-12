// A colour of the user's own for each pill's Tofu (src/core/pill-colors.ts),
// and how the app state paints with it.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { PILL_PALETTE, normalizeHex, parsePillColors, pillColor, withPillColor } from "../src/core/pill-colors.ts";
import { pillDefinition } from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const N8N = pillDefinition("integration_n8n").color;
const TEAL = "#2DD4BF";

// ── The pure half ─────────────────────────────────────────────────────────────

test("a colour is six hex digits, written #RRGGBB in upper case", () => {
  assert.equal(normalizeHex("#2dd4bf"), TEAL);
  assert.equal(normalizeHex("2DD4BF"), TEAL);
  assert.equal(normalizeHex("  #2DD4BF "), TEAL);
  for (const bad of ["", "#2DD4B", "#2DD4BFF", "#GGGGGG", "teal", "rgb(1,2,3)", null, undefined, 0x2dd4bf, {}]) {
    assert.equal(normalizeHex(bad), null, String(bad));
  }
});

test("the palette is ten different colours", () => {
  assert.deepEqual(PILL_PALETTE, [
    "#F5F6F8", "#F4505E", "#F29B38", "#FACC15", "#4ADE80",
    "#2DD4BF", "#38BDF8", "#818CF8", "#C084FC", "#E879F9",
  ]);
  assert.equal(new Set(PILL_PALETTE).size, 10);
  for (const hex of PILL_PALETTE) assert.equal(normalizeHex(hex), hex, hex);
});

test("a stored preference keeps what is a colour and drops the rest", () => {
  assert.deepEqual(
    parsePillColors({ integration_n8n: "#2dd4bf", integration_vercel: "blue", "": "#FFFFFF", agent_new: "#abcdef", n: 3 }),
    { integration_n8n: TEAL, agent_new: "#ABCDEF" },
  );
  for (const junk of [null, undefined, "x", 3, ["#2DD4BF"]]) assert.deepEqual(parsePillColors(junk), {});
});

test("a pill wears the user's colour when there is one, else the catalog's", () => {
  assert.equal(pillColor("integration_n8n", N8N, {}), N8N);
  assert.equal(pillColor("integration_n8n", N8N, null), N8N);
  assert.equal(pillColor("integration_n8n", N8N, { integration_n8n: "#2dd4bf" }), TEAL);
  assert.equal(pillColor("integration_n8n", N8N, { integration_n8n: "nope" }), N8N);
  assert.equal(pillColor("integration_vercel", "#7C5CFF", { integration_n8n: TEAL }), "#7C5CFF");
});

test("picking a colour stores it; the default, nothing or junk clears it", () => {
  const before = { integration_vercel: "#F4505E" };
  const picked = withPillColor(before, "integration_n8n", "#2dd4bf", N8N);
  assert.deepEqual(picked, { integration_vercel: "#F4505E", integration_n8n: TEAL });
  assert.deepEqual(before, { integration_vercel: "#F4505E" }, "the preference given is not changed");

  assert.deepEqual(withPillColor(picked, "integration_n8n", null, N8N), before);
  assert.deepEqual(withPillColor(picked, "integration_n8n", N8N.toLowerCase(), N8N), before);
  assert.deepEqual(withPillColor(picked, "integration_n8n", "teal", N8N), before);
});

// ── The app state ─────────────────────────────────────────────────────────────

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.os = "windows";
  State.settings = { ...DEFAULT_SETTINGS };
});

const colorOf = (id) => State.tasks.find((t) => t.id === id)?.color;

test("with no preference every pill is painted as the catalog says", () => {
  assert.deepEqual(DEFAULT_SETTINGS.pillColors, {});
  State.loadIntegrationTasks();
  for (const task of State.tasks) assert.equal(task.color, pillDefinition(task.id).color, task.id);
});

test("a pill is created in the colour the user gave it", () => {
  State.settings.pillColors = { integration_n8n: TEAL };
  State.loadIntegrationTasks();
  assert.equal(colorOf("integration_n8n"), TEAL);
  assert.equal(colorOf("integration_github"), pillDefinition("integration_github").color);
});

test("a colour picked later reaches the pills already on the island, and back", () => {
  State.loadIntegrationTasks();
  assert.equal(colorOf("integration_n8n"), N8N);

  State.settings = { ...State.settings, pillColors: { integration_n8n: TEAL } };
  State.loadIntegrationTasks();
  assert.equal(colorOf("integration_n8n"), TEAL);

  State.settings = { ...State.settings, pillColors: {} };
  State.loadIntegrationTasks();
  assert.equal(colorOf("integration_n8n"), N8N);
});

test("an agent keeps the colour it came with", () => {
  State.settings.pillColors = { agent_homemade: TEAL };
  State.loadIntegrationTasks();
  State.upsertExternalAgent("agent_homemade", "Homemade", "#60A5FA");
  assert.equal(colorOf("agent_homemade"), "#60A5FA");
  State.loadIntegrationTasks();
  assert.equal(colorOf("agent_homemade"), "#60A5FA");
});
