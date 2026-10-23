// Coucou HQ: an exchange opened on its own. What the agents said to each
// other takes the whole middle pane: who is talking at the top ("Mochi ⇄
// Ada"), their messages in runs, each run with its author's name above and face
// below, and "Close chat" where the composer was. Nothing here can be typed
// into: the user talks to the agent whose conversation this came from.

import { language, t, tl, tn } from "../i18n/i18n";
import { h } from "../views/dom";
import { renderMarkdown } from "../views/markdown";
import { agentAvatar } from "./avatar";
import { NAMED_AGENTS } from "./thread";
import type { ExchangeMessage, HqStore, ThreadItem } from "./types";

type Exchange = Extract<ThreadItem, { kind: "exchange" }>;

export interface SideChatView {
  el: HTMLElement;
  /** Shows `item`, redrawing only when what it shows changed. */
  render(item: Exchange): void;
}

/** Everyone in the exchange, in the order they first speak or are spoken to. */
export function participants(item: Pick<Exchange, "withAgentIds" | "messages">): string[] {
  const ids: string[] = [];
  for (const m of item.messages) {
    for (const id of [m.fromAgentId, m.toAgentId]) if (id && !ids.includes(id)) ids.push(id);
  }
  for (const id of item.withAgentIds) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Consecutive messages from the same agent, as one run. */
export function runs(messages: readonly ExchangeMessage[]): ExchangeMessage[][] {
  const out: ExchangeMessage[][] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last[0].fromAgentId === m.fromAgentId) last.push(m);
    else out.push([m]);
  }
  return out;
}

export function createSideChat(store: HqStore, onClose: () => void): SideChatView {
  const chip = h("div", { class: "hq-sidechat-chip" });
  const list = h("div", { class: "hq-sidechat-list", role: "log" });
  const scroller = h("div", { class: "hq-scroll hq-main" }, h("div", { class: "hq-column" }, list));
  const close = h("button", { class: "hq-sidechat-close", text: tl("Close chat") });
  close.addEventListener("click", onClose);
  const el = h("div", { class: "hq-sidechat" }, chip, scroller, h("div", { class: "hq-sidechat-foot" }, close));
  let sig = "";
  let shownKey = "";

  const name = (id: string) => store.agent(id)?.name ?? id;

  function who(id: string): HTMLElement {
    const agent = store.agent(id);
    return h("span", { class: "hq-sidechat-who" }, agent ? agentAvatar(agent, 20) : null, h("span", { text: name(id) }));
  }

  function drawChip(ids: string[]) {
    const [first, ...rest] = ids;
    const others = rest.length > NAMED_AGENTS
      ? [h("span", { class: "hq-sidechat-who", text: tn("{count} agent", "{count} agents", rest.length) })]
      : rest.map(who);
    chip.replaceChildren(
      first ? who(first) : h("span"),
      h("span", { class: "hq-sidechat-arrows", "aria-hidden": "true", text: "⇄" }),
      ...others,
    );
  }

  function run(messages: ExchangeMessage[], many: boolean): HTMLElement {
    const from = messages[0].fromAgentId;
    const agent = store.agent(from);
    // With more than two, say who each run is for.
    const to = [...new Set(messages.map((m) => m.toAgentId))].map(name);
    const label = many ? t("{from} to {to}", { from: name(from), to: to.join(", ") }) : name(from);
    const bubbles = h("div", { class: "hq-sidechat-bubbles" });
    for (const m of messages) {
      const body = h("div", { class: "hq-md" });
      renderMarkdown(body, m.text);
      bubbles.append(h("div", { class: "hq-bubble agent" }, body));
    }
    return h(
      "div",
      { class: "hq-sidechat-run" },
      h("div", { class: "hq-sidechat-face" }, agent ? agentAvatar(agent, 28) : null),
      h("div", { class: "hq-sidechat-texts" }, h("div", { class: "hq-sidechat-name", text: label }), bubbles),
    );
  }

  function render(item: Exchange) {
    const ids = participants(item);
    const faces = ids.map((id) => {
      const a = store.agent(id);
      return a ? `${a.name}:${a.color ?? ""}:${a.outfit ?? ""}` : id;
    });
    const next = `${language()}|${JSON.stringify(item)}|${faces.join(",")}`;
    if (next === sig) return;
    const fresh = item.key !== shownKey;
    sig = next;
    shownKey = item.key;
    drawChip(ids);
    list.replaceChildren(...runs(item.messages).map((r) => run(r, ids.length > 2)));
    // A new exchange opens on its latest message; a live one follows its new messages.
    if (fresh || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  return { el, render };
}
