// Coucou HQ: the conversation itself, one element per ThreadItem. Elements are
// kept by `item.key` and only redrawn when what they show changed, so a live
// line ticking or a new message never rebuilds the whole thread (and the
// minis in the exchanges keep their animation).

import type { OrchApproval } from "../core/orchestrator";
import { approvalLabel } from "../core/orchestrator";
import { language, t, tl, tn } from "../i18n/i18n";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { renderMarkdown } from "../views/markdown";
import { agentAvatar } from "./avatar";
import type { ExchangeMessage, HqStore, ThreadItem } from "./types";

export interface ThreadView {
  el: HTMLElement;
  /** Shows `items` for `agentId`; true when an element was added. */
  render(agentId: string, items: ThreadItem[]): boolean;
  /** Forgets every element (another agent is on screen). */
  reset(): void;
}

interface Entry {
  sig: string;
  el: HTMLElement;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(language(), options).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** "12:27 AM", "Yesterday 12:27 AM", "Monday 9:02 AM", "Oct 3, 2026, 4:10 PM". */
export function separatorLabel(at: string, now = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = format(date, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return t("Yesterday {time}", { time });
  if (days < 7) return `${format(date, { weekday: "long" })} ${time}`;
  return format(date, { dateStyle: "medium", timeStyle: "short" });
}

/** "Ada and Linus", "Ada, Linus and Grace", in the language's own words. */
function nameList(names: string[]): string {
  try {
    return new Intl.ListFormat(language(), { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

// ── The view ──────────────────────────────────────────────────────────────────

export function createThread(store: HqStore): ThreadView {
  const el = h("div", { class: "hq-thread", role: "log", "aria-live": "polite" });
  let entries = new Map<string, Entry>();
  /** The exchanges the user opened, kept across redraws. */
  const open = new Set<string>();

  const name = (id: string) => store.agent(id)?.name ?? id;

  /** What an item shows: when it is the same, its element is kept as it is. */
  function signature(item: ThreadItem): string {
    const base = `${language()}|${JSON.stringify(item)}`;
    if (item.kind !== "exchange") return base;
    // The names and faces come from the agents, which can change on their own.
    const ids = new Set([...item.withAgentIds, ...item.messages.flatMap((m) => [m.fromAgentId, m.toAgentId])]);
    const faces = [...ids].map((id) => {
      const a = store.agent(id);
      return a ? `${a.name}:${a.color ?? ""}:${a.outfit ?? ""}` : id;
    });
    return `${base}|${faces.join(",")}`;
  }

  function build(agentId: string, item: ThreadItem): HTMLElement {
    switch (item.kind) {
      case "time":
        return h("div", { class: "hq-separator", text: separatorLabel(item.at) });
      case "user":
        return h("div", { class: "hq-thread-row user" }, h("div", { class: "hq-bubble user", text: item.text }));
      case "agent":
        return agentMessage(agentId, item);
      case "exchange":
        return exchange(item);
      case "live":
        return h(
          "div",
          { class: "hq-live" },
          h("span", { class: "hq-typing", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("span", { class: "hq-live-line", text: item.line || t("Working…") }),
        );
      case "approval":
        return approvalCard(item.approval);
      case "question":
        return questionCard(item);
    }
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  function agentMessage(agentId: string, item: Extract<ThreadItem, { kind: "agent" }>): HTMLElement {
    const bubble = h("div", { class: item.failed ? "hq-bubble agent failed" : "hq-bubble agent" });
    const body = h("div", { class: "hq-md" });
    renderMarkdown(body, item.markdown);
    if (item.failed) bubble.append(h("div", { class: "hq-failed", text: t("Failed") }));
    bubble.append(body);
    const row = h("div", { class: "hq-thread-row agent" }, bubble);
    if (item.artifacts.length) {
      const files = h("div", { class: "hq-files" });
      for (const path of item.artifacts) files.append(fileChip(item.agentId || agentId, item.taskId, path));
      row.append(files);
    }
    return row;
  }

  /** A file the task made: a click saves it where the user picks. */
  function fileChip(agentId: string, taskId: string, path: string): HTMLElement {
    const fileName = path.split(/[\\/]/).pop() || path;
    const status = h("span", { class: "hq-file-status", text: t("Save") });
    const chip = h(
      "button",
      { class: "hq-file", title: path },
      h("span", { class: "hq-file-icon" }, svg(ICONS.doc, 20)),
      h("span", { class: "hq-file-text" }, h("span", { class: "hq-file-name", text: fileName }), status),
    );
    chip.addEventListener("click", () => {
      chip.disabled = true;
      status.textContent = t("Saving…");
      void store.saveFile(agentId, taskId, path).then(
        (saved) => {
          status.textContent = saved ? t("Saved") : t("Save");
          if (saved) chip.title = saved;
        },
        (err) => {
          status.textContent = t("Couldn't save: {error}", { error: String(err) });
        },
      ).finally(() => (chip.disabled = false));
    });
    return chip;
  }

  // ── Agents among themselves ───────────────────────────────────────────────

  function faces(ids: string[], size: number): HTMLElement {
    const row = h("span", { class: "hq-faces" });
    for (const id of ids.slice(0, 3)) {
      const agent = store.agent(id);
      if (agent) row.append(agentAvatar(agent, size));
    }
    return row;
  }

  function exchange(item: Extract<ThreadItem, { kind: "exchange" }>): HTMLElement {
    const names = item.withAgentIds.map(name);
    const line = h(
      "button",
      { class: "hq-exchange-line", "aria-expanded": "false" },
      h("span", { text: tn("{count} message with", "{count} messages with", item.messages.length) }),
      faces(item.withAgentIds, 16),
      h("span", { class: "hq-exchange-names", text: nameList(names) }),
      h("span", { class: "hq-chevron" }, svg(ICONS.chevronRight, 12, { stroke: 2 })),
    );
    const wrap = h("div", { class: "hq-exchange" }, line);
    let body: HTMLElement | null = null;

    const show = (on: boolean) => {
      wrap.classList.toggle("open", on);
      line.setAttribute("aria-expanded", String(on));
      if (on && !body) {
        body = h("div", { class: "hq-exchange-body" });
        for (const message of item.messages) body.append(exchangeMessage(message));
        wrap.append(body);
      } else if (!on && body) {
        body.remove();
        body = null;
      }
    };
    line.addEventListener("click", () => {
      const on = !open.has(item.key);
      if (on) open.add(item.key);
      else open.delete(item.key);
      show(on);
    });
    if (open.has(item.key)) show(true);
    return wrap;
  }

  function exchangeMessage(message: ExchangeMessage): HTMLElement {
    const from = store.agent(message.fromAgentId);
    const text = h("div", { class: "hq-md" });
    renderMarkdown(text, message.text);
    return h(
      "div",
      { class: "hq-exchange-message" },
      h(
        "div",
        { class: "hq-exchange-who" },
        from ? agentAvatar(from, 16) : null,
        h("span", { text: t("{from} to {to}", { from: name(message.fromAgentId), to: name(message.toAgentId) }) }),
      ),
      text,
    );
  }

  // ── Waiting for the user ────────────────────────────────────────────────────

  /** Approve and Reject: nothing is decided without one of these clicks. */
  function approvalCard(approval: OrchApproval): HTMLElement {
    const note = h("div", { class: "hq-card-note" });
    const approve = h("button", { class: "hq-conv-btn accent", text: tl("Approve") });
    const reject = h("button", { class: "hq-conv-btn", text: tl("Reject") });
    const decide = (yes: boolean) => {
      approve.disabled = reject.disabled = true;
      note.textContent = "";
      void store.decide(approval, yes).catch((err) => {
        note.textContent = String(err);
        approve.disabled = reject.disabled = false;
      });
    };
    approve.addEventListener("click", () => decide(true));
    reject.addEventListener("click", () => decide(false));
    return h(
      "div",
      { class: "hq-thread-row agent" },
      h(
        "div",
        { class: "hq-card approval" },
        h("div", { class: "hq-card-kicker", text: t("{name} needs your approval", { name: name(approval.agentId) }) }),
        h("div", { class: "hq-card-title", text: approvalLabel(approval.op) }),
        approval.target ? h("code", { class: "hq-target", text: approval.target }) : null,
        approval.reason ? h("div", { class: "hq-card-reason", text: approval.reason }) : null,
        h("div", { class: "hq-card-actions" }, approve, reject),
        note,
      ),
    );
  }

  function questionCard(item: Extract<ThreadItem, { kind: "question" }>): HTMLElement {
    const text = h("div", { class: "hq-md" });
    renderMarkdown(text, item.text);
    const note = h("div", { class: "hq-card-note" });
    const card = h("div", { class: "hq-card question" }, text);
    if (item.options.length) {
      const chips = h("div", { class: "hq-chips" });
      for (const option of item.options) {
        const chip = h("button", { class: "hq-chip-option", text: option });
        chip.addEventListener("click", () => {
          for (const c of chips.querySelectorAll("button")) c.disabled = true;
          note.textContent = "";
          void store.answer(item.taskId, item.questionId, option).catch((err) => {
            note.textContent = String(err);
            for (const c of chips.querySelectorAll("button")) c.disabled = false;
          });
        });
        chips.append(chip);
      }
      card.append(chips);
    }
    card.append(h("div", { class: "hq-card-hint", text: tl("Answer in the box below") }), note);
    return h("div", { class: "hq-thread-row agent" }, card);
  }

  // ── Keyed rendering ─────────────────────────────────────────────────────────

  function render(agentId: string, items: ThreadItem[]): boolean {
    const next = new Map<string, Entry>();
    let added = false;
    for (const item of items) {
      const sig = signature(item);
      const kept = entries.get(item.key);
      if (kept && kept.sig === sig) {
        next.set(item.key, kept);
        continue;
      }
      const fresh = build(agentId, item);
      if (kept) kept.el.replaceWith(fresh);
      else added = true;
      next.set(item.key, { sig, el: fresh });
    }
    for (const [key, entry] of entries) if (!next.has(key)) entry.el.remove();
    entries = next;

    // Put the elements in order, moving only those out of place.
    let at = el.firstElementChild;
    for (const { el: node } of next.values()) {
      if (node === at) {
        at = at.nextElementSibling;
        continue;
      }
      el.insertBefore(node, at);
    }
    return added;
  }

  function reset() {
    entries = new Map();
    open.clear();
    el.replaceChildren();
  }

  return { el, render, reset };
}
