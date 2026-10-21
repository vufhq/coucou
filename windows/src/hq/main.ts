// Coucou HQ (hq.html): the window where the user is the boss of Mochi and his
// team. Three panes: the sidebar lists the agents by team; the middle shows
// the conversation with the one selected (or Activity, every task); the side
// panel on the right shows its computer, goals, memory and files, or its
// settings. The island stays the glance; this is the office.

import "./hq.css";
import "./sidebar.css";
import "./thread.css";
import "./panel.css";
import "./activity.css";
import { Bridge, onEvent } from "../core/bridge";
import type { Settings } from "../core/state";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages, tl } from "../i18n/i18n";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { mountTitleBar } from "../views/titlebar";
import { miniBotCount, pruneMiniBots, tickMiniBots } from "../mochi/minibots";
import { createHqStore } from "./store";
import { mountSidebar } from "./sidebar";
import { mountConversation } from "./conversation";
import { mountActivity } from "./activity";
import { mountPanel } from "./panel";
import { mountPalette } from "./palette";

// ── The minis' animation: only while the window is on screen ─────────────────

let shown = false;
let frame = 0;
let last = 0;

function loop(now: number) {
  frame = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  pruneMiniBots();
  tickMiniBots(dt);
  if (running()) frame = requestAnimationFrame(loop);
}

const running = () => shown && document.visibilityState === "visible" && miniBotCount() > 0;

/** Starts the loop when it should run; it stops itself otherwise (0 % CPU hidden). */
export function wakeMinis() {
  if (frame || !running()) return;
  last = 0;
  frame = requestAnimationFrame(loop);
}

function setShown(on: boolean) {
  shown = on;
  wakeMinis();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  setLanguage(resolveLanguage(boot?.settings.language, systemLanguages()));

  // The window is borderless (lib.rs): its title bar, with Coucou's settings in reach.
  const settingsBtn = h("button", { class: "cc-tb-action", title: tl("Settings") }, svg(ICONS.gear, 14), h("span", { text: tl("Settings") }));
  settingsBtn.addEventListener("click", () => void Bridge.openHubPage("general"));
  mountTitleBar({ title: "Coucou HQ", actions: [settingsBtn] });

  const root = document.getElementById("hq")!;
  const sidebar = h("aside", { class: "hq-sidebar" });
  const conversation = h("main", { class: "hq-conversation" });
  const activity = h("main", { class: "hq-activity", hidden: true });
  const panel = h("aside", { class: "hq-panel", hidden: true });
  root.append(sidebar, conversation, activity, panel);

  const store = createHqStore();
  mountSidebar(sidebar, store);
  mountConversation(conversation, store);
  mountActivity(activity, store);
  mountPanel(panel, store);
  mountPalette(document.body, store);
  store.subscribe(wakeMinis);
  // Which panes are on screen.
  const layout = () => {
    const snap = store.snapshot();
    conversation.hidden = snap.view !== "chat";
    activity.hidden = snap.view !== "activity";
    panel.hidden = snap.view !== "chat" || !snap.panel;
    root.classList.toggle("with-panel", !panel.hidden);
  };
  store.subscribe(layout);
  layout();

  void onEvent<boolean>("hq-visible", setShown);
  // ↗ in the island, or the tray: open on that agent.
  void onEvent<{ agentId: string | null }>("hq-open", ({ agentId }) => {
    if (agentId) store.select(agentId);
  });
  void onEvent<Settings>("settings-changed", (s) => setLanguage(resolveLanguage(s.language, systemLanguages())));
  onLanguageChange(() => void store.reload());
  document.addEventListener("visibilitychange", wakeMinis);
  setShown(await Bridge.hqShown());
  await store.start();
}

void main();
