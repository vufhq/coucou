// Tasks: give an agent something to do, follow it, answer its questions, get
// its files. The work runs in the orchestrator backend and the agent's own
// Linux VM (orchestrator/ at the repository root); this page only asks and
// shows, in the Notetaker's list-and-detail layout.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { onEvent } from "../../core/bridge";
import {
  ACTIVE,
  OrchestratorBridge,
  agentLine,
  eventLine,
  modelLabel,
  newTaskKey,
  statusLabel,
  type OrchAgent,
  type OrchApproval,
  type OrchEvent,
  type OrchStatus,
  type OrchTask,
} from "../../core/orchestrator";
import type { HubContext } from "../shell";
import { button, card, row, segmented, toggle } from "../ui";
import { colorDot } from "../../settings/colors";
import { agentColor } from "../../island/agents";

/** The agent the island's Activity link asked for, picked up by the next draw. */
let agentFilter: string | null = null;

/** Shows only this agent's tasks (null: everyone's). */
export function showAgentTasks(agentId: string | null) {
  agentFilter = agentId && /^[a-z0-9-]{1,24}$/.test(agentId) ? agentId : null;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(document.documentElement.lang || undefined, { hour: "2-digit", minute: "2-digit" });

export async function tasksPage(page: HTMLElement, ctx: HubContext) {
  let status: OrchStatus | null = await OrchestratorBridge.status().catch(() => null);
  let tasks: OrchTask[] = [];
  let approvals: OrchApproval[] = [];
  let agents: OrchAgent[] = [];
  let selected: string | null = null;
  let detail: { task: OrchTask; events: OrchEvent[] } | null = null;
  let files: { path: string; bytes: number }[] | null = null;
  let note = "";
  let pendingKey = newTaskKey();
  /** What is typed in the box: the page redraws on every event and must not lose it. */
  let draft = "";
  let models: string[] = [];
  let model: string | null = null;
  /** The agent picked for the next task; null lets the backend choose a free one. */
  let agentChoice: string | null = null;
  /** An agent's name, for the task list once there is more than one. */
  const agentLabel = (id: string) => (agents.length > 1 ? ` · ${agents.find((a) => a.id === id)?.name ?? id}` : "");

  page.append(ctx.hero("tasks", t("Tasks"), t("Give your agents a task. Each one works in its own Linux computer and asks you before anything risky."), [], true));

  const connection = h("div", {});
  const composer = h("div", {});
  const approvalsEl = h("div", {});
  const listEl = h("div", { class: "hub-notes-list" });
  const detailEl = h("div", { class: "hub-note-detail" });
  page.append(connection, composer, approvalsEl, h("div", { class: "hub-notes" }, listEl, detailEl));

  const connected = () => status?.status.state === "connected";

  async function reload() {
    status = await OrchestratorBridge.status().catch(() => status);
    if (connected()) {
      const data = await OrchestratorBridge.tasks().catch(() => null);
      tasks = data?.tasks ?? [];
      approvals = data?.approvals ?? [];
      agents = data?.agents ?? [];
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
      void OrchestratorBridge.setPrefs(on, s?.prefs.url ?? "").then(reload, (err) => {
        note = String(err);
        draw();
      });
    });
    connection.append(card(row(t("Orchestrator backend"), line, sw)));
    if (!connected()) return;
    // The agent's computer: its state, and in words what is wrong with it if anything.
    for (const agent of agents) connection.append(card(agentRow(agent)));
  }

  /**
   * An agent: its state, and its name and colour, which are the user's to
   * change. They are the backend's, so the island and every window agree.
   */
  function agentRow(agent: OrchAgent): HTMLElement {
    const name = h("input", { class: "hub-input", placeholder: t("Name"), style: "width:130px", spellcheck: "false" }) as HTMLInputElement;
    name.value = agent.name;
    name.maxLength = 24;
    const save = () => {
      const next = name.value.trim();
      if (next === agent.name) return;
      // Empty: back to the agent's own id.
      OrchestratorBridge.updateAgent(agent.id, { name: next || null }).then(reload, (err) => {
        note = String(err);
        void reload();
      });
    };
    name.addEventListener("change", save);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    const pillId = `agent_${agent.id}`;
    const color = colorDot(
      { id: pillId, name: agent.name, color: agentColor(agent.id) },
      "width:14px;height:14px",
      () => (agent.color ? { [pillId]: agent.color } : {}),
      (next) => {
        OrchestratorBridge.updateAgent(agent.id, { color: next[pillId] ?? null }).then(reload, (err) => {
          note = String(err);
          void reload();
        });
      },
    );
    return row(agent.name, agentLine(agent), name, color);
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

  function drawApprovals() {
    clear(approvalsEl);
    for (const a of approvals) {
      const allow = button(t("Allow"), () => decide(a, true), "primary", true);
      const deny = button(t("Deny"), () => decide(a, false), "", true);
      approvalsEl.append(card(row(`${a.op} · ${a.target}`, `${t("Waiting for approval")} · ${a.reason}`, deny, allow)));
    }
  }

  function decide(a: OrchApproval, approve: boolean) {
    OrchestratorBridge.decide(a.agentId, a.id, approve).then(reload, (err) => {
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
    detailEl.append(
      h("h2", { text: task.prompt }),
      h("span", { class: "hub-tag", text: `${statusLabel(task.status)}${agentLabel(task.agentId)} · ${modelLabel(task.modelProfileId)}` }),
    );
    if (task.result) detailEl.append(h("div", { class: "hub-ok", style: "white-space:pre-wrap", text: task.result.summary }));
    if (task.error) detailEl.append(h("div", { class: "hub-warn", text: task.error.message }));
    if (ACTIVE.has(task.status)) {
      detailEl.append(button(t("Cancel"), () => void OrchestratorBridge.cancel(task.id).then(reload, reload), "danger"));
    }

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
  const soon = () => {
    if (queued) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      void reload();
    }, 250);
  };
  const stops = await Promise.all([
    onEvent<OrchEvent>("orchestrator-event", soon),
    onEvent<unknown>("orchestrator-status", soon),
  ]);
  ctx.onLeave = () => {
    for (const stop of stops) stop();
  };

  await reload();
}
