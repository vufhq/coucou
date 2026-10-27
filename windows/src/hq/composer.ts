// Coucou HQ: the box at the bottom of the conversation. Enter sends, Shift+Enter
// makes a new line; the + holds Pause / Resume and "New goal…"; the mic
// dictates into the box, on this computer (Coucou's voice model). Above it, a
// slim line says when the agent is working (with Stop) or waiting. Other
// parts prefill it with `document.dispatchEvent(new CustomEvent("hq-compose",
// { detail: { text } }))`.
//
// Files dropped on the window, or picked from the + menu, go to the backend
// at once and wait above the box as chips until the message leaves; GitHub
// links typed in the box show there too. The agent's computer gets both
// before the agent starts.

import { Bridge, canPickFiles, onDragDrop, onEvent, sendPickedFiles } from "../core/bridge";
import { FlowBridge } from "../core/flow";
import type { OrchAgent, OrchTask } from "../core/orchestrator";
import { OrchestratorBridge, taskComputerId } from "../core/orchestrator";
import { language, t, tl } from "../i18n/i18n";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { githubLinks, sizeLabel } from "./model";
import type { HqStore, SentFile } from "./types";

export interface Composer {
  el: HTMLElement;
  /** The agent the box writes to; undefined hides nothing but disables sending. */
  setAgent(agent: OrchAgent | undefined): void;
  /** Puts `text` in the box, caret at the end, and focuses it. */
  fill(text: string): void;
  focus(): void;
}

const MAX_HEIGHT = 200;

/** At most this many files go with one message (the backend's limit). */
export const MAX_FILES = 8;

/** A file waiting above the box: on its way to the backend, there, or refused. */
interface PendingFile {
  key: number;
  name: string;
  state: "sending" | "ready" | "failed";
  sent?: SentFile;
  error?: string;
}

/** A microphone, stroked. */
const MIC = "M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v3.5";

/** What the line above the box says about the agent's current task. */
export type WorkState = "working" | "computer" | "queued" | "team" | "paused";

/**
 * The line for `task` (the agent's current one). `computerTaken`: every
 * computer is as busy as it gets. Null when nothing is said: no task, or
 * one waiting for the user (the thread shows the card).
 */
export function workState(task: Pick<OrchTask, "status"> | null, computerTaken: boolean): WorkState | null {
  switch (task?.status) {
    case "starting":
    case "running":
      return "working";
    case "queued":
      return computerTaken ? "computer" : "queued";
    case "waiting_for_agents":
      return "team";
    case "paused":
      return "paused";
    default:
      return null;
  }
}

/** Statuses during which a task holds its computer. */
const ON_COMPUTER = new Set<OrchTask["status"]>(["starting", "running", "waiting_for_approval"]);

/** `onSent` runs as soon as a message leaves, so the thread can jump to the bottom. */
export function createComposer(store: HqStore, onSent: () => void): Composer {
  let agent: OrchAgent | undefined;
  let sending = false;
  /** The mic: off, listening, or turning what was heard into words. */
  let dictation: "off" | "listening" | "thinking" = "off";

  const area = h("textarea", { class: "hq-composer-input", rows: "1", spellcheck: "true" }) as HTMLTextAreaElement;
  const send = h("button", { class: "hq-send", title: tl("Send"), "aria-label": tl("Send") }, svg(ICONS.arrowUp, 18));
  const plus = h("button", { class: "hq-composer-plus", title: tl("More"), "aria-label": tl("More"), "aria-haspopup": "menu" }, svg(ICONS.plus, 18));
  const note = h("div", { class: "hq-composer-note", role: "status" });
  const status = h("div", { class: "hq-composer-status", hidden: true });
  const mic = h("button", { class: "hq-mic", title: tl("Dictate"), "aria-label": tl("Dictate"), "aria-pressed": "false" }, svg(MIC, 18, { stroke: 1.8 }));
  const tray = h("div", { class: "hq-composer-tray", hidden: true });
  const pill = h("div", { class: "hq-composer" }, plus, area, mic, send);
  const el = h("div", { class: "hq-composer-wrap" }, status, note, tray, pill);

  let pending: PendingFile[] = [];
  let nextKey = 0;
  let traySig = "";

  const sync = () => {
    area.style.height = "auto";
    area.style.height = `${Math.min(MAX_HEIGHT, area.scrollHeight)}px`;
    area.style.overflowY = area.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    const ready = pending.some((file) => file.state === "ready");
    const uploading = pending.some((file) => file.state === "sending");
    send.disabled = !agent || sending || dictation !== "off" || uploading || (!area.value.trim() && !ready);
    drawTray();
  };

  // ── Files and links ─────────────────────────────────────────────────────────

  function chip(name: string, detail: string, icon: string, remove?: () => void, failed = false): HTMLElement {
    const el = h(
      "div",
      { class: failed ? "hq-composer-chip failed" : "hq-composer-chip", title: name },
      h("span", { class: "hq-composer-chip-icon" }, svg(icon, 16, icon === ICONS.pull ? { stroke: 1.8 } : undefined)),
      h("span", { class: "hq-composer-chip-text" }, h("span", { class: "hq-composer-chip-name", text: name }), h("span", { class: "hq-composer-chip-detail", text: detail })),
    );
    if (remove) {
      const x = h("button", { class: "hq-composer-chip-remove", title: t("Remove"), "aria-label": t("Remove") }, svg(ICONS.xmark, 12));
      x.addEventListener("click", remove);
      el.append(x);
    }
    return el;
  }

  function drawTray() {
    const links = githubLinks(area.value);
    const sig = `${language()}|${pending.map((f) => `${f.key}:${f.state}`).join(",")}|${links.join(",")}`;
    if (sig === traySig) return;
    traySig = sig;
    const chips: HTMLElement[] = pending.map((file) => {
      const detail =
        file.state === "sending" ? t("Sending…") : file.state === "failed" ? (file.error ?? "") : sizeLabel(file.sent?.bytes ?? 0);
      return chip(file.name, detail, ICONS.doc, () => {
        pending = pending.filter((other) => other.key !== file.key);
        sync();
      }, file.state === "failed");
    });
    // Typed links: the agent clones them; taking the link out of the text takes the chip away.
    for (const url of links) chips.push(chip(url.slice("https://github.com/".length), t("GitHub repository"), ICONS.pull));
    tray.hidden = chips.length === 0;
    tray.replaceChildren(...chips);
  }

  /** Paths a drop or the file chooser just delivered: each goes to the backend now. */
  function attach(paths: readonly string[]) {
    if (!agent || !paths.length) return;
    note.textContent = "";
    const room = MAX_FILES - pending.length;
    if (paths.length > room) note.textContent = t("At most {count} files per message.", { count: String(MAX_FILES) });
    for (const path of paths.slice(0, Math.max(0, room))) {
      const file: PendingFile = { key: nextKey++, name: path.split(/[\\/]/).pop() || path, state: "sending" };
      pending.push(file);
      void OrchestratorBridge.attach(path).then(
        ({ attachment }) => {
          file.state = "ready";
          file.sent = attachment;
        },
        (err) => {
          file.state = "failed";
          file.error = String(err);
        },
      ).finally(sync);
    }
    sync();
  }

  const picker = h("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
  picker.addEventListener("change", () => {
    if (picker.files) sendPickedFiles(picker.files);
    picker.value = "";
  });
  el.append(picker);

  void onDragDrop((e) => {
    if (e.type === "drop") {
      pill.classList.remove("dropping");
      if (!agent) return;
      attach(e.paths ?? []);
    } else if (e.type === "leave") {
      pill.classList.remove("dropping");
    } else if (agent) {
      pill.classList.add("dropping");
    }
  });

  const submit = () => {
    const ready = pending.filter((file) => file.state === "ready" && file.sent);
    const files = ready.map((file) => file.sent!);
    const text = area.value.trim() || (files.length ? t("Here are some files.") : "");
    if (!agent || sending || !text || pending.some((file) => file.state === "sending")) return;
    const to = agent.id;
    const typed = area.value;
    sending = true;
    note.textContent = "";
    area.value = "";
    pending = pending.filter((file) => !ready.includes(file));
    sync();
    onSent();
    void store.send(to, text, files).then(
      () => {},
      (err) => {
        // Nothing lost: what was typed and attached comes back, unless something new was typed since.
        if (!area.value.trim()) area.value = typed;
        pending = [...ready, ...pending];
        note.textContent = t("Couldn't send: {error}", { error: String(err) });
      },
    ).finally(() => {
      sending = false;
      sync();
    });
  };

  area.addEventListener("input", sync);
  area.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submit();
  });
  send.addEventListener("click", submit);
  pill.addEventListener("mousedown", (e) => {
    // A click on the pill's padding goes to the box.
    if (e.target === pill) {
      e.preventDefault();
      area.focus();
    }
  });

  // ── Dictation ───────────────────────────────────────────────────────────────

  function drawMic() {
    mic.classList.toggle("listening", dictation === "listening");
    mic.classList.toggle("thinking", dictation === "thinking");
    mic.setAttribute("aria-pressed", String(dictation === "listening"));
    const label = dictation === "listening" ? t("Stop dictating") : dictation === "thinking" ? t("Writing it down…") : t("Dictate");
    mic.title = label;
    mic.setAttribute("aria-label", label);
    mic.disabled = !agent || dictation === "thinking";
    area.classList.toggle("dictating", dictation !== "off");
    const placeholder =
      dictation === "listening" ? t("Listening…") : agent ? t("Message {name}", { name: agent.name }) : "";
    if (area.placeholder !== placeholder) area.placeholder = placeholder;
    sync();
  }

  /** Puts the dictated words where the caret is, with a space on each side as needed. */
  function insert(words: string) {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    const before = area.value.slice(0, start);
    const after = area.value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    area.value = before + lead + words + tail + after;
    const caret = (before + lead + words).length;
    area.focus();
    area.setSelectionRange(caret, caret);
  }

  async function startDictation() {
    note.replaceChildren();
    try {
      await FlowBridge.hqDictationStart();
      dictation = "listening";
    } catch (err) {
      if (String(err).includes("models")) {
        // The voice model is downloaded once, in Coucou's settings.
        const open = h("button", { class: "hq-composer-note-link", text: tl("Open Settings") });
        open.addEventListener("click", () => void Bridge.openHubPage("settings"));
        note.replaceChildren(h("span", { text: t("Dictation needs Coucou's voice model. Download it in Settings → Recognition.") }), " ", open);
      } else {
        note.textContent = t("Couldn't open the microphone: {error}", { error: String(err) });
      }
    }
    drawMic();
  }

  async function stopDictation() {
    dictation = "thinking";
    drawMic();
    try {
      const words = (await FlowBridge.hqDictationStop()).trim();
      if (words) insert(words);
    } catch (err) {
      note.textContent = t("Couldn't write it down: {error}", { error: String(err) });
    }
    dictation = "off";
    drawMic();
  }

  /** Drops what was heard: the window went away, Escape, or another agent. */
  function cancelDictation() {
    if (dictation !== "listening") return;
    dictation = "off";
    void FlowBridge.hqDictationCancel();
    drawMic();
  }

  mic.addEventListener("click", () => {
    if (dictation === "off") void startDictation();
    else if (dictation === "listening") void stopDictation();
  });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dictation === "listening") {
      e.preventDefault();
      cancelDictation();
    }
  });
  // The microphone never stays open behind a hidden window.
  void onEvent<boolean>("hq-visible", (shown) => {
    if (!shown) cancelDictation();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") cancelDictation();
  });

  // ── The + menu ──────────────────────────────────────────────────────────────

  let closeMenu: (() => void) | null = null;

  function openMenu() {
    if (!agent) return;
    const current = agent;
    const menu = h("div", { class: "hq-composer-menu", role: "menu" });
    const item = (label: string, action: () => void) => {
      const b = h("button", { class: "hq-composer-menu-item", role: "menuitem", text: label });
      b.addEventListener("click", () => {
        close();
        action();
      });
      menu.append(b);
    };
    // The chooser's files come back through Rust like a drop (WebView2 only; elsewhere, drop them).
    if (canPickFiles()) item(t("Attach files…"), () => picker.click());
    item(current.paused ? t("Resume") : t("Pause"), () => {
      const action = current.paused
        ? OrchestratorBridge.resumeAgent(current.id)
        : OrchestratorBridge.pauseAgent(current.id);
      void action.then(() => store.reload(), (err) => (note.textContent = String(err)));
    });
    // The side panel opens on this agent with the form (panel.ts).
    item(t("New goal…"), () => document.dispatchEvent(new CustomEvent("hq-new-goal")));

    const close = () => {
      menu.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      plus.setAttribute("aria-expanded", "false");
      closeMenu = null;
    };
    const outside = (e: Event) => {
      const at = e.target as Node;
      if (!menu.contains(at) && !plus.contains(at)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        plus.focus();
      }
    };
    el.append(menu);
    plus.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    closeMenu = close;
    menu.querySelector<HTMLElement>("button")?.focus();
  }

  plus.addEventListener("click", () => (closeMenu ? closeMenu() : openMenu()));

  // ── Working or waiting ──────────────────────────────────────────────────────

  let statusSig = "";
  /** The task a Stop click is cancelling, so the button stays disabled meanwhile. */
  let stopping: string | null = null;

  /** Other agents' tasks fill every computer `agent` could run on. */
  function computerTaken(of: OrchAgent): boolean {
    const snap = store.snapshot();
    const load = new Map<string, number>();
    for (const other of snap.agents) {
      const task = other.id === of.id ? null : store.current(other.id);
      if (!task || !ON_COMPUTER.has(task.status)) continue;
      const id = taskComputerId(task, other);
      load.set(id, (load.get(id) ?? 0) + 1);
    }
    // An older backend runs one task per computer, each agent on its own.
    const pool = snap.computers.some((c) => c.capacity) ? snap.computers : snap.computers.filter((c) => c.id === of.computerId);
    return pool.length > 0 && pool.every((c) => (load.get(c.id) ?? 0) >= (c.capacity ?? 1));
  }

  function drawStatus() {
    const task = agent ? store.current(agent.id) : null;
    const state = agent ? workState(task, computerTaken(agent)) : null;
    const sig = state && agent && task ? `${language()}|${agent.name}|${state}|${task.id}|${stopping === task.id}` : "";
    if (sig === statusSig) return;
    statusSig = sig;
    status.hidden = !state;
    if (!state || !agent || !task) return status.replaceChildren();
    const words: Record<WorkState, string> = {
      working: t("{name} is working…", { name: agent.name }),
      computer: t("Waiting for the computer"),
      queued: t("Queued"),
      team: t("Waiting for the team"),
      paused: t("Paused"),
    };
    const children: Node[] = [];
    if (state === "working") children.push(h("span", { class: "hq-typing small", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
    children.push(h("span", { class: "hq-composer-status-line", text: words[state] }));
    if (state === "working") {
      // Cancels the task: only ever from this click.
      const stop = h("button", { class: "hq-composer-stop", text: tl("Stop"), disabled: stopping === task.id });
      stop.addEventListener("click", () => {
        stopping = task.id;
        note.textContent = "";
        drawStatus();
        void store.stop(task.id).catch((err) => {
          note.textContent = t("Couldn't stop: {error}", { error: String(err) });
        }).finally(() => {
          stopping = null;
          drawStatus();
        });
      });
      children.push(stop);
    }
    status.replaceChildren(...children);
  }

  // ── Outside ─────────────────────────────────────────────────────────────────

  const focus = () => {
    area.focus();
    const end = area.value.length;
    area.setSelectionRange(end, end);
  };

  const fill = (text: string) => {
    area.value = text;
    sync();
    focus();
  };

  document.addEventListener("hq-compose", (e) => {
    const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
    fill(typeof text === "string" ? text : "");
  });

  function setAgent(next: OrchAgent | undefined) {
    if (next?.id !== agent?.id) {
      closeMenu?.();
      cancelDictation();
      note.textContent = "";
    }
    agent = next;
    const placeholder = next ? t("Message {name}", { name: next.name }) : "";
    if (area.placeholder !== placeholder) area.placeholder = placeholder;
    area.disabled = !next;
    plus.disabled = !next;
    drawMic();
    drawStatus();
  }

  sync();
  return { el, setAgent, fill, focus };
}
