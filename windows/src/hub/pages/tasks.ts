// Tasks: give an agent something to do, follow it, answer its questions, get
// its files. The work runs in the orchestrator backend and the agent's own
// Linux VM (orchestrator/ at the repository root); this page only asks and
// shows, in the Notetaker's list-and-detail layout.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import {
  ACTIVE,
  PAUSABLE,
  OrchestratorBridge,
  approvalLabel,
  agentLine,
  eventLine,
  modelLabel,
  newTaskKey,
  statusLabel,
  type OrchAgent,
  type OrchApproval,
  type OrchComputer,
  type OrchEvent,
  type OrchGoal,
  type OrchOutfit,
  type OrchStatus,
  type OrchTask,
  type OrchTeam,
  type GoalSchedule,
  type MemoryNote,
} from "../../core/orchestrator";
import type { HubContext } from "../shell";
import { button, card, divider, label, row, segmented, select, toggle } from "../ui";
import { colorDot } from "../../settings/colors";
import { agentColor } from "../../island/agents";
import { OUTFIT_LABELS, OUTFIT_SELECTIONS } from "../../mochi/wardrobe";

/** The agent the island's Activity link asked for, picked up by the next draw. */
let agentFilter: string | null = null;

/** Shows only this agent's tasks (null: everyone's). */
export function showAgentTasks(agentId: string | null) {
  agentFilter = agentId && /^[a-z0-9-]{1,24}$/.test(agentId) ? agentId : null;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" });
const dateTime = (iso: string) => new Date(iso).toLocaleString(document.documentElement.lang || undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface GoalDraft {
  agentId: string;
  goalId: string | null;
  title: string;
  instructions: string;
  kind: GoalSchedule["kind"];
  hours: number;
  time: string;
  modelProfileId: string | null;
}

interface AgentDraft {
  name: string;
  role: string;
  color: string;
  outfit: OrchOutfit | null;
  teamId: string | null;
  computerId: string | null;
}

export async function tasksPage(page: HTMLElement, ctx: HubContext) {
  let status: OrchStatus | null = await OrchestratorBridge.status().catch(() => null);
  let tasks: OrchTask[] = [];
  let approvals: OrchApproval[] = [];
  let agents: OrchAgent[] = [];
  let teams: OrchTeam[] = [];
  let computers: OrchComputer[] = [];
  let selected: string | null = null;
  let detail: { task: OrchTask; events: OrchEvent[] } | null = null;
  let files: { path: string; bytes: number }[] | null = null;
  let note = "";
  let pendingKey = newTaskKey();
  /** What is typed in the box: the page redraws on every event and must not lose it. */
  let draft = "";
  let models: string[] = [];
  let model: string | null = null;
  const goals = new Map<string, OrchGoal[]>();
  const memories = new Map<string, MemoryNote[]>();
  const memoryDrafts = new Map<string, string>();
  let goalDraft: GoalDraft | null = null;
  let teamDraft = "";
  let agentDraft: AgentDraft | null = null;
  /** The agent picked for the next task; null lets the backend choose a free one. */
  let agentChoice: string | null = null;
  /** An agent's name, for the task list once there is more than one. */
  const agentLabel = (id: string) => (agents.length > 1 ? ` · ${agents.find((a) => a.id === id)?.name ?? id}` : "");

  page.append(ctx.hero("tasks", t("Tasks"), t("Give your agents a task. Each one works in its own Linux computer and asks you before anything risky."), [], true));

  const connection = h("div", {});
  const composer = h("div", {});
  const management = h("div", { class: "tasks-management" });
  const approvalsEl = h("div", {});
  const listEl = h("div", { class: "hub-notes-list" });
  const detailEl = h("div", { class: "hub-note-detail" });
  page.append(connection, composer, management, approvalsEl, h("div", { class: "hub-notes" }, listEl, detailEl));

  const connected = () => status?.status.state === "connected";

  async function reload(refreshExtras = false) {
    status = await OrchestratorBridge.status().catch(() => status);
    if (connected()) {
      const data = await OrchestratorBridge.tasks().catch(() => null);
      tasks = data?.tasks ?? [];
      approvals = data?.approvals ?? [];
      agents = data?.agents ?? [];
      teams = data?.teams ?? [];
      computers = data?.computers ?? [];
      await Promise.all(agents.flatMap((agent) => [
        refreshExtras || !goals.has(agent.id)
          ? OrchestratorBridge.goals(agent.id).then((r) => goals.set(agent.id, r.goals ?? []), () => goals.set(agent.id, []))
          : Promise.resolve(),
        refreshExtras || !memories.has(agent.id)
          ? OrchestratorBridge.memory(agent.id).then((r) => memories.set(agent.id, r.notes ?? []), () => memories.set(agent.id, []))
          : Promise.resolve(),
      ]));
      selected ??= tasks[0]?.id ?? null;
      if (models.length === 0) {
        const m = await OrchestratorBridge.models().catch(() => null);
        models = m?.profiles.map((p) => p.id) ?? [];
        model ??= m?.default ?? models[0] ?? null;
      }
      detail = selected ? await OrchestratorBridge.task(selected).catch(() => null) : null;
    }
    draw();
  }

  function draw() {
    drawConnection();
    drawComposer();
    drawManagement();
    drawApprovals();
    drawList();
    drawDetail();
  }

  function drawConnection() {
    clear(connection);
    const s = status;
    const enabled = s?.prefs.enabled ?? false;
    const line =
      !s || s.status.state === "off"
        ? t("Off")
        : s.status.state === "connected"
          ? t("Connected")
          : s.status.state === "connecting"
            ? t("Connecting…")
            : s.status.state === "noToken"
              ? t("Start the orchestrator backend once: it creates the key Coucou needs.")
              : (s.status.error ?? t("The backend stopped answering."));
    const sw = toggle(enabled, (on) => {
      void OrchestratorBridge.setPrefs(on, s?.prefs.url ?? "").then(() => reload(true), (err) => {
        note = String(err);
        draw();
      });
    });
    connection.append(card(row(t("Orchestrator backend"), line, sw)));
  }

  function drawComposer() {
    const hadFocus = composer.contains(document.activeElement);
    clear(composer);
    if (!connected()) return;
    const text = h("textarea", { class: "hub-textarea", placeholder: t("What should the agent do?") }) as HTMLTextAreaElement;
    text.value = draft;
    text.addEventListener("input", () => {
      draft = text.value;
    });
    const start = button(t("Start task"), () => {
      const prompt = text.value.trim();
      if (!prompt) return;
      start.disabled = true;
      OrchestratorBridge.submit(prompt, pendingKey, model, agentChoice).then(
        ({ task }) => {
          // A new key for the next task; this one stays with the task just made.
          pendingKey = newTaskKey();
          text.value = "";
          draft = "";
          note = "";
          selected = task.id;
          void reload();
        },
        (err) => {
          // Same key on the next click: a lost answer cannot start a second task.
          note = String(err);
          start.disabled = false;
          drawComposer();
        },
      );
    }, "primary");
    // A choice only when there is one: the subscriptions the backend can use.
    const picker =
      models.length > 1
        ? segmented(models.map((id) => [id, modelLabel(id)] as [string, string]), model ?? models[0]!, (id) => {
            model = id;
          })
        : null;
    // Which agent, once there are several: Automatic sends it to a free one.
    if (agentChoice && !agents.some((a) => a.id === agentChoice)) agentChoice = null;
    const agentPicker =
      agents.length > 1
        ? segmented(
            [["auto", t("Automatic")] as [string, string], ...agents.map((a) => [a.id, a.name] as [string, string])],
            agentChoice ?? "auto",
            (id) => {
              agentChoice = id === "auto" ? null : id;
            },
          )
        : null;
    const label = h(
      "div",
      { class: "text" },
      agentPicker ? h("div", { class: "detail", text: t("Agent") }) : null,
      agentPicker,
      picker ? h("div", { class: "detail", text: t("Model") }) : null,
      picker,
    );
    composer.append(card(text, h("div", { class: "hub-row" }, label, start), note ? h("div", { class: "hub-warn", text: note }) : null));
    if (hadFocus) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }

  function goalStatus(goal: OrchGoal): string {
    if (goal.status === "achieved") return t("Achieved");
    return goal.status === "paused" ? t("Paused") : t("Active");
  }

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

  function scheduleFromDraft(draft: GoalDraft): GoalSchedule {
    if (draft.kind === "every") return { kind: "every", hours: draft.hours };
    if (draft.kind === "daily") return { kind: "daily", time: draft.time };
    if (draft.kind === "weekdays") return { kind: "weekdays", time: draft.time };
    return { kind: "manual" };
  }

  function editGoal(agentId: string, goal?: OrchGoal) {
    const schedule = goal?.schedule ?? { kind: "manual" };
    goalDraft = {
      agentId,
      goalId: goal?.id ?? null,
      title: goal?.title ?? "",
      instructions: goal?.instructions ?? "",
      kind: schedule.kind,
      hours: schedule.kind === "every" ? schedule.hours : 24,
      time: schedule.kind === "daily" || schedule.kind === "weekdays" ? schedule.time : "09:00",
      modelProfileId: goal?.modelProfileId ?? model,
    };
    drawManagement();
  }

  function goalForm(draft: GoalDraft): HTMLElement {
    const title = h("input", {
      class: "hub-input",
      placeholder: t("Goal title"),
      maxlength: "80",
    }) as HTMLInputElement;
    title.value = draft.title;
    title.addEventListener("input", () => (draft.title = title.value));
    const instructions = h("textarea", {
      class: "hub-textarea",
      placeholder: t("What should the agent keep working toward?"),
      maxlength: "4000",
    }) as HTMLTextAreaElement;
    instructions.value = draft.instructions;
    instructions.addEventListener("input", () => (draft.instructions = instructions.value));
    const kinds: [GoalSchedule["kind"], string][] = [
      ["manual", t("Manual")],
      ["every", t("Every N hours")],
      ["daily", t("Daily at")],
      ["weekdays", t("Weekdays at")],
    ];
    const schedulePicker = segmented(kinds, draft.kind, (kind) => {
      draft.kind = kind;
      drawManagement();
    });
    let scheduleValue: HTMLElement | null = null;
    if (draft.kind === "every") {
      const hours = h("input", {
        class: "hub-input",
        type: "number",
        min: "1",
        max: "168",
        value: String(draft.hours),
        style: "width:90px",
      }) as HTMLInputElement;
      hours.addEventListener("input", () => (draft.hours = Number(hours.value)));
      scheduleValue = row(t("Hours"), t("From 1 to 168"), hours);
    } else if (draft.kind === "daily" || draft.kind === "weekdays") {
      const at = h("input", {
        class: "hub-input",
        type: "time",
        value: draft.time,
      }) as HTMLInputElement;
      at.addEventListener("input", () => (draft.time = at.value));
      scheduleValue = row(t("Time"), null, at);
    }
    const save = button(t("Save"), () => {
      const body = {
        title: draft.title.trim(),
        instructions: draft.instructions.trim(),
        schedule: scheduleFromDraft(draft),
        modelProfileId: draft.modelProfileId,
      };
      if (!body.title || !body.instructions) return;
      save.disabled = true;
      const action = draft.goalId
        ? OrchestratorBridge.updateGoal(draft.goalId, body)
        : OrchestratorBridge.createGoal(
            draft.agentId,
            body.title,
            body.instructions,
            body.schedule,
            body.modelProfileId,
          );
      void action.then(() => {
        goalDraft = null;
        void reload(true);
      }, (err) => {
        note = String(err);
        save.disabled = false;
        drawManagement();
      });
    }, "primary");
    const cancel = button(t("Cancel"), () => {
      goalDraft = null;
      drawManagement();
    });
    const controls = h("div", { class: "hub-row" }, schedulePicker);
    if (models.length > 1) {
      controls.append(segmented(models.map((id) => [id, modelLabel(id)] as [string, string]), draft.modelProfileId ?? models[0]!, (id) => {
        draft.modelProfileId = id;
      }));
    }
    return card(
      title,
      instructions,
      controls,
      scheduleValue,
      h("div", { class: "hub-row tasks-actions" }, save, cancel),
    );
  }

  const changeAgent = (agent: OrchAgent, changes: Parameters<typeof OrchestratorBridge.updateAgent>[1]) => {
    void OrchestratorBridge.updateAgent(agent.id, changes).then(() => reload(), (err) => {
      note = String(err);
      void reload();
    });
  };

  function identityInput(
    value: string,
    placeholder: string,
    maxLength: number,
    save: (next: string) => void,
  ): HTMLInputElement {
    const input = h("input", {
      class: "hub-input",
      placeholder,
      maxlength: String(maxLength),
      spellcheck: "false",
    }) as HTMLInputElement;
    input.value = value;
    input.addEventListener("change", () => save(input.value.trim()));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    return input;
  }

  function teamPicker(value: string | null, onChange: (teamId: string | null) => void): HTMLSelectElement {
    return select(
      [["none", t("No team")] as [string, string], ...[...teams]
        .sort((a, b) => a.order - b.order)
        .map((team) => [team.id, team.name] as [string, string])],
      value ?? "none",
      (id) => onChange(id === "none" ? null : id),
    );
  }

  function computerPicker(value: string | null, onChange: (computerId: string) => void): HTMLSelectElement {
    const choices = computers.map((computer) => [computer.id, computer.id] as [string, string]);
    const current = value && computers.some((computer) => computer.id === value)
      ? value
      : choices[0]?.[0] ?? "";
    return select(choices, current, onChange);
  }

  function outfitPicker(value: OrchOutfit | null, onChange: (outfit: OrchOutfit | null) => void): HTMLSelectElement {
    const choices: [string, string][] = [
      ["default", t("Default look")],
      ...OUTFIT_SELECTIONS
        .filter((outfit) => outfit !== "auto")
        .map((outfit) => [outfit, OUTFIT_LABELS[outfit]] as [string, string]),
    ];
    return select(choices, value ?? "default", (outfit) => {
      onChange(outfit === "default" ? null : outfit as OrchOutfit);
    });
  }

  function agentIdentityCard(agent: OrchAgent): HTMLElement {
    const name = identityInput(agent.name, t("Name"), 60, (next) => {
      if (next && next !== agent.name) changeAgent(agent, { name: next });
    });
    const role = identityInput(agent.role ?? "", t("Role"), 60, (next) => {
      if (next !== (agent.role ?? "")) changeAgent(agent, { role: next || null });
    });
    const pillId = `agent_${agent.id}`;
    const color = colorDot(
      { id: pillId, name: agent.name, color: agentColor(agent.id) },
      "width:14px;height:14px",
      () => (agent.color ? { [pillId]: agent.color } : {}),
      (next) => changeAgent(agent, { color: next[pillId] ?? null }),
    );
    const outfit = outfitPicker(agent.outfit, (next) => changeAgent(agent, { outfit: next }));
    const team = teamPicker(agent.teamId, (next) => changeAgent(agent, { teamId: next }));
    const computer = computerPicker(agent.computerId, (next) => changeAgent(agent, { computerId: next }));
    const pause = button(agent.paused ? t("Resume") : t("Pause"), () => {
      const action = agent.paused
        ? OrchestratorBridge.resumeAgent(agent.id)
        : OrchestratorBridge.pauseAgent(agent.id);
      pause.disabled = true;
      void action.then(() => reload(), (err) => {
        note = String(err);
        void reload();
      });
    }, "", true);
    const retire = agent.kind === "chief"
      ? null
      : button(t("Retire"), () => {
          if (!window.confirm(t("Retire {name}?", { name: agent.name }))) return;
          retire!.disabled = true;
          void OrchestratorBridge.retireAgent(agent.id).then(() => reload(true), (err) => {
            note = String(err);
            void reload();
          });
        }, "danger", true);
    return card(
      row(agent.name, `${agent.role || t("Agent")} · ${agentLine(agent)}`, name, color),
      row(t("Role"), null, role),
      row(t("Outfit"), null, outfit),
      row(t("Team"), null, team),
      row(t("Computer"), null, computer),
      h("div", { class: "tasks-actions" }, pause, retire),
    );
  }

  function newAgentForm(draft: AgentDraft): HTMLElement {
    const name = identityInput(draft.name, t("Name"), 60, (next) => (draft.name = next));
    name.addEventListener("input", () => (draft.name = name.value));
    const role = identityInput(draft.role, t("Role"), 60, (next) => (draft.role = next));
    role.addEventListener("input", () => (draft.role = role.value));
    const color = h("input", {
      class: "hub-input",
      type: "color",
      value: draft.color,
      title: t("Colour"),
    }) as HTMLInputElement;
    color.addEventListener("input", () => (draft.color = color.value));
    const outfit = outfitPicker(draft.outfit, (next) => (draft.outfit = next));
    const team = teamPicker(draft.teamId, (next) => (draft.teamId = next));
    const computer = computerPicker(draft.computerId, (next) => (draft.computerId = next));
    const create = button(t("Create"), () => {
      const agentName = draft.name.trim();
      if (!agentName) return;
      create.disabled = true;
      void OrchestratorBridge.createAgent({
        name: agentName,
        role: draft.role.trim() || null,
        color: draft.color,
        outfit: draft.outfit,
        teamId: draft.teamId,
        computerId: draft.computerId ?? undefined,
      }).then(() => {
        agentDraft = null;
        void reload(true);
      }, (err) => {
        note = String(err);
        create.disabled = false;
        drawManagement();
      });
    }, "primary");
    return card(
      row(t("Name"), null, name, color),
      row(t("Role"), null, role),
      row(t("Outfit"), null, outfit),
      row(t("Team"), null, team),
      row(t("Computer"), null, computer),
      h("div", { class: "tasks-actions" },
        create,
        button(t("Cancel"), () => {
          agentDraft = null;
          drawManagement();
        }),
      ),
    );
  }

  function drawTeamManagement() {
    management.append(label(t("Team")));
    const teamsCard = card();
    for (const [index, team] of [...teams].sort((a, b) => a.order - b.order).entries()) {
      if (index) teamsCard.append(divider());
      const name = identityInput(team.name, t("Team name"), 40, (next) => {
        if (!next || next === team.name) return;
        void OrchestratorBridge.updateTeam(team.id, { name: next }).then(() => reload(), (err) => {
          note = String(err);
          void reload();
        });
      });
      const remove = button(t("Delete"), () => {
        if (!window.confirm(t("Delete team {name}?", { name: team.name }))) return;
        remove.disabled = true;
        void OrchestratorBridge.deleteTeam(team.id).then(() => reload(true), (err) => {
          note = String(err);
          void reload();
        });
      }, "danger", true);
      teamsCard.append(row(team.name, null, name, remove));
    }
    const teamName = identityInput(teamDraft, t("Team name"), 40, (next) => (teamDraft = next));
    teamName.addEventListener("input", () => (teamDraft = teamName.value));
    const createTeam = button(t("Create team"), () => {
      const name = teamName.value.trim();
      if (!name) return;
      createTeam.disabled = true;
      void OrchestratorBridge.createTeam(name).then(() => {
        teamDraft = "";
        void reload(true);
      }, (err) => {
        note = String(err);
        createTeam.disabled = false;
      });
    }, "primary", true);
    teamsCard.append(h("div", { class: "hub-row" }, teamName, createTeam));
    management.append(teamsCard);

    const orderedTeams: ({ id: string | null; name: string; order: number }[]) = [
      ...[...teams].sort((a, b) => a.order - b.order),
      { id: null, name: t("No team"), order: Number.MAX_SAFE_INTEGER },
    ];
    for (const group of orderedTeams) {
      const members = agents
        .filter((agent) => (agent.teamId ?? null) === group.id)
        .sort((a, b) => Number(b.kind === "chief") - Number(a.kind === "chief") || a.order - b.order);
      if (members.length === 0) continue;
      management.append(h("h2", { class: "tasks-agent-title", text: group.name }));
      for (const agent of members) management.append(agentIdentityCard(agent));
    }
    if (agentDraft) {
      management.append(h("h2", { class: "tasks-agent-title", text: t("New agent") }), newAgentForm(agentDraft));
    } else {
      management.append(button(t("New agent"), () => {
        agentDraft = {
          name: "",
          role: "",
          color: "#38BDF8",
          outfit: null,
          teamId: teams[0]?.id ?? null,
          computerId: computers[0]?.id ?? null,
        };
        drawManagement();
      }, "primary"));
    }
  }

  function drawComputers() {
    management.append(label(t("Computers")));
    const computersCard = card();
    for (const [index, computer] of computers.entries()) {
      if (index) computersCard.append(divider());
      const names = computer.agentIds
        .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
        .join(", ");
      computersCard.append(row(
        computer.id,
        `${agentLine({ status: computer.status, problems: computer.problems })} · ${t("Agents: {names}", { names: names || "—" })}`,
      ));
    }
    if (computers.length === 0) computersCard.append(h("div", { class: "hub-note", text: t("No computer available.") }));
    management.append(computersCard);
  }

  function drawManagement() {
    clear(management);
    if (!connected()) return;
    drawTeamManagement();
    drawComputers();
    for (const agent of agents) {
      const heading = agents.length > 1 ? h("h2", { class: "tasks-agent-title", text: agent.name }) : null;
      if (heading) management.append(heading);

      management.append(label(t("Goals")));
      if (goalDraft?.agentId === agent.id) {
        management.append(goalForm(goalDraft));
      } else {
        const goalsCard = card();
        const list = goals.get(agent.id) ?? [];
        for (const [index, goal] of list.entries()) {
          if (index) goalsCard.append(divider());
          const next = goal.nextRunAt
            ? t("Next: {date}", { date: dateTime(goal.nextRunAt) })
            : t("No next run");
          const edit = button(t("Edit"), () => editGoal(agent.id, goal), "", true);
          const pause = goal.status === "achieved"
            ? null
            : button(goal.status === "paused" ? t("Resume") : t("Pause"), () => {
                void OrchestratorBridge.updateGoal(goal.id, {
                  status: goal.status === "paused" ? "active" : "paused",
                }).then(() => reload(true), (err) => {
                  note = String(err);
                  drawManagement();
                });
              }, "", true);
          const run = button(t("Run now"), () => {
            void OrchestratorBridge.runGoal(goal.id, newTaskKey()).then(({ task }) => {
              selected = task.id;
              void reload();
            }, (err) => {
              note = String(err);
              drawManagement();
            });
          }, "", true);
          const remove = button(t("Delete"), () => {
            void OrchestratorBridge.deleteGoal(goal.id).then(() => reload(true), (err) => {
              note = String(err);
              drawManagement();
            });
          }, "danger", true);
          goalsCard.append(row(
            goal.title,
            `${goalStatus(goal)} · ${scheduleLabel(goal.schedule)} · ${next}`,
            edit,
            pause,
            run,
            remove,
          ));
        }
        if (list.length === 0) goalsCard.append(h("div", { class: "hub-note", text: t("No goal yet.") }));
        goalsCard.append(button(t("Create goal"), () => editGoal(agent.id), "primary", true));
        management.append(goalsCard);
      }

      management.append(label(t("Memory")));
      const memoryCard = card();
      const notes = memories.get(agent.id) ?? [];
      for (const [index, memory] of notes.entries()) {
        if (index) memoryCard.append(divider());
        memoryCard.append(row(
          memory.text,
          memory.source === "agent" ? t("Remembered by the agent") : t("Added by you"),
          button(t("Delete"), () => {
            void OrchestratorBridge.deleteMemory(agent.id, memory.id).then(() => reload(true), (err) => {
              note = String(err);
              drawManagement();
            });
          }, "danger", true),
        ));
      }
      if (notes.length === 0) memoryCard.append(h("div", { class: "hub-note", text: t("No memory note yet.") }));
      const memoryInput = h("input", {
        class: "hub-input",
        placeholder: t("Add a note for this agent"),
        maxlength: "300",
      }) as HTMLInputElement;
      memoryInput.value = memoryDrafts.get(agent.id) ?? "";
      memoryInput.addEventListener("input", () => memoryDrafts.set(agent.id, memoryInput.value));
      const add = button(t("Add note"), () => {
        const text = memoryInput.value.trim();
        if (!text) return;
        add.disabled = true;
        void OrchestratorBridge.addMemory(agent.id, text).then(() => {
          memoryDrafts.delete(agent.id);
          void reload(true);
        }, (err) => {
          note = String(err);
          add.disabled = false;
        });
      }, "primary", true);
      memoryCard.append(h("div", { class: "hub-row" }, memoryInput, add));
      management.append(memoryCard);

      management.append(label(t("Daily limits")));
      const tasksLimit = h("input", {
        class: "hub-input",
        type: "number",
        min: "1",
        max: "500",
        value: String(agent.limits.tasksPerDay),
        style: "width:90px",
      }) as HTMLInputElement;
      const stepsLimit = h("input", {
        class: "hub-input",
        type: "number",
        min: "10",
        max: "5000",
        value: String(agent.limits.stepsPerDay),
        style: "width:90px",
      }) as HTMLInputElement;
      const limitsCard = card(
        row(t("Tasks per day"), t("Used today: {count}", { count: agent.usage.tasksToday }), tasksLimit),
        divider(),
        row(t("Steps per day"), t("Used today: {count}", { count: agent.usage.stepsToday }), stepsLimit),
        button(t("Save limits"), () => {
          const tasksPerDay = Number(tasksLimit.value);
          const stepsPerDay = Number(stepsLimit.value);
          void OrchestratorBridge.setLimits(agent.id, tasksPerDay, stepsPerDay).then(() => reload(), (err) => {
            note = String(err);
            drawManagement();
          });
        }, "primary", true),
      );
      management.append(limitsCard);
    }
  }

  function drawApprovals() {
    clear(approvalsEl);
    for (const a of approvals) {
      const allow = button(t("Allow"), () => decide(a, true), "primary", true);
      const deny = button(t("Deny"), () => decide(a, false), "", true);
      approvalsEl.append(card(row(`${approvalLabel(a.op)} · ${a.target}`, `${t("Waiting for approval")} · ${a.reason}`, deny, allow)));
    }
  }

  function decide(a: OrchApproval, approve: boolean) {
    OrchestratorBridge.decide(a.agentId, a.id, approve).then(() => reload(), (err) => {
      note = String(err);
      void reload();
    });
  }

  function drawList() {
    clear(listEl);
    if (!connected()) return;
    // One agent's tasks, or everyone's: offered once there are several agents.
    if (agentFilter && !agents.some((a) => a.id === agentFilter)) agentFilter = null;
    if (agents.length > 1) {
      listEl.append(
        segmented(
          [["all", t("All")] as [string, string], ...agents.map((a) => [a.id, a.name] as [string, string])],
          agentFilter ?? "all",
          (id) => {
            agentFilter = id === "all" ? null : id;
            drawList();
          },
        ),
      );
    }
    const shown = agentFilter ? tasks.filter((x) => x.agentId === agentFilter) : tasks;
    if (shown.length === 0) {
      listEl.append(h("div", { class: "hub-note", style: "padding:14px 4px", text: t("No task yet.") }));
      return;
    }
    for (const task of shown) {
      const item = h("button", { class: task.id === selected ? "hub-note-item on" : "hub-note-item" },
        h("span", { class: "t", text: task.prompt }),
        h("span", { class: "m", text: `${statusLabel(task.status)}${agentLabel(task.agentId)} · ${modelLabel(task.modelProfileId)} · ${time(task.createdAt)}` }),
      );
      item.addEventListener("click", () => {
        selected = task.id;
        files = null;
        void reload();
      });
      listEl.append(item);
    }
  }

  function drawDetail() {
    clear(detailEl);
    if (!detail) return;
    const task = detail.task;
    const waiting = task.waitingReason === "daily_limit"
      ? t("Daily limit reached")
      : task.waitingReason === "agent_paused"
        ? t("Paused")
        : task.waitingReason === "computer_offline"
          ? t("Waiting for its computer")
          : "";
    detailEl.append(
      h("h2", { text: task.prompt }),
      h("span", {
        class: "hub-tag",
        text: `${statusLabel(task.status)}${waiting ? ` · ${waiting}` : ""}${agentLabel(task.agentId)} · ${modelLabel(task.modelProfileId)}`,
      }),
    );
    if (task.result) detailEl.append(h("div", { class: "hub-ok", style: "white-space:pre-wrap", text: task.result.summary }));
    if (task.error) detailEl.append(h("div", { class: "hub-warn", text: task.error.message }));
    if (task.question) {
      if (task.source === "delegated") {
        detailEl.append(card(
          h("div", { class: "title", text: task.question.text }),
          h("div", { class: "hub-note", text: t("Waiting for Mochi to answer.") }),
        ));
      } else {
      const answerInput = h("input", {
        class: "hub-input",
        placeholder: t("Your answer"),
        maxlength: "2000",
      }) as HTMLInputElement;
      const sendAnswer = (answer: string) => {
        const value = answer.trim();
        if (!value) return;
        void OrchestratorBridge.answer(task.id, task.question!.id, value).then(() => reload(), (err) => {
          note = String(err);
          void reload();
        });
      };
      const replies = h("div", { class: "tasks-actions" });
      for (const option of task.question.options) {
        replies.append(button(option, () => sendAnswer(option), "", true));
      }
      replies.append(answerInput, button(t("Answer"), () => sendAnswer(answerInput.value), "primary", true));
      detailEl.append(card(
        h("div", { class: "title", text: task.question.text }),
        replies,
      ));
      }
    }
    const taskActions = h("div", { class: "tasks-actions" });
    if (PAUSABLE.has(task.status)) {
      taskActions.append(button(t("Pause"), () => {
        void OrchestratorBridge.pauseTask(task.id).then(() => reload(), () => reload());
      }));
    } else if (task.status === "paused") {
      taskActions.append(button(t("Resume"), () => {
        void OrchestratorBridge.resumeTask(task.id).then(() => reload(), () => reload());
      }, "primary"));
    }
    if (ACTIVE.has(task.status)) {
      taskActions.append(button(t("Cancel"), () => void OrchestratorBridge.cancel(task.id).then(() => reload(), () => reload()), "danger"));
    }
    if (taskActions.childElementCount) detailEl.append(taskActions);

    const entries = h("div", { class: "hub-entries" });
    for (const e of detail.events) {
      const line = eventLine(e);
      if (!line) continue;
      entries.append(h("div", { class: "hub-entry" },
        h("div", { class: "when", text: time(e.timestamp) }),
        h("div", { class: "words", text: line }),
      ));
    }
    detailEl.append(card(entries));

    const filesEl = h("div", {});
    const showFiles = () => {
      clear(filesEl);
      if (!files) {
        filesEl.append(button(t("Files"), () => {
          OrchestratorBridge.files(task.agentId, task.id).then((r) => {
            files = r.files;
            showFiles();
          }, (err) => {
            filesEl.append(h("div", { class: "hub-warn", text: String(err) }));
          });
        }));
        return;
      }
      for (const f of files) {
        const save = button(t("Save"), () => {
          OrchestratorBridge.saveFile(task.agentId, task.id, f.path).then(
            (where) => filesEl.append(h("div", { class: "hub-ok", text: t("Saved to {path}", { path: where }) })),
            (err) => filesEl.append(h("div", { class: "hub-warn", text: String(err) })),
          );
        }, "", true);
        filesEl.append(row(f.path, `${f.bytes} B`, save));
      }
    };
    showFiles();
    detailEl.append(card(filesEl));
  }

  // Live: every backend event the stream brings, and the connection's state.
  let queued = false;
  let refreshExtras = false;
  const soon = (extras = false) => {
    refreshExtras ||= extras;
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      const extras = refreshExtras;
      refreshExtras = false;
      void reload(extras);
    }, 250);
  };
  const stops = await Promise.all([
    onEvent<OrchEvent>("orchestrator-event", (event) => {
      soon(
        event.type === "goal.updated" ||
        event.type === "goal.checkin" ||
        event.type === "memory.updated" ||
        event.type === "agent.updated" ||
        event.type === "team.updated",
      );
    }),
    onEvent<unknown>("orchestrator-status", () => soon(true)),
  ]);
  ctx.onLeave = () => {
    for (const stop of stops) stop();
  };

  await reload(true);
}
