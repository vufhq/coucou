// The orchestrator's agent ids and fallback colours (src/island/agents.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentColor, validateAgent } from "../src/island/agents.ts";

test("an agent gets a stable colour from its id", () => {
  assert.equal(agentColor("agent-01"), agentColor("agent-01"));
  assert.match(agentColor("agent-01"), /^#[0-9A-F]{6}$/);
});

test("an agent id is lowercase letters, digits and hyphens, up to 24", () => {
  for (const bad of ["Agent-01", "has space", "a".repeat(25), "", undefined, "x_y"]) {
    assert.equal(validateAgent(bad), null, String(bad));
  }
  assert.equal(validateAgent("agent-01"), "agent-01");
  assert.equal(validateAgent("a".repeat(24)), "a".repeat(24));
});
