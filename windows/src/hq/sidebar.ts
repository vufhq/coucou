// Coucou HQ: the sidebar. Search and + at the top, the Activity entry, the
// pinned faces (Mochi first, with his star), then "Needs you" and one
// collapsible section per team, each row with its last time, and at the bottom
// the settings and "Connect apps". It only reads the store and asks it to
// select; creating an agent goes straight to the backend.

import type { OrchAgent, OrchOutfit } from "../core/orchestrator";
import { OrchestratorBridge } from "../core/orchestrator";
import { Bridge } from "../core/bridge";
import { PILL_PALETTE } from "../core/pill-colors";
import { t, tl } from "../i18n/i18n";
import { OUTFIT_LABELS, OUTFIT_SELECTIONS } from "../mochi/wardrobe";
import { HUB_ICONS } from "../hub/ui";
import { clear, h, svg } from "../views/dom";
import { rowTime } from "./activity";
import { agentAvatar, avatarSignature } from "./avatar";
import type { HqStore } from "./types";

const PINNED_KEY = "hq.pinned";
const COLLAPSED_KEY = "hq.collapsed";
/** The "No team" section's id among the collapsed ones. */
const LOOSE_ID = "__none";
const PINNED_SIZE = 64;
const ROW_SIZE = 28;

const GLYPHS = {
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.3 15.3 20 20",
  pin: "M9 4h6l-1 5 3 3v1.5H7V12l3-3-1-5zM12 13.5V20",
  person: "M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM5 19.5a7 7 0 0 1 14 0",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  chevron: "M7 9.5l5 5 5-5",
};

function glyph(path: string, size = 16): SVGSVGElement {
  return svg(path, size, { stroke: 1.8 });
}

// ── Pins and folded sections (this window's own convenience, so localStorage) ──

function loadIds(key: string): string[] {
  try {
    const raw = JSON.parse(window.localStorage?.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(key: string, ids: string[]) {
  try {
    window.localStorage?.setItem(key, JSON.stringify(ids));
  } catch {
    // Private storage off: they last until the window reloads.
  }
}

// ── The sidebar ───────────────────────────────────────────────────────────────

export function mountSidebar(root: HTMLElement, store: HqStore): void {
  let pins = loadIds(PINNED_KEY);
  let collapsed = new Set(loadIds(COLLAPSED_KEY));
  let query = "";

  // Avatars are live canvases: kept between renders while their look holds.
  const avatars = new Map<string, { sig: string; el: HTMLElement }>();
  let used = new Set<string>();

  function avatarFor(slot: string, agent: OrchAgent, size: number, star = false): HTMLElement {
    const key = `${slot}:${agent.id}`;
    const opts = { working: store.working(agent.id), star };
    const sig = avatarSignature(agent, size, opts);
    used.add(key);
    const kept = avatars.get(key);
    if (kept && kept.sig === sig) return kept.el;
    const el = agentAvatar(agent, size, opts);
    avatars.set(key, { sig, el });
    return el;
  }

  // ── Top: search and + ──

  const searchInput = h("input", {
    class: "hq-search-input",
    type: "search",
    placeholder: tl("Search agents"),
    "aria-label": tl("Search agents"),
    spellcheck: "false",
  }) as HTMLInputElement;
  const searchBar = h("div", { class: "hq-search", hidden: true }, glyph(GLYPHS.search, 14), searchInput);

  const searchButton = h("button", { class: "hq-icon-btn", title: tl("Search agents"), "aria-label": tl("Search agents") });
  searchButton.append(glyph(GLYPHS.search));
  const plusButton = h("button", {
    class: "hq-icon-btn",
    title: tl("New"),
    "aria-label": tl("New"),
    "aria-haspopup": "menu",
  });
  plusButton.append(glyph(HUB_ICONS.plus));

  const top = h("div", { class: "hq-side-top" }, searchButton, plusButton);

  function closeSearch() {
    query = "";
    searchInput.value = "";
    searchBar.hidden = true;
    render();
  }

  searchButton.addEventListener("click", () => {
    if (!searchBar.hidden) return closeSearch();
    searchBar.hidden = false;
    searchInput.focus();
  });
  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    render();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearch();
  });

  // ── The + menu ──

  let closeMenu: (() => void) | null = null;

  function openMenu() {
    closeMenu?.();
    const item = (label: string, action: () => void) => {
      const b = h("button", { class: "hq-menu-item", role: "menuitem", text: label });
      b.addEventListener("click", () => {
        close();
        action();
      });
      return b;
    };
    const menu = h("div", { class: "hq-menu", role: "menu" },
      item(t("Ask Mochi to hire…"), askToHire),
      item(t("Create agent…"), openCreateForm),
    );
    const close = () => {
      menu.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      closeMenu = null;
    };
    const outside = (e: Event) => {
      const at = e.target as Node;
      if (!menu.contains(at) && !plusButton.contains(at)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      plusButton.focus();
    };
    root.append(menu);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    closeMenu = close;
    menu.querySelector<HTMLElement>("button")?.focus();
  }

  plusButton.addEventListener("click", () => (closeMenu ? closeMenu() : openMenu()));

  function askToHire() {
    const chief = store.chief();
    if (chief) store.select(chief.id);
    document.dispatchEvent(new CustomEvent("hq-compose", { detail: { text: t("Hire ") } }));
  }

  // ── Create agent… ──

  function openCreateForm() {
    const { teams, agents } = store.snapshot();
    let color = PILL_PALETTE[agents.length % PILL_PALETTE.length];

    const name = h("input", { class: "hq-field-input", maxlength: "60", placeholder: t("Name") }) as HTMLInputElement;
    const role = h("input", { class: "hq-field-input", maxlength: "60", placeholder: t("Role") }) as HTMLInputElement;

    const team = h("select", { class: "hq-field-input" }) as HTMLSelectElement;
    team.append(h("option", { value: "", text: t("No team") }));
    for (const tm of [...teams].sort((a, b) => a.order - b.order)) {
      team.append(h("option", { value: tm.id, text: tm.name }));
    }

    const outfit = h("select", { class: "hq-field-input" }) as HTMLSelectElement;
    outfit.append(h("option", { value: "", text: t("Default look") }));
    for (const o of OUTFIT_SELECTIONS) {
      if (o !== "auto") outfit.append(h("option", { value: o, text: OUTFIT_LABELS[o] }));
    }

    const swatches = h("div", { class: "hq-swatches", role: "group", "aria-label": t("Colour") });
    const drawSwatches = () => {
      clear(swatches);
      for (const hex of PILL_PALETTE) {
        const s = h("button", {
          type: "button",
          class: hex === color ? "hq-swatch on" : "hq-swatch",
          style: `background:${hex}`,
          title: hex,
          "aria-label": hex,
          "aria-pressed": hex === color,
        });
        s.addEventListener("click", () => {
          color = hex;
          drawSwatches();
        });
        swatches.append(s);
      }
    };
    drawSwatches();

    const error = h("div", { class: "hq-form-error", hidden: true });
    const create = h("button", { type: "submit", class: "hq-btn primary", text: t("Create"), disabled: true }) as HTMLButtonElement;
    const cancel = h("button", { type: "button", class: "hq-btn", text: t("Cancel") });
    name.addEventListener("input", () => (create.disabled = !name.value.trim()));

    const field = (label: string, control: HTMLElement) =>
      h("label", { class: "hq-field" }, h("span", { class: "hq-field-label", text: label }), control);

    const form = h("form", { class: "hq-sheet-card", role: "dialog", "aria-label": t("Create agent…") },
      h("div", { class: "hq-sheet-title", text: t("Create agent…") }),
      field(t("Name"), name),
      field(t("Role"), role),
      field(t("Team"), team),
      field(t("Colour"), swatches),
      field(t("Outfit"), outfit),
      error,
      h("div", { class: "hq-sheet-actions" }, cancel, create),
    );
    const sheet = h("div", { class: "hq-sheet" }, form);

    const close = () => {
      sheet.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    cancel.addEventListener("click", close);
    sheet.addEventListener("mousedown", (e) => {
      if (e.target === sheet) close();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const agentName = name.value.trim();
      if (!agentName) return;
      create.disabled = true;
      error.hidden = true;
      void OrchestratorBridge.createAgent({
        name: agentName,
        role: role.value.trim() || null,
        color,
        outfit: (outfit.value || null) as OrchOutfit | null,
        teamId: team.value || null,
      }).then(async ({ agent }) => {
        close();
        await store.reload();
        store.select(agent.id);
      }, (err) => {
        error.textContent = String(err);
        error.hidden = false;
        create.disabled = false;
      });
    });

    document.body.append(sheet);
    document.addEventListener("keydown", onKey, true);
    name.focus();
  }

  // ── The Activity entry ──

  const activityEntry = h("button", { class: "hq-activity-entry" },
    glyph(GLYPHS.activity, 16), h("span", { text: tl("Activity") }));
  activityEntry.addEventListener("click", () => store.setView("activity"));

  // ── Pinned faces, sections and rows ──

  const pinned = h("div", { class: "hq-pinned" });
  const list = h("div", { class: "hq-side-list" });

  function togglePin(id: string) {
    pins = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
    saveIds(PINNED_KEY, pins);
    render();
  }

  function pinTile(agent: OrchAgent, selectedId: string | null): HTMLElement {
    const chief = agent.kind === "chief";
    const tile = h("button", {
      class: agent.id === selectedId ? "hq-pin selected" : "hq-pin",
      title: agent.role ? `${agent.name} · ${agent.role}` : agent.name,
    },
      avatarFor("pin", agent, PINNED_SIZE, chief),
      h("span", { class: "hq-pin-name", text: agent.name }),
    );
    if (store.needsYou(agent.id)) tile.append(h("i", { class: "hq-needs" }));
    tile.addEventListener("click", () => store.select(agent.id));
    if (!chief) {
      tile.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        togglePin(agent.id);
      });
    }
    return tile;
  }

  function agentRow(agent: OrchAgent, selectedId: string | null): HTMLElement {
    const working = store.working(agent.id);
    const preview = store.preview(agent.id);
    const classes = ["hq-row"];
    if (agent.id === selectedId) classes.push("selected");
    if (working) classes.push("working");
    const row = h("div", { class: classes.join(" "), role: "button", tabindex: "0" },
      avatarFor("row", agent, ROW_SIZE, agent.kind === "chief"),
      h("span", { class: "hq-row-text" },
        h("span", { class: "hq-row-head" },
          h("span", { class: "hq-row-name", text: agent.name }),
          h("span", { class: "hq-row-time", text: rowTime(store.lastAt(agent.id)) }),
        ),
        h("span", { class: "hq-row-preview", text: preview || agent.role || "" }),
      ),
    );
    if (agent.kind !== "chief") {
      const isPinned = pins.includes(agent.id);
      const label = isPinned ? t("Unpin") : t("Pin");
      const pin = h("button", { class: isPinned ? "hq-row-pin on" : "hq-row-pin", title: label, "aria-label": label });
      pin.append(glyph(GLYPHS.pin, 14));
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePin(agent.id);
      });
      row.append(pin);
    }
    if (store.needsYou(agent.id)) row.append(h("i", { class: "hq-needs", title: t("Needs you") }));
    row.addEventListener("click", () => store.select(agent.id));
    row.addEventListener("keydown", (e) => {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      store.select(agent.id);
    });
    return row;
  }

  function toggleSection(id: string) {
    collapsed = new Set(collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    saveIds(COLLAPSED_KEY, [...collapsed]);
    render();
  }

  /** A section; with an `id`, its header folds it. */
  function section(title: string | null, members: OrchAgent[], selectedId: string | null, id?: string): HTMLElement {
    const folded = !!id && collapsed.has(id);
    const el = h("section", { class: folded ? "hq-section collapsed" : "hq-section" });
    if (title && id) {
      const head = h("button", { class: "hq-section-title hq-section-toggle", "aria-expanded": !folded },
        h("span", { class: "hq-section-name", text: title }), glyph(GLYPHS.chevron, 12));
      head.addEventListener("click", () => toggleSection(id));
      el.append(head);
    } else if (title) {
      el.append(h("div", { class: "hq-section-title", text: title }));
    }
    if (!folded) for (const agent of members) el.append(agentRow(agent, selectedId));
    return el;
  }

  function render() {
    const snap = store.snapshot();
    used = new Set();
    const scroll = list.scrollTop;
    clear(pinned);
    clear(list);

    const byOrder = (a: OrchAgent, b: OrchAgent) => a.order - b.order || a.name.localeCompare(b.name);
    // Within a section, the newest conversation first; never-used ones after, in order.
    const byRecent = (a: OrchAgent, b: OrchAgent) =>
      (store.lastAt(b.id) ?? "").localeCompare(store.lastAt(a.id) ?? "") || byOrder(a, b);
    const chief = snap.agents.find((a) => a.kind === "chief");
    const coworkers = snap.agents.filter((a) => a.kind !== "chief").sort(byOrder);
    // Agent rows show selected only while their conversation is on screen.
    const selectedId = snap.view === "chat" ? snap.selectedId : null;
    activityEntry.classList.toggle("selected", snap.view === "activity");
    activityEntry.setAttribute("aria-pressed", String(snap.view === "activity"));

    if (!snap.agents.length && snap.error) {
      list.append(h("div", { class: "hq-side-empty", text: snap.error }));
    } else if (query) {
      // Searching: one flat list of who matches, the chief included.
      const hits = [chief, ...coworkers].filter((a): a is OrchAgent =>
        !!a && (a.name.toLowerCase().includes(query) || (a.role ?? "").toLowerCase().includes(query)));
      if (hits.length) list.append(section(null, hits, selectedId));
      else list.append(h("div", { class: "hq-side-empty", text: t("No agents match.") }));
    } else {
      const faces = [chief, ...pins.map((id) => coworkers.find((a) => a.id === id))]
        .filter((a): a is OrchAgent => !!a);
      for (const agent of faces) pinned.append(pinTile(agent, selectedId));

      // Who waits for the user comes first, and only there.
      const needs = [chief, ...coworkers].filter((a): a is OrchAgent => !!a && store.needsYou(a.id));
      if (needs.length) list.append(section(t("Needs you"), [...needs].sort(byRecent), selectedId));
      const rest = coworkers.filter((a) => !needs.includes(a));

      const teamIds = new Set(snap.teams.map((tm) => tm.id));
      for (const team of [...snap.teams].sort((a, b) => a.order - b.order)) {
        const members = rest.filter((a) => a.teamId === team.id).sort(byRecent);
        if (members.length) list.append(section(team.name, members, selectedId, team.id));
      }
      const loose = rest.filter((a) => !a.teamId || !teamIds.has(a.teamId)).sort(byRecent);
      if (loose.length) list.append(section(t("No team"), loose, selectedId, LOOSE_ID));
    }
    pinned.hidden = !pinned.firstChild;
    list.scrollTop = scroll;

    // Forget the avatars no longer shown; main.ts prunes their canvases.
    for (const key of avatars.keys()) if (!used.has(key)) avatars.delete(key);
  }

  // ── Bottom: settings and Connect apps ──

  const me = h("button", { class: "hq-me", title: tl("Settings"), "aria-label": tl("Settings") });
  me.append(glyph(GLYPHS.person, 18));
  me.addEventListener("click", () => void Bridge.openHubPage("general"));
  const connect = h("button", { class: "hq-connect" }, glyph(HUB_ICONS.puzzle, 16), h("span", { text: tl("Connect apps") }));
  connect.addEventListener("click", () => void Bridge.openHubPage("integrations"));
  const bottom = h("div", { class: "hq-side-bottom" }, me, connect);

  root.append(top, searchBar, activityEntry, pinned, list, bottom);
  store.subscribe(render);
  render();
}
