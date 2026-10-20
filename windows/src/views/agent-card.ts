// An orchestrator agent's card, when its pill is picked and it is at rest:
// who it is, how its computer is doing and how its last task ended, and the
// way into its chat, where you talk to it as you would to a ChatGPT dot. The ↗
// button opens its Activity on the Tasks page. While it works, asks or
// finishes, the island's usual cards take over.

import { h, dot, svg } from "./dom";
import { ICONS } from "./icons";
import type { AgentTask } from "../core/state";
import { agentLine, type AgentProblem } from "../core/orchestrator";
import { t } from "../i18n/i18n";

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
  const nameEl = h("b", { text: task.name });
  const headDot = h("span", {});
  const head = h("div", { class: "int-head" }, headDot, nameEl, h("span", { text: t("Agent") }));
  const statusDot = h("span", {});
  const statusText = h("span", {});
  const status = h("div", { class: "int-status" }, statusDot, statusText);

  const chatLabel = h("span", {});
  const chat = h("button", { class: "agent-chat-btn", onclick: () => openChat(agentId) }, svg(ICONS.bubble, 11), chatLabel);
  const el = h("div", { class: "int-card agent-card" }, head, status, chat);

  return {
    el,
    sync(current) {
      const o = current.orchestrator;
      if (!o) return;
      nameEl.textContent = current.name;
      headDot.replaceChildren(dot(current.color, 7));
      statusDot.replaceChildren(dot(STATUS_COLORS[o.status] ?? STATUS_COLORS.offline, 5));
      const line = agentLine({ id: o.agentId, name: current.name, status: o.status, problems: o.problems as AgentProblem[] });
      // What is wrong comes first; how the last task ended when nothing is.
      statusText.textContent = o.last && o.problems.length === 0 ? `${line} · ${t("Last: {text}", { text: o.last })}` : line;
      chatLabel.textContent = t("Chat with {name}", { name: current.name });
      chat.style.setProperty("--accent", current.color);
    },
  };
}
