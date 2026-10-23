// Coucou HQ: the middle pane. A header with the agent on the left and its
// computer and settings buttons on the right (they open the side panel), the
// thread, and the composer at the bottom. Everything is redrawn from the store
// on each change, keeping what did not change.

import type { OrchAgent } from "../core/orchestrator";
import { N_, language, t, tl } from "../i18n/i18n";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { agentAvatar, avatarSignature } from "./avatar";
import { createComposer } from "./composer";
import { createSideChat } from "./sidechat";
import { createThread } from "./thread";
import type { HqPanel, HqStore, ThreadItem } from "./types";

/** Closer to the bottom than this, the thread follows new messages. */
const FOLLOW = 80;
/** How many items the thread shows at first, and how many more "Load earlier messages" adds. */
export const PAGE = 80;

/** A monitor, stroked: the agent's computer. */
const MONITOR = "M3.5 4.5h17v11h-17zM9 20h6M12 15.5V20";
/** An arrow pointing down: back to the newest message. */
const ARROW_DOWN = "M12 5v14M6 13l6 6 6-6";

const SUGGESTIONS = [N_("Build me a developer team"), N_("What is everyone working on?"), N_("Hire a research assistant")];

/**
 * Where the shown part of a thread starts. It stays on the item it started on
 * (`startKey`), so new messages at the end never push older ones off the top
 * under the user's eyes; it falls back to the last `fallback` items when that
 * item is gone, or on a fresh thread.
 */
export function windowStart(items: Pick<ThreadItem, "key">[], startKey: string | null, fallback: number): number {
  if (startKey !== null) {
    const at = items.findIndex((item) => item.key === startKey);
    if (at >= 0) return at;
  }
  return Math.max(0, items.length - fallback);
}

export function mountConversation(root: HTMLElement, store: HqStore): void {
  const head = h("header", { class: "hq-head", hidden: true });
  const empty = h("div", { class: "hq-start" });
  const earlier = h("button", { class: "hq-earlier", text: tl("Load earlier messages"), hidden: true });
  /** The exchange opened on its own over the conversation, by its key. */
  let sideKey: string | null = null;
  const openSide = (key: string | null) => {
    sideKey = key;
    draw();
  };
  const thread = createThread(store, openSide);
  const side = createSideChat(store, () => openSide(null));
  side.el.hidden = true;
  const column = h("div", { class: "hq-column" }, empty, earlier, thread.el);
  const scroller = h("div", { class: "hq-scroll hq-main" }, column);
  const jump = h(
    "button",
    { class: "hq-jump", title: tl("Jump to latest"), "aria-label": tl("Jump to latest"), hidden: true },
    svg(ARROW_DOWN, 18, { stroke: 2 }),
  );
  const composer = createComposer(store, () => (follow = true));
  // It floats just above the composer, whatever the composer's height.
  composer.el.append(jump);
  root.append(head, scroller, composer.el, side.el);
  document.addEventListener("keydown", (e) => {
    // The palette and the sheets close themselves on Esc.
    const inDialog = e.target instanceof Element && !!e.target.closest(".hq-palette, .hq-sheet");
    if (e.key === "Escape" && sideKey && !inDialog) openSide(null);
  });

  let shownId: string | null = null;
  let headSig = "";
  let emptySig = "";
  /** Jump to the bottom after the next draw, whatever the user's scroll. */
  let follow = true;
  let lastHeight = 0;
  /** The first item on screen (see windowStart), and how many to show without it. */
  let startKey: string | null = null;
  let shownCount = PAGE;
  /** The user loaded earlier messages: keep the window on its first item. Until then it is the
   *  last PAGE items, so history that arrives after the first draw is not cut off. */
  let anchored = false;

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW;
  const syncJump = () => {
    jump.hidden = thread.el.hidden || nearBottom();
  };

  scroller.addEventListener("scroll", syncJump, { passive: true });
  jump.addEventListener("click", () => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    jump.hidden = true;
  });
  earlier.addEventListener("click", () => {
    const id = shownId;
    if (!id) return;
    const items = store.thread(id);
    const from = windowStart(items, startKey, shownCount);
    const next = Math.max(0, from - PAGE);
    startKey = items[next]?.key ?? null;
    shownCount = items.length - next;
    anchored = true;
    // Keep what the user is reading where it is: the new items go above it.
    const before = scroller.scrollHeight - scroller.scrollTop;
    draw();
    scroller.scrollTop = scroller.scrollHeight - before;
    lastHeight = scroller.scrollHeight;
    syncJump();
  });

  // ── The header ──────────────────────────────────────────────────────────────

  /** A round button that opens `panel` in the side panel, or closes it when it is open. */
  function panelButton(panel: HqPanel, icon: SVGSVGElement, label: string): HTMLElement {
    const button = h("button", { class: "hq-icon-btn", title: label, "aria-label": label, "aria-pressed": "false" }, icon);
    button.addEventListener("click", () => store.setPanel(store.snapshot().panel === panel ? null : panel));
    return button;
  }

  function drawHead(agent: OrchAgent | undefined, panel: HqPanel | null) {
    const working = agent ? store.working(agent.id) : false;
    const sig = agent
      ? `${language()}|${agent.name}|${agent.role ?? ""}|${panel}|${avatarSignature(agent, 24, { working })}`
      : "";
    if (sig === headSig) return;
    headSig = sig;
    head.hidden = !agent;
    if (!agent) return head.replaceChildren();
    const computer = panelButton("agent", svg(MONITOR, 16, { stroke: 1.8 }), t("{name}'s computer", { name: agent.name }));
    const gear = panelButton("settings", svg(ICONS.gear, 16), t("Settings for {name}", { name: agent.name }));
    computer.setAttribute("aria-pressed", String(panel === "agent"));
    gear.setAttribute("aria-pressed", String(panel === "settings"));
    head.replaceChildren(
      h(
        "div",
        { class: "hq-head-who" },
        agentAvatar(agent, 24, { working }),
        h("span", { class: "hq-head-name", text: agent.name }),
        agent.role ? h("span", { class: "hq-head-role", text: agent.role }) : null,
      ),
      h("div", { class: "hq-head-actions" }, computer, gear),
    );
  }

  /** Before the first message: Mochi introduces himself; a coworker says what a message does. */
  function drawEmpty(agent: OrchAgent | undefined, connected: boolean, error: string | null) {
    const sig = agent
      ? `${agent.id}|${agent.name}|${agent.role ?? ""}|${agent.kind}|${avatarSignature(agent, 72)}|${language()}`
      : `none|${connected}|${error ?? ""}`;
    if (sig === emptySig) return;
    emptySig = sig;
    if (!agent) {
      empty.replaceChildren(connected || !error ? h("div") : h("div", { class: "hq-empty", text: error }));
      return;
    }
    const face = h("div", { class: "hq-start-face" }, agentAvatar(agent, 72, { star: agent.kind === "chief" }));
    if (agent.kind === "chief") {
      const chips = h("div", { class: "hq-chips centered" });
      for (const text of SUGGESTIONS) {
        const b = h("button", { class: "hq-chip-option", text: t(text) });
        b.addEventListener("click", () => composer.fill(t(text)));
        chips.append(b);
      }
      empty.replaceChildren(
        face,
        h("div", { class: "hq-start-title", text: t("I'm {name}, your head of staff.", { name: agent.name }) }),
        chips,
      );
    } else {
      empty.replaceChildren(
        face,
        h("div", { class: "hq-start-title", text: agent.name }),
        h("div", { class: "hq-start-role", text: agent.role ?? "", hidden: !agent.role }),
        h("div", { class: "hq-start-line", text: t("Each message is a task for {name}.", { name: agent.name }) }),
      );
    }
  }

  function draw() {
    const snap = store.snapshot();
    const id = snap.selectedId;
    const agent = id ? store.agent(id) : undefined;
    if (id !== shownId) {
      shownId = id;
      thread.reset();
      follow = true;
      startKey = null;
      shownCount = PAGE;
      anchored = false;
      sideKey = null;
    }
    const stick = follow || nearBottom();

    drawHead(agent, snap.panel);
    composer.setAgent(agent);
    const items = id ? store.thread(id) : [];
    const opened = sideKey ? items.find((item) => item.key === sideKey) : undefined;
    if (opened?.kind === "exchange") {
      side.el.hidden = false;
      side.render(opened);
    } else {
      sideKey = null;
      side.el.hidden = true;
    }
    const isEmpty = items.length === 0;
    empty.hidden = !isEmpty;
    thread.el.hidden = isEmpty;
    if (isEmpty) {
      thread.reset();
      earlier.hidden = true;
      startKey = null;
      drawEmpty(agent, snap.connected, snap.error);
    } else {
      const from = windowStart(items, anchored ? startKey : null, anchored ? shownCount : PAGE);
      startKey = items[from].key;
      shownCount = items.length - from;
      earlier.hidden = from === 0;
      thread.render(id!, items.slice(from));
    }
    // A redraw that changed nothing leaves the scroll where the user put it.
    const grew = scroller.scrollHeight !== lastHeight;
    if (stick && (grew || follow)) scroller.scrollTop = scroller.scrollHeight;
    lastHeight = scroller.scrollHeight;
    follow = false;
    syncJump();
  }

  // Any change, a language change included (main.ts reloads the store then).
  store.subscribe(draw);
  draw();
}
