// Coucou HQ: the command palette (Ctrl+K, Cmd+K on a Mac). A box and a list
// of what the user can do from anywhere in the window: go to an agent, open
// Activity, ask Mochi to hire, and pause, plan or set up the agent on screen.
// Typing filters the list; the arrows move, Enter runs, Esc or a click
// outside closes. Nothing runs without Enter or a click.

import type { OrchAgent } from "../core/orchestrator";
import { OrchestratorBridge } from "../core/orchestrator";
import { t, tl } from "../i18n/i18n";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { agentAvatar } from "./avatar";
import type { HqStore } from "./types";

/** A magnifying glass, stroked. */
const SEARCH = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3 20 20";

interface Command {
  label: string;
  /** More words it is found by (an agent's role). */
  also?: string;
  agent?: OrchAgent;
  /**
   * What it does. A promise keeps the palette open until it settles, so a
   * failure can be shown; anything else closes it first.
   */
  run(): void | Promise<void>;
}

/** Every word of `query` is somewhere in `text`, ignoring case and accents. */
export function matches(query: string, text: string): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const hay = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

/** Ctrl+K, or Cmd+K on a Mac, with no other modifier. */
export function isPaletteKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function mountPalette(root: HTMLElement, store: HqStore): void {
  const input = h("input", {
    class: "hq-palette-input",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: tl("Search agents and actions"),
    "aria-label": tl("Search agents and actions"),
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "hq-palette-list",
  }) as HTMLInputElement;
  const list = h("div", { class: "hq-palette-list", id: "hq-palette-list", role: "listbox" });
  const note = h("div", { class: "hq-palette-note", role: "status" });
  const box = h(
    "div",
    { class: "hq-palette", role: "dialog", "aria-modal": "true", "aria-label": tl("Search agents and actions") },
    h("div", { class: "hq-palette-search" }, h("span", { class: "hq-palette-glass" }, svg(SEARCH, 16, { stroke: 2 })), input),
    list,
    note,
  );
  const backdrop = h("div", { class: "hq-palette-backdrop", hidden: true }, box);
  root.append(backdrop);

  let commands: Command[] = [];
  let shown: Command[] = [];
  let active = 0;
  let busy = false;
  /** Where the focus was, to give it back on close. */
  let before: HTMLElement | null = null;

  // ── What it offers ──────────────────────────────────────────────────────────

  function build(): Command[] {
    const snap = store.snapshot();
    const out: Command[] = [];
    for (const agent of snap.agents) {
      out.push({ label: t("Go to {name}", { name: agent.name }), also: agent.role ?? "", agent, run: () => store.select(agent.id) });
    }
    out.push({ label: t("Activity"), run: () => store.setView("activity") });
    const chief = store.chief();
    if (chief) {
      out.push({
        label: t("Ask Mochi to hire…"),
        run: () => {
          store.select(chief.id);
          document.dispatchEvent(new CustomEvent("hq-compose", { detail: { text: "Hire " } }));
        },
      });
    }
    const selected = snap.selectedId ? store.agent(snap.selectedId) : undefined;
    if (selected) {
      const { id, name } = selected;
      out.push({
        label: selected.paused ? t("Resume {name}", { name }) : t("Pause {name}", { name }),
        run: async () => {
          await (selected.paused ? OrchestratorBridge.resumeAgent(id) : OrchestratorBridge.pauseAgent(id));
          await store.reload();
        },
      });
      out.push({
        label: t("New goal for {name}…", { name }),
        run: () => {
          store.select(id);
          document.dispatchEvent(new CustomEvent("hq-new-goal"));
        },
      });
      out.push({
        label: t("Settings for {name}", { name }),
        run: () => {
          store.select(id);
          store.setPanel("settings");
        },
      });
    }
    return out;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function row(command: Command, index: number): HTMLElement {
    const el = h(
      "div",
      {
        class: index === active ? "hq-palette-item active" : "hq-palette-item",
        role: "option",
        id: `hq-palette-${index}`,
        "aria-selected": String(index === active),
      },
      command.agent
        ? agentAvatar(command.agent, 22, { working: store.working(command.agent.id) })
        : h("span", { class: "hq-palette-icon" }, svg(ICONS.chevronRight, 14, { stroke: 2 })),
      h("span", { class: "hq-palette-label", text: command.label }),
      command.also ? h("span", { class: "hq-palette-also", text: command.also }) : null,
    );
    el.addEventListener("mousemove", () => {
      if (active !== index) mark(index);
    });
    // mousedown would move the focus out of the box first.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => runAt(index));
    return el;
  }

  function filter() {
    const query = input.value.trim();
    shown = commands.filter((c) => matches(query, `${c.label} ${c.also ?? ""}`));
    active = 0;
    list.replaceChildren(...shown.map(row));
    if (!shown.length) list.append(h("div", { class: "hq-palette-empty", text: t("Nothing matches") }));
    sync();
  }

  function mark(index: number) {
    active = index;
    list.querySelectorAll(".hq-palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === index);
      el.setAttribute("aria-selected", String(i === index));
    });
    sync();
  }

  function sync() {
    const el = list.querySelector<HTMLElement>(`#hq-palette-${active}`);
    if (el) {
      input.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  // ── Open, run, close ────────────────────────────────────────────────────────

  function open() {
    if (!backdrop.hidden) return;
    before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    commands = build();
    input.value = "";
    note.textContent = "";
    busy = false;
    input.disabled = false;
    backdrop.hidden = false;
    filter();
    input.focus();
  }

  function close() {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    list.replaceChildren();
    // The minis in the list leave the DOM; main.ts prunes them.
    before?.focus();
    before = null;
  }

  function runAt(index: number) {
    const command = shown[index];
    if (!command || busy) return;
    note.textContent = "";
    // Close first, so what the command focuses (the composer) keeps the focus.
    const result = (() => {
      try {
        return command.run();
      } catch (err) {
        return Promise.reject(err);
      }
    })();
    if (!(result instanceof Promise)) {
      close();
      return;
    }
    busy = true;
    input.disabled = true;
    void result.then(
      () => close(),
      (err) => {
        note.textContent = String(err);
        busy = false;
        input.disabled = false;
        input.focus();
      },
    );
  }

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      mark((active + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    }
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", (e) => {
    if (isPaletteKey(e)) {
      e.preventDefault();
      if (backdrop.hidden) open();
      else close();
    } else if (e.key === "Escape" && !backdrop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}
