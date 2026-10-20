// An orchestrator agent's card, when its pill is picked and it is at rest:
// who it is, how its computer is doing and how its last task ended, and the
// way into its chat, where you talk to it as you would to a ChatGPT dot. The ↗
// button opens its Activity on the Tasks page. While it works, asks or
// finishes, the island's usual cards take over.

import { h, dot, svg } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { OrchestratorBridge, agentLine, type AgentProblem } from "../core/orchestrator";
import { t } from "../i18n/i18n";
import { loadAgentHistory } from "../island/agent-chat";

export interface AgentCardHost {
  el: HTMLElement;
  sync(task: AgentTask): void;
}

const STATUS_COLORS: Record<string, string> = {
  ready: "#22C55E",
  busy: "#F5A524",
  starting: "#F5A524",
  offline: "#8E939C",
  error: "#F4505E",
};

export function buildAgentCard(task: AgentTask, openChat: (agentId: string) => void): AgentCardHost {
  const agentId = task.orchestrator!.agentId;
  let currentTask = task;
  const nameEl = h("b", { text: task.name });
  const headDot = h("span", {});
  const identity = h("span", {});
  const head = h("div", { class: "int-head" }, headDot, nameEl, identity);
  const statusDot = h("span", {});
  const statusText = h("span", {});
  const status = h("div", { class: "int-status" }, statusDot, statusText);

  const chatLabel = h("span", {});
  const chat = h("button", {
    class: "agent-chat-btn",
    onclick: () => {
      void loadAgentHistory(agentId, true);
      openChat(agentId);
    },
  }, svg(ICONS.bubble, 11), chatLabel);
  const pause = h("button", { class: "agent-chat-btn" });
  pause.addEventListener("click", () => {
    pause.setAttribute("disabled", "");
    const current = currentTask.orchestrator;
    const action = current?.paused ? OrchestratorBridge.resumeAgent(agentId) : OrchestratorBridge.pauseAgent(agentId);
    void action.then(({ agent }) => {
      if (currentTask.orchestrator) currentTask.orchestrator.paused = agent.paused;
    }, () => {
      // The backend's next agent update remains the source of truth.
    }).finally(() => pause.removeAttribute("disabled"));
  });
  const actions = h("div", { class: "agent-actions" }, chat, pause);
  const el = h("div", { class: "int-card agent-card" }, head, status, actions);

  return {
    el,
    sync(current) {
      currentTask = current;
      const o = current.orchestrator;
      if (!o) return;
      nameEl.textContent = current.name;
      headDot.replaceChildren(dot(current.color, 7));
      statusDot.replaceChildren(dot(STATUS_COLORS[o.status] ?? STATUS_COLORS.offline, 5));
      const line = agentLine({
        status: o.status,
        problems: o.problems as AgentProblem[],
        paused: o.paused,
      });
      identity.textContent = `${o.role || t("Agent")} · ${o.teamName || t("No team")}`;
      const activity = o.kind === "chief" ? State.agentRuns.get(o.agentId)?.line : null;
      // What is wrong comes first; how the last task ended when nothing is.
      statusText.textContent = activity
        ? `${line} · ${activity}`
        : o.last && o.problems.length === 0
          ? `${line} · ${t("Last: {text}", { text: o.last })}`
          : line;
      chatLabel.textContent = t("Chat with {name}", { name: current.name });
      chat.style.setProperty("--accent", current.color);
      pause.textContent = o.paused ? t("Resume") : t("Pause");
      pause.style.setProperty("--accent", current.color);
    },
  };
}
