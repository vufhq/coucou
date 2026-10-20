// The orchestrator's agents in the island: a pill each that stays while the
// backend is on, like ChatGPT's dots, so an agent is always there to look at
// and to ask, not only while it runs a task. Rust sends the list on every
// connection and whenever an agent changes (orchestrator-agents).

import { onEvent } from "../core/bridge";
import { OrchestratorBridge, type OrchAgent } from "../core/orchestrator";
import { State } from "../core/state";
import { agentColor } from "./agents";
import { loadAgentHistory } from "./agent-chat";

type StatusEvent = { state: "off" | "connecting" | "connected" | "noToken" | "unreachable" };

function apply(agents: OrchAgent[] | null) {
  State.syncOrchestratorAgents(
    agents?.map((a) => ({
      agentId: a.id,
      name: a.name,
      color: a.color ?? agentColor(a.id),
      status: a.status,
      problems: a.problems ?? [],
      paused: a.paused ?? false,
      limits: a.limits ?? { tasksPerDay: 30, stepsPerDay: 300 },
      usage: a.usage ?? { tasksToday: 0, stepsToday: 0 },
    })) ?? null,
  );
  for (const agent of agents ?? []) void loadAgentHistory(agent.id);
}

export function registerOrchestratorAgents() {
  void onEvent<{ agents: OrchAgent[] | null }>("orchestrator-agents", (e) => apply(e.agents ?? []));
  void onEvent<StatusEvent>("orchestrator-status", (s) => {
    if (s.state === "off") apply(null);
    else if (s.state !== "connected" && s.state !== "connecting") State.markOrchestratorOffline();
  });
  // Coucou opened while the backend was already connected.
  void OrchestratorBridge.status()
    .then((s) => (s.status.state === "connected" ? OrchestratorBridge.agents().then((r) => apply(r.agents)) : undefined))
    .catch(() => {});
}
