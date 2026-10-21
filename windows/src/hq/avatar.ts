// Coucou HQ: an agent's face, a mini Mochi in its colour and outfit on a
// round tinted disc. The sidebar and the conversation both use it. Each one is
// a live canvas ticked by main.ts's loop; when the element leaves the
// document, pruneMiniBots() forgets it, so callers simply replace it.

import type { AgentTask } from "../core/state";
import type { OrchAgent } from "../core/orchestrator";
import { agentColor } from "../island/agents";
import { createMiniBot } from "../mochi/minibots";
import { ICONS } from "../views/icons";
import { h, svg } from "../views/dom";

export interface AvatarOptions {
  /** The agent is on a task: Mochi looks busy. */
  working?: boolean;
  /** The chief's orange star, bottom right. */
  star?: boolean;
}

/** The colour the agent is painted with. */
export function avatarColor(agent: OrchAgent): string {
  return agent.color ?? agentColor(agent.id);
}

/** What changes the drawing: when it differs, the caller makes a new avatar. */
export function avatarSignature(agent: OrchAgent, size: number, opts: AvatarOptions = {}): string {
  return [avatarColor(agent), agent.outfit ?? "none", size, opts.working ? 1 : 0, opts.star ? 1 : 0].join("|");
}

/** Only what createMiniBot reads from a task. */
function miniTask(agent: OrchAgent, color: string, working: boolean): AgentTask {
  return {
    id: `hq-${agent.id}`,
    name: agent.name,
    color,
    state: working ? "working" : "idle",
    stepIndex: 0,
    steps: [],
    source: "agent",
    isIntegration: false,
    orchestrator: { outfit: agent.outfit ?? null },
  } as unknown as AgentTask;
}

/** A `size` px avatar: the character itself, as in the reference (hats may rise above it). */
export function agentAvatar(agent: OrchAgent, size: number, opts: AvatarOptions = {}): HTMLElement {
  const color = avatarColor(agent);
  const el = h("span", {
    class: opts.working ? "hq-avatar working" : "hq-avatar",
    style: `width:${size}px;height:${size}px;--hq-avatar-color:${color}`,
    "aria-hidden": "true",
  });
  el.append(createMiniBot(miniTask(agent, color, !!opts.working), size * 0.88));
  if (opts.star) {
    const badge = Math.max(12, Math.round(size * 0.3));
    const star = h("span", { class: "hq-avatar-star", style: `width:${badge}px;height:${badge}px` });
    star.append(svg(ICONS.star, Math.round(badge * 0.66)));
    el.append(star);
  }
  return el;
}
