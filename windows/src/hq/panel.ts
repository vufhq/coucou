// Coucou HQ: the side panel on the right, for the selected agent.
// - "agent": the shared computer (who uses it, who waits), the agent's goals
//   (Run now, pause, + New goal), its memory notes and the files its tasks made.
// - "settings": who the agent is (name, role, instructions, team, colour,
//   outfit), each saved as soon as it changes, then Pause / Resume and Retire.
// Goals and memory are fetched when the panel opens or the agent changes, and
// again on the backend's goal.updated / memory.updated events while it shows.

import { onEvent } from "../core/bridge";
import {
  OrchestratorBridge,
  agentLine,
  newTaskKey,
  type GoalSchedule,
  type MemoryNote,
  type OrchAgent,
  type OrchComputer,
  type OrchEvent,
  type OrchGoal,
  type OrchOutfit,
  type OrchTask,
} from "../core/orchestrator";
import { PILL_PALETTE } from "../core/pill-colors";
import { t, tl } from "../i18n/i18n";
import { OUTFIT_LABELS, OUTFIT_SELECTIONS } from "../mochi/wardrobe";
import { HUB_ICONS } from "../hub/ui";
import { ICONS } from "../views/icons";
import { clear, h, svg } from "../views/dom";
import { agentAvatar, avatarColor, avatarSignature } from "./avatar";
import type { HqPanel, HqStore } from "./types";

type Changes = Parameters<typeof OrchestratorBridge.updateAgent>[1];

/** Backend events are gathered this long before goals or memory are fetched again. */
const REFETCH_MS = 300;

const reason = (err: unknown) => String(err).replace(/^Error:\s*/, "");
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Holding the computer right now. */
const USING: ReadonlySet<OrchTask["status"]> = new Set(["starting", "running", "waiting_for_approval"]);

interface GoalDraft {
  title: string;
  instructions: string;
  kind: GoalSchedule["kind"];
  hours: number;
  time: string;
}

const emptyDraft = (): GoalDraft => ({ title: "", instructions: "", kind: "manual", hours: 24, time: "09:00" });

export function mountPanel(root: HTMLElement, store: HqStore): void {
  const head = h("div", { class: "hq-pnl-head" });
  const body = h("div", { class: "hq-pnl-body hq-scroll" });
  root.append(head, body);

  // What is built now: rebuilt when the panel or the agent changes.
  let builtPanel: HqPanel | null = null;
  let builtAgentId: string | null = null;

  // ── The agent panel's state ─────────────────────────────────────────────────

  let goals: OrchGoal[] | null = null;
  let goalsError = "";
  let notes: MemoryNote[] | null = null;
  let notesError = "";
  /** The New goal form, while it is open. */
  let draft: GoalDraft | null = null;
  /** `hq-new-goal` asked for the form: focus its title once it is drawn. */
  let focusDraft = false;
  /** The Add a note box, while it is open. */
  let noteDraft: string | null = null;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;

  const computerEl = h("section", { class: "hq-pnl-section" });
  // Goals and memory: the list is redrawn on every fetch, the form only when it
  // opens or closes, so a refetch never takes the box the user is typing in.
  const goalsList = h("div", { class: "hq-pnl-list" });
  const goalsForm = h("div");
  const goalsEl = h("section", { class: "hq-pnl-section" }, h("div", { class: "hq-pnl-label", text: tl("Goals") }), goalsList, goalsForm);
  const memoryList = h("div", { class: "hq-pnl-list" });
  const memoryForm = h("div");
  const memoryEl = h("section", { class: "hq-pnl-section" }, h("div", { class: "hq-pnl-label", text: tl("Memory") }), memoryList, memoryForm);
  /** The draft the goal form on screen was built for ("closed" when none is). */
  let formFor: GoalDraft | "closed" | null = null;
  let noteFormOpen: boolean | null = null;
  const filesEl = h("section", { class: "hq-pnl-section" });
  let computerSig = "";
  let filesSig = "";

  // The settings panel: rebuilt when the agent changes, unless the user is typing in it.
  let settingsSig = "";
  let redrawOnBlur = false;

  const shownAgent = (): OrchAgent | undefined => {
    const snap = store.snapshot();
    if (snap.view !== "chat" || !snap.panel || !snap.selectedId) return undefined;
    return store.agent(snap.selectedId);
  };

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function render() {
    const snap = store.snapshot();
    const agent = shownAgent();
    if (!agent || !snap.panel) {
      // Hidden: forget what was built so the next opening fetches again.
      if (builtPanel || builtAgentId) {
        builtPanel = null;
        builtAgentId = null;
        clear(head);
        clear(body);
      }
      return;
    }
    const fresh = builtPanel !== snap.panel || builtAgentId !== agent.id;
    if (fresh) {
      const agentChanged = builtAgentId !== agent.id;
      builtPanel = snap.panel;
      builtAgentId = agent.id;
      if (agentChanged || snap.panel === "agent") resetAgentState(agentChanged);
      drawHead(agent, snap.panel);
      clear(body);
      if (snap.panel === "agent") {
        body.append(computerEl, goalsEl, memoryEl, filesEl);
        computerSig = filesSig = "";
        formFor = noteFormOpen = null;
        drawGoals();
        drawMemory();
        void fetchAgentData(agent.id);
      } else {
        settingsSig = "";
      }
    } else {
      // Same panel: the agent's name may have changed.
      const title = head.querySelector(".hq-pnl-title");
      if (title) title.textContent = headTitle(agent, snap.panel);
    }
    if (snap.panel === "agent") {
      drawComputer(agent);
      drawFiles(agent);
    } else {
      drawSettings(agent);
    }
  }

  /** Opening the agent panel fetches anew; a new agent also drops the forms. */
  function resetAgentState(agentChanged: boolean) {
    goals = null;
    notes = null;
    goalsError = notesError = "";
    if (agentChanged) {
      if (!focusDraft) draft = null;
      noteDraft = null;
    }
  }

  function headTitle(agent: OrchAgent, panel: HqPanel): string {
    return panel === "agent" ? t("{name}'s computer", { name: agent.name }) : t("Settings");
  }

  function drawHead(agent: OrchAgent, panel: HqPanel) {
    clear(head);
    if (panel === "settings") {
      head.append(iconButton(svg(ICONS.chevronLeft, 16, { stroke: 2 }), t("Back"), () => store.setPanel("agent")));
    }
    head.append(h("div", { class: "hq-pnl-title", text: headTitle(agent, panel) }));
    if (panel === "agent") {
      head.append(iconButton(svg(ICONS.gearFill, 16), t("Settings"), () => store.setPanel("settings")));
    }
    head.append(iconButton(svg(ICONS.xmark, 14), t("Close"), () => store.setPanel(null)));
  }

  // ── The computer ────────────────────────────────────────────────────────────

  function drawComputer(agent: OrchAgent) {
    const snap = store.snapshot();
    const computer: OrchComputer | undefined =
      snap.computers.find((c) => c.id === agent.computerId) ?? snap.computers[0];
    const users: string[] = [];
    const waiting: string[] = [];
    let mine: "using" | "waiting" | null = null;
    if (computer) {
      for (const other of snap.agents) {
        if (other.computerId !== computer.id && !computer.agentIds.includes(other.id)) continue;
        const task = store.current(other.id);
        if (!task) continue;
        if (USING.has(task.status)) {
          users.push(other.name);
          if (other.id === agent.id) mine = "using";
        } else if (task.status === "queued") {
          waiting.push(other.name);
          if (other.id === agent.id) mine = "waiting";
        }
      }
    }
    const sig = JSON.stringify([computer?.id, computer?.status, computer?.problems, users, waiting, mine, agent.name, t("Free")]);
    if (sig === computerSig) return;
    computerSig = sig;

    clear(computerEl);
    computerEl.append(h("div", { class: "hq-pnl-label", text: t("Computer") }));
    if (!computer) {
      computerEl.append(h("div", { class: "hq-pnl-muted", text: t("No computer available.") }));
      return;
    }
    const card = h(
      "div",
      { class: "hq-pnl-card hq-pnl-computer" },
      h(
        "div",
        { class: "hq-pnl-computer-top" },
        h("span", { class: `hq-pnl-dot ${computer.status}`, "aria-hidden": "true" }),
        h("span", { class: "hq-pnl-computer-name", text: computer.id }),
        h("span", { class: "hq-pnl-tag", text: t("Shared by every agent") }),
      ),
      h("div", { class: "hq-pnl-computer-state", text: agentLine({ status: computer.status, problems: computer.problems }) }),
    );
    const others = users.filter((name) => name !== agent.name);
    if (others.length) card.append(h("div", { class: "hq-pnl-line", text: t("In use by {name}", { name: others.join(", ") }) }));
    if (waiting.length) card.append(h("div", { class: "hq-pnl-line", text: t("Waiting: {names}", { names: waiting.join(", ") }) }));
    const line =
      mine === "using"
        ? t("{name} is using it", { name: agent.name })
        : mine === "waiting"
          ? t("{name} is waiting for the computer", { name: agent.name })
          : users.length
            ? null
            : t("Free");
    if (line) card.append(h("div", { class: `hq-pnl-mine ${mine ?? "free"}`, text: line }));
    computerEl.append(card);
  }

  // ── Goals ───────────────────────────────────────────────────────────────────

  function drawGoals() {
    const agentId = builtAgentId;
    if (!agentId) return;
    clear(goalsList);
    if (goals == null && !goalsError) goalsList.append(h("div", { class: "hq-pnl-muted", text: t("Loading…") }));
    if (goalsError) goalsList.append(h("div", { class: "hq-pnl-error", role: "status", text: goalsError }));
    if (goals) {
      if (!goals.length && !draft) goalsList.append(h("div", { class: "hq-pnl-muted", text: t("No goal yet.") }));
      for (const goal of goals) goalsList.append(goalRow(goal));
    }
    const want = draft ?? "closed";
    if (formFor === want) return;
    formFor = want;
    clear(goalsForm);
    if (draft) {
      goalsForm.append(goalForm(agentId, draft));
    } else {
      const add = h("button", { class: "hq-pnl-add", text: `+ ${t("New goal")}` });
      add.addEventListener("click", () => {
        draft = emptyDraft();
        focusDraft = true;
        drawGoals();
      });
      goalsForm.append(add);
    }
  }

  function goalStatus(goal: OrchGoal): string {
    if (goal.status === "achieved") return t("Achieved");
    return goal.status === "paused" ? t("Paused") : t("Active");
  }

  function goalRow(goal: OrchGoal): HTMLElement {
    const note = h("div", { class: "hq-pnl-error", role: "status" });
    const fail = (btn: HTMLButtonElement) => (err: unknown) => {
      btn.disabled = false;
      note.textContent = reason(err);
    };
    const run = h("button", { class: "hq-pnl-btn", text: t("Run now") });
    run.addEventListener("click", () => {
      run.disabled = true;
      note.textContent = "";
      void OrchestratorBridge.runGoal(goal.id, newTaskKey()).then(() => {
        run.disabled = false;
        void fetchGoals(goal.agentId);
      }, fail(run));
    });
    let toggle: HTMLButtonElement | null = null;
    if (goal.status !== "achieved") {
      const paused = goal.status === "paused";
      const label = paused ? t("Resume") : t("Pause");
      const btn = iconButton(svg(paused ? ICONS.play : ICONS.pause, 13), label, () => {
        btn.disabled = true;
        note.textContent = "";
        void OrchestratorBridge.updateGoal(goal.id, { status: paused ? "active" : "paused" })
          .then(() => fetchGoals(goal.agentId), fail(btn));
      });
      btn.classList.add("small");
      toggle = btn;
    }
    return h(
      "div",
      { class: goal.status === "active" ? "hq-pnl-card hq-pnl-goal" : "hq-pnl-card hq-pnl-goal dim" },
      h(
        "div",
        { class: "hq-pnl-goal-top" },
        h(
          "div",
          { class: "hq-pnl-goal-text" },
          h("div", { class: "hq-pnl-goal-title", text: goal.title, title: goal.instructions }),
          h("div", { class: "hq-pnl-goal-meta", text: `${scheduleLabel(goal.schedule)} · ${goalStatus(goal)}` }),
        ),
        h("div", { class: "hq-pnl-goal-actions" }, run, toggle),
      ),
      note,
    );
  }

  function goalForm(agentId: string, d: GoalDraft): HTMLElement {
    const note = h("div", { class: "hq-pnl-error", role: "status" });
    const title = h("input", { class: "hq-pnl-input", placeholder: t("Goal title"), maxlength: "80", "aria-label": t("Goal title") }) as HTMLInputElement;
    title.value = d.title;
    title.addEventListener("input", () => (d.title = title.value));
    const instructions = h("textarea", {
      class: "hq-pnl-input hq-pnl-textarea",
      placeholder: t("What should the agent keep working toward?"),
      "aria-label": t("What should the agent keep working toward?"),
      maxlength: "4000",
      rows: "3",
    }) as HTMLTextAreaElement;
    instructions.value = d.instructions;
    instructions.addEventListener("input", () => (d.instructions = instructions.value));

    const kinds: [GoalSchedule["kind"], string][] = [
      ["manual", t("Manual")],
      ["every", t("Every N hours")],
      ["daily", t("Daily at")],
      ["weekdays", t("Weekdays at")],
    ];
    const value = h("span", { class: "hq-pnl-schedule-value" });
    const drawValue = () => {
      clear(value);
      if (d.kind === "every") {
        const hours = h("input", {
          class: "hq-pnl-input hq-pnl-narrow",
          type: "number",
          min: "1",
          max: "168",
          title: t("From 1 to 168"),
          "aria-label": t("Hours"),
        }) as HTMLInputElement;
        hours.value = String(d.hours);
        hours.addEventListener("input", () => (d.hours = Number(hours.value)));
        value.append(hours, h("span", { class: "hq-pnl-muted", text: t("Hours") }));
      } else if (d.kind === "daily" || d.kind === "weekdays") {
        const at = h("input", { class: "hq-pnl-input hq-pnl-narrow", type: "time", "aria-label": t("Time") }) as HTMLInputElement;
        at.value = d.time;
        at.addEventListener("input", () => (d.time = at.value));
        value.append(at);
      }
    };
    const kind = select(kinds, d.kind, (next) => {
      d.kind = next as GoalSchedule["kind"];
      drawValue();
    });
    drawValue();

    const save = h("button", { class: "hq-pnl-btn accent", text: t("Save") });
    save.addEventListener("click", () => {
      const goalTitle = d.title.trim();
      const goalText = d.instructions.trim();
      if (!goalTitle) return title.focus();
      if (!goalText) return instructions.focus();
      if (d.kind === "every" && !(Number.isInteger(d.hours) && d.hours >= 1 && d.hours <= 168)) {
        note.textContent = t("From 1 to 168");
        return;
      }
      if ((d.kind === "daily" || d.kind === "weekdays") && !d.time) return;
      save.disabled = true;
      note.textContent = "";
      void OrchestratorBridge.createGoal(agentId, goalTitle, goalText, scheduleFromDraft(d)).then(() => {
        if (draft === d) draft = null;
        void fetchGoals(agentId);
      }, (err) => {
        save.disabled = false;
        note.textContent = reason(err);
      });
    });
    const cancel = h("button", { class: "hq-pnl-btn", text: t("Cancel") });
    cancel.addEventListener("click", () => {
      draft = null;
      drawGoals();
    });
    const form = h(
      "div",
      { class: "hq-pnl-card hq-pnl-form" },
      title,
      instructions,
      h("div", { class: "hq-pnl-schedule" }, kind, value),
      note,
      h("div", { class: "hq-pnl-actions" }, save, cancel),
    );
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel.click();
    });
    if (focusDraft) {
      focusDraft = false;
      queueMicrotask(() => title.focus());
    }
    return form;
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  function drawMemory() {
    const agentId = builtAgentId;
    if (!agentId) return;
    clear(memoryList);
    if (notes == null && !notesError) memoryList.append(h("div", { class: "hq-pnl-muted", text: t("Loading…") }));
    if (notesError) memoryList.append(h("div", { class: "hq-pnl-error", role: "status", text: notesError }));
    if (notes) {
      if (!notes.length && noteDraft == null) memoryList.append(h("div", { class: "hq-pnl-muted", text: t("No memory note yet.") }));
      for (const n of notes) memoryList.append(noteRow(agentId, n));
    }
    const open = noteDraft != null;
    if (noteFormOpen === open) return;
    noteFormOpen = open;
    clear(memoryForm);
    if (open) {
      const form = noteForm(agentId);
      memoryForm.append(form);
      queueMicrotask(() => form.querySelector("input")?.focus());
    } else {
      const add = h("button", { class: "hq-pnl-add", text: `+ ${t("Add a note")}` });
      add.addEventListener("click", () => {
        noteDraft = "";
        drawMemory();
      });
      memoryForm.append(add);
    }
  }

  function noteRow(agentId: string, n: MemoryNote): HTMLElement {
    const remove = iconButton(svg(HUB_ICONS.trash!, 14, { stroke: 1.8 }), t("Delete"), () => {
      remove.disabled = true;
      void OrchestratorBridge.deleteMemory(agentId, n.id).then(() => fetchMemory(agentId), (err) => {
        remove.disabled = false;
        notesError = reason(err);
        drawMemory();
      });
    });
    remove.classList.add("small", "ghost");
    return h(
      "div",
      { class: "hq-pnl-note" },
      h(
        "div",
        { class: "hq-pnl-note-text" },
        h("div", { text: n.text }),
        h("div", { class: "hq-pnl-note-meta", text: n.source === "agent" ? t("Remembered by the agent") : t("Added by you") }),
      ),
      remove,
    );
  }

  function noteForm(agentId: string): HTMLElement {
    const input = h("input", {
      class: "hq-pnl-input hq-pnl-note-input",
      placeholder: t("Add a note for this agent"),
      "aria-label": t("Add a note for this agent"),
      maxlength: "300",
    }) as HTMLInputElement;
    input.value = noteDraft ?? "";
    input.addEventListener("input", () => (noteDraft = input.value));
    const add = h("button", { class: "hq-pnl-btn accent", text: t("Add") });
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      add.disabled = input.disabled = true;
      void OrchestratorBridge.addMemory(agentId, text).then(() => {
        noteDraft = null;
        void fetchMemory(agentId);
      }, (err) => {
        add.disabled = input.disabled = false;
        notesError = reason(err);
        drawMemory();
      });
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") {
        noteDraft = null;
        drawMemory();
      }
    });
    return h("div", { class: "hq-pnl-note-form" }, input, add);
  }

  // ── Files ───────────────────────────────────────────────────────────────────

  function drawFiles(agent: OrchAgent) {
    const files: { agentId: string; taskId: string; path: string; at: string }[] = [];
    for (const item of store.thread(agent.id)) {
      if (item.kind !== "agent") continue;
      for (const path of item.artifacts) files.push({ agentId: item.agentId, taskId: item.taskId, path, at: item.at });
    }
    files.sort((a, b) => b.at.localeCompare(a.at));
    // A file written again by a later task shows once: its newest copy.
    const seen = new Set<string>();
    files.splice(0, files.length, ...files.filter((f) => !seen.has(f.path) && seen.add(f.path)));
    const sig = files.map((f) => `${f.taskId}|${f.path}`).join("\n");
    if (sig === filesSig && filesEl.firstChild) return;
    filesSig = sig;

    clear(filesEl);
    filesEl.append(h("div", { class: "hq-pnl-label", text: t("Files") }));
    if (!files.length) {
      filesEl.append(h("div", { class: "hq-pnl-muted", text: t("No file yet.") }));
      return;
    }
    for (const f of files) {
      const status = h("span", { class: "hq-pnl-file-status", text: t("Save") });
      const row = h(
        "button",
        { class: "hq-pnl-file", title: f.path },
        h("span", { class: "hq-pnl-file-icon" }, svg(ICONS.doc, 16)),
        h("span", { class: "hq-pnl-file-name", text: fileName(f.path) }),
        status,
      );
      row.addEventListener("click", () => {
        row.disabled = true;
        status.textContent = t("Saving…");
        void store.saveFile(f.agentId, f.taskId, f.path).then(
          (saved) => {
            status.textContent = saved ? t("Saved") : t("Save");
            if (saved) row.title = saved;
          },
          (err) => {
            status.textContent = t("Couldn't save: {error}", { error: reason(err) });
          },
        ).finally(() => (row.disabled = false));
      });
      filesEl.append(row);
    }
  }

  // ── Fetching ────────────────────────────────────────────────────────────────

  async function fetchAgentData(agentId: string) {
    await Promise.all([fetchGoals(agentId), fetchMemory(agentId)]);
  }

  async function fetchGoals(agentId: string) {
    try {
      const res = await OrchestratorBridge.goals(agentId);
      if (builtAgentId !== agentId) return;
      goals = res.goals ?? [];
      goalsError = "";
    } catch (err) {
      if (builtAgentId !== agentId) return;
      goalsError = reason(err);
    }
    if (builtPanel === "agent") drawGoals();
  }

  async function fetchMemory(agentId: string) {
    try {
      const res = await OrchestratorBridge.memory(agentId);
      if (builtAgentId !== agentId) return;
      notes = res.notes ?? [];
      notesError = "";
    } catch (err) {
      if (builtAgentId !== agentId) return;
      notesError = reason(err);
    }
    if (builtPanel === "agent") drawMemory();
  }

  // Goals and memory changed in the backend: fetch again, only while they show.
  let wantGoals = false;
  let wantMemory = false;
  function onBackendEvent(e: OrchEvent) {
    if (e.type !== "goal.updated" && e.type !== "memory.updated") return;
    if (builtPanel !== "agent" || e.agentId !== builtAgentId) return;
    if (e.type === "goal.updated") wantGoals = true;
    else wantMemory = true;
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      const agentId = builtAgentId;
      if (builtPanel !== "agent" || !agentId) return;
      if (wantGoals) void fetchGoals(agentId);
      if (wantMemory) void fetchMemory(agentId);
      wantGoals = wantMemory = false;
    }, REFETCH_MS);
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  function drawSettings(agent: OrchAgent) {
    const snap = store.snapshot();
    const sig = JSON.stringify([
      avatarSignature(agent, 56, { working: store.working(agent.id), star: agent.kind === "chief" }),
      agent.name, agent.role, agent.persona, agent.teamId, agent.paused, agent.status, agent.problems,
      snap.teams.map((x) => [x.id, x.name, x.order]),
    ]);
    if (sig === settingsSig) return;
    // Don't pull the field out from under the user: redraw once they leave it.
    const focused = document.activeElement;
    if (settingsSig && focused && body.contains(focused) && focused.matches("input, textarea, select")) {
      if (!redrawOnBlur) {
        redrawOnBlur = true;
        focused.addEventListener("blur", () => {
          redrawOnBlur = false;
          queueMicrotask(render);
        }, { once: true });
      }
      return;
    }
    settingsSig = sig;
    clear(body);
    body.append(settingsView(agent));
  }

  function settingsView(agent: OrchAgent): HTMLElement {
    const note = h("div", { class: "hq-pnl-error", role: "status" });
    const fail = (err: unknown) => {
      note.textContent = reason(err);
    };
    const change = (changes: Changes) => {
      note.textContent = "";
      void OrchestratorBridge.updateAgent(agent.id, changes).then(() => store.reload(), fail);
    };

    const who = h(
      "div",
      { class: "hq-pnl-who" },
      agentAvatar(agent, 56, { working: store.working(agent.id), star: agent.kind === "chief" }),
      h(
        "div",
        { class: "hq-pnl-who-text" },
        h("div", { class: "hq-pnl-who-name", text: agent.name }),
        h("div", { class: "hq-pnl-muted", text: agentLine(agent) }),
      ),
    );

    const name = input(agent.name, t("Name"), 60, (next) => {
      if (next && next !== agent.name) change({ name: next });
    });
    const role = input(agent.role ?? "", t("Role"), 60, (next) => {
      if (next !== (agent.role ?? "")) change({ role: next || null });
    });
    const persona = h("textarea", {
      class: "hq-pnl-input hq-pnl-textarea",
      placeholder: t("How should this agent work?"),
      maxlength: "1000",
      rows: "4",
    }) as HTMLTextAreaElement;
    persona.value = agent.persona ?? "";
    persona.addEventListener("change", () => {
      const next = persona.value.trim();
      if (next !== (agent.persona ?? "")) change({ persona: next || null });
    });

    const outfit = select(
      [["default", t("Default look")], ...OUTFIT_SELECTIONS
        .filter((o) => o !== "auto")
        .map((o) => [o, OUTFIT_LABELS[o]] as [string, string])],
      agent.outfit ?? "default",
      (o) => change({ outfit: o === "default" ? null : (o as OrchOutfit) }),
    );

    const pause = h("button", { class: "hq-pnl-btn", text: agent.paused ? t("Resume") : t("Pause") });
    pause.addEventListener("click", () => {
      pause.disabled = true;
      const action = agent.paused ? OrchestratorBridge.resumeAgent(agent.id) : OrchestratorBridge.pauseAgent(agent.id);
      void action.then(() => store.reload(), (err) => {
        pause.disabled = false;
        fail(err);
      });
    });
    const retire = agent.kind === "chief" ? null : h("button", { class: "hq-pnl-btn danger", text: t("Retire") });
    retire?.addEventListener("click", () => {
      if (!window.confirm(t("Retire {name}?", { name: agent.name }))) return;
      retire.disabled = true;
      void OrchestratorBridge.retireAgent(agent.id).then(() => {
        const chief = store.chief();
        if (chief) store.select(chief.id);
        store.setPanel(null);
        return store.reload();
      }, (err) => {
        retire.disabled = false;
        fail(err);
      });
    });

    return h(
      "div",
      { class: "hq-pnl-settings" },
      who,
      field(t("Name"), name),
      field(t("Role"), role),
      field(t("Instructions"), persona),
      field(t("Team"), teamControl(agent, change, fail)),
      field(t("Colour"), colors(agent, (hex) => change({ color: hex }))),
      field(t("Outfit"), outfit),
      h("div", { class: "hq-pnl-actions split" }, pause, retire),
      note,
    );
  }

  /** The team select, with "New team…" turning it into a name box. */
  function teamControl(agent: OrchAgent, change: (c: Changes) => void, fail: (err: unknown) => void): HTMLElement {
    const wrap = h("div", { class: "hq-pnl-team" });
    const NEW = "\u0000new";
    const teams = [...store.snapshot().teams].sort((a, b) => a.order - b.order);
    const picker = select(
      [["none", t("No team")], ...teams.map((x) => [x.id, x.name] as [string, string]), [NEW, t("New team…")]],
      agent.teamId ?? "none",
      (id) => {
        if (id !== NEW) return change({ teamId: id === "none" ? null : id });
        picker.value = agent.teamId ?? "none";
        showNew();
      },
    );
    picker.setAttribute("aria-label", t("Team"));
    const showNew = () => {
      const name = h("input", { class: "hq-pnl-input", placeholder: t("Team name"), "aria-label": t("Team name"), maxlength: "40" }) as HTMLInputElement;
      const create = h("button", { class: "hq-pnl-btn accent", text: t("Create") });
      const back = () => {
        clear(wrap);
        wrap.append(picker);
      };
      const submit = () => {
        const teamName = name.value.trim();
        if (!teamName) return name.focus();
        create.disabled = name.disabled = true;
        void OrchestratorBridge.createTeam(teamName)
          .then((res) => OrchestratorBridge.updateAgent(agent.id, { teamId: res.team.id }))
          .then(() => store.reload(), (err) => {
            create.disabled = name.disabled = false;
            fail(err);
          });
      };
      create.addEventListener("click", submit);
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") back();
      });
      clear(wrap);
      wrap.append(h("div", { class: "hq-pnl-note-form" }, name, create));
      name.focus();
    };
    wrap.append(picker);
    return wrap;
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  store.subscribe(render);
  void onEvent<OrchEvent>("orchestrator-event", onBackendEvent);
  // The palette's "New goal for {name}…": the agent panel with the form open.
  document.addEventListener("hq-new-goal", () => {
    const snap = store.snapshot();
    const id = snap.selectedId ?? store.chief()?.id;
    if (!id) return;
    draft ??= emptyDraft();
    focusDraft = true;
    if (snap.view !== "chat" || snap.selectedId !== id) store.select(id);
    if (store.snapshot().panel !== "agent") {
      store.setPanel("agent");
    } else {
      drawGoals();
      focusDraft = false;
      goalsForm.querySelector("input")?.focus();
      goalsEl.scrollIntoView({ block: "nearest" });
    }
  });
  render();
}

// ── Small pieces ──────────────────────────────────────────────────────────────

function scheduleLabel(schedule: GoalSchedule): string {
  switch (schedule.kind) {
    case "manual":
      return t("Manual");
    case "every":
      return t("Every {hours} hours", { hours: schedule.hours });
    case "daily":
      return t("Daily at {time}", { time: schedule.time });
    case "weekdays":
      return t("Weekdays at {time}", { time: schedule.time });
  }
}

function scheduleFromDraft(d: GoalDraft): GoalSchedule {
  if (d.kind === "every") return { kind: "every", hours: d.hours };
  if (d.kind === "daily") return { kind: "daily", time: d.time };
  if (d.kind === "weekdays") return { kind: "weekdays", time: d.time };
  return { kind: "manual" };
}

function iconButton(icon: SVGSVGElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: "hq-icon-btn hq-pnl-icon", title: label, "aria-label": label }, icon);
  b.addEventListener("click", onClick);
  return b;
}

function field(label: string, control: HTMLElement): HTMLElement {
  if (control.matches("input, textarea, select")) control.setAttribute("aria-label", label);
  return h("div", { class: "hq-pnl-field" }, h("span", { class: "hq-pnl-field-label", text: label }), control);
}

/** Saved when it loses focus or on Enter. */
function input(value: string, placeholder: string, maxLength: number, save: (next: string) => void): HTMLInputElement {
  const el = h("input", { class: "hq-pnl-input", placeholder, maxlength: String(maxLength), spellcheck: "false" }) as HTMLInputElement;
  el.value = value;
  el.addEventListener("change", () => save(el.value.trim()));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.blur();
  });
  return el;
}

function select(choices: [string, string][], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const el = h("select", { class: "hq-pnl-input hq-pnl-select" }) as HTMLSelectElement;
  for (const [id, label] of choices) el.append(h("option", { value: id, text: label }));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

/** The pills' palette, and "Default" once the agent has a colour of its own. */
function colors(agent: OrchAgent, pick: (hex: string | null) => void): HTMLElement {
  const row = h("div", { class: "hq-pnl-swatches", role: "group" });
  const now = avatarColor(agent).toUpperCase();
  for (const hex of PILL_PALETTE) {
    const on = hex.toUpperCase() === now;
    const swatch = h("button", {
      class: on ? "hq-pnl-swatch on" : "hq-pnl-swatch",
      style: `background:${hex}`,
      title: hex,
      "aria-label": hex,
      "aria-pressed": on,
    });
    swatch.addEventListener("click", (e) => {
      e.preventDefault();
      for (const s of row.querySelectorAll(".hq-pnl-swatch")) s.classList.remove("on");
      swatch.classList.add("on");
      pick(hex);
    });
    row.append(swatch);
  }
  if (agent.color) {
    const reset = h("button", { class: "hq-pnl-swatch-reset", text: t("Default") });
    reset.addEventListener("click", (e) => {
      e.preventDefault();
      pick(null);
    });
    row.append(reset);
  }
  return row;
}
