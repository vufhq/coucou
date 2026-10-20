// The orchestrator backend as the Tasks page sees it (src-tauri/src/orchestrator.rs).
// Tasks run in the backend and the agent's VM; the page only asks and shows.
// The access key never reaches the webview: Rust adds it to every request.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/i18n";

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_answer"
  | "waiting_for_agents"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskSource = "user" | "chat" | "goal" | "delegated";

export interface OrchTask {
  id: string;
  agentId: string;
  prompt: string;
  modelProfileId: string;
  status: TaskStatus;
  steps: number;
  result: { summary: string; artifacts: string[] } | null;
  error: { reason: string; message: string } | null;
  source: TaskSource;
  parentTaskId: string | null;
  goalId: string | null;
  question: { id: string; text: string; options: string[] } | null;
  waitingReason: "agent_paused" | "daily_limit" | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchApproval {
  id: string;
  taskId: string;
  agentId: string;
  op: string;
  target: string;
  reason: string;
}

/** What the backend found wrong with an agent's computer (AgentProblem in the protocol). */
export type AgentProblem = "vm_stopped" | "worker_down" | "low_disk" | "no_browser" | "daily_limit";

export interface OrchAgent {
  id: string;
  name: string;
  status: "offline" | "starting" | "ready" | "busy" | "error";
  /** The user's colour for it, or null for the default. */
  color?: string | null;
  /** Absent from a backend older than the health checks. */
  problems?: AgentProblem[];
  paused: boolean;
  limits: { tasksPerDay: number; stepsPerDay: number };
  usage: { tasksToday: number; stepsToday: number };
  kind: "chief" | "coworker";
  role: string | null;
  outfit: OrchOutfit | null;
  teamId: string | null;
  order: number;
  computerId: string;
  createdBy: "system" | "user" | "chief";
  persona: string | null;
}

export type OrchOutfit =
  | "none"
  | "partyHat"
  | "beanie"
  | "crown"
  | "sunglasses"
  | "roundGlasses"
  | "bow"
  | "scarf"
  | "witchHat"
  | "pumpkin"
  | "santaHat"
  | "bunnyEars";

export interface OrchTeam {
  id: string;
  name: string;
  order: number;
  createdAt: string;
}

export interface OrchComputer {
  id: string;
  vmId: string;
  status: OrchAgent["status"];
  lastSeenAt: string | null;
  health: Record<string, unknown> | null;
  problems: AgentProblem[];
  agentIds: string[];
}

export type GoalSchedule =
  | { kind: "manual" }
  | { kind: "every"; hours: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string };

export interface OrchGoal {
  id: string;
  agentId: string;
  title: string;
  instructions: string;
  schedule: GoalSchedule;
  modelProfileId: string | null;
  status: "active" | "paused" | "achieved";
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryNote {
  id: string;
  agentId: string;
  text: string;
  source: "agent" | "user";
  taskId: string | null;
  createdAt: string;
}

export interface OrchEvent {
  seq: number;
  taskId: string | null;
  agentId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface OrchStatus {
  prefs: { enabled: boolean; url: string };
  status: { state: "off" | "connecting" | "connected" | "noToken" | "unreachable"; error: string | null };
  hasToken: boolean;
}

export const OrchestratorBridge = {
  status: () => callOrThrow<OrchStatus>("orchestrator_status"),
  setPrefs: (enabled: boolean, url: string) => callOrThrow<void>("orchestrator_set_prefs", { enabled, url }),
  tasks: () => callOrThrow<{
    tasks: OrchTask[] | null;
    agents: OrchAgent[] | null;
    teams: OrchTeam[] | null;
    computers: OrchComputer[] | null;
    approvals: OrchApproval[] | null;
  }>("orchestrator_tasks"),
  task: (taskId: string) =>
    callOrThrow<{ task: OrchTask; approvals: OrchApproval[]; events: OrchEvent[] }>("orchestrator_task", { taskId }),
  /** `agentId` null: the backend picks a free agent. */
  submit: (
    prompt: string,
    idempotencyKey: string,
    modelProfileId: string | null,
    agentId: string | null = null,
    context: string | null = null,
    source: "user" | "chat" = "user",
  ) =>
    callOrThrow<{ task: OrchTask; created: boolean }>("orchestrator_submit", {
      prompt, idempotencyKey, modelProfileId, agentId, context, source,
    }),
  models: () => callOrThrow<{ profiles: { id: string }[]; default: string | null }>("orchestrator_models"),
  cancel: (taskId: string) => callOrThrow<{ task: OrchTask }>("orchestrator_cancel", { taskId }),
  answer: (taskId: string, questionId: string, answer: string) =>
    callOrThrow<{ task: OrchTask }>("orchestrator_answer", { taskId, questionId, answer }),
  pauseTask: (taskId: string) => callOrThrow<{ task: OrchTask }>("orchestrator_pause_task", { taskId }),
  resumeTask: (taskId: string) => callOrThrow<{ task: OrchTask }>("orchestrator_resume_task", { taskId }),
  agents: () => callOrThrow<{
    agents: OrchAgent[] | null;
    teams: OrchTeam[] | null;
    computers: OrchComputer[] | null;
  }>("orchestrator_agents"),
  pauseAgent: (agentId: string) => callOrThrow<{ agent: OrchAgent }>("orchestrator_pause_agent", { agentId }),
  resumeAgent: (agentId: string) => callOrThrow<{ agent: OrchAgent }>("orchestrator_resume_agent", { agentId }),
  setLimits: (agentId: string, tasksPerDay: number, stepsPerDay: number) =>
    callOrThrow<{ agent: OrchAgent }>("orchestrator_set_limits", { agentId, tasksPerDay, stepsPerDay }),
  /** Changes an agent; null puts the default back, a missing field is left alone. */
  updateAgent: (agentId: string, identity: Partial<Pick<
    OrchAgent,
    "name" | "color" | "role" | "outfit" | "teamId" | "order" | "computerId" | "persona"
  >>) =>
    callOrThrow<{ agent: OrchAgent }>("orchestrator_update_agent", { agentId, identity }),
  createAgent: (identity: Pick<OrchAgent, "name"> & Partial<Pick<
    OrchAgent,
    "role" | "color" | "outfit" | "teamId" | "computerId" | "persona"
  >>) => callOrThrow<{ agent: OrchAgent }>("orchestrator_create_agent", { identity }),
  retireAgent: (agentId: string) =>
    callOrThrow<{ ok: boolean }>("orchestrator_retire_agent", { agentId }),
  createTeam: (name: string) =>
    callOrThrow<{ team: OrchTeam }>("orchestrator_create_team", { name }),
  updateTeam: (teamId: string, changes: Partial<Pick<OrchTeam, "name" | "order">>) =>
    callOrThrow<{ team: OrchTeam }>("orchestrator_update_team", { teamId, changes }),
  deleteTeam: (teamId: string) =>
    callOrThrow<{ ok: boolean }>("orchestrator_delete_team", { teamId }),
  decide: (agentId: string, approvalId: string, approve: boolean) =>
    callOrThrow<unknown>("orchestrator_decide", { agentId, approvalId, approve }),
  files: (agentId: string, taskId: string) =>
    callOrThrow<{ files: { path: string; bytes: number }[] }>("orchestrator_files", { agentId, taskId }),
  saveFile: (agentId: string, taskId: string, path: string) =>
    callOrThrow<string>("orchestrator_save_file", { agentId, taskId, path }),
  chatHistory: (agentId: string) =>
    callOrThrow<{ tasks: OrchTask[] | null }>("orchestrator_chat_history", { agentId }),
  goals: (agentId: string) =>
    callOrThrow<{ goals: OrchGoal[] | null }>("orchestrator_goals", { agentId }),
  createGoal: (
    agentId: string,
    title: string,
    instructions: string,
    schedule: GoalSchedule,
    modelProfileId: string | null = null,
  ) => callOrThrow<{ goal: OrchGoal }>("orchestrator_create_goal", {
    agentId, title, instructions, schedule, modelProfileId,
  }),
  updateGoal: (
    goalId: string,
    changes: Partial<Pick<OrchGoal, "title" | "instructions" | "schedule" | "modelProfileId" | "status">>,
  ) => callOrThrow<{ goal: OrchGoal }>("orchestrator_update_goal", { goalId, changes }),
  deleteGoal: (goalId: string) => callOrThrow<{ ok: boolean }>("orchestrator_delete_goal", { goalId }),
  runGoal: (goalId: string, idempotencyKey: string) =>
    callOrThrow<{ task: OrchTask; created: boolean }>("orchestrator_run_goal", { goalId, idempotencyKey }),
  memory: (agentId: string) =>
    callOrThrow<{ notes: MemoryNote[] | null }>("orchestrator_memory", { agentId }),
  addMemory: (agentId: string, text: string) =>
    callOrThrow<{ note: MemoryNote }>("orchestrator_add_memory", { agentId, text }),
  deleteMemory: (agentId: string, noteId: string) =>
    callOrThrow<{ ok: boolean }>("orchestrator_delete_memory", { agentId, noteId }),
};

/** What a model profile is called on the page: the subscription it runs on. */
export function modelLabel(profileId: string): string {
  switch (profileId) {
    case "claude-cli":
      return "Claude";
    case "cursor-cli":
      return "Cursor";
    default:
      return profileId;
  }
}

/** A fresh idempotency key: a retried click sends the same one and gets the same task. */
export function newTaskKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `coucou-${Date.now().toString(36)}-${rand}`;
}

/** How an agent's computer is doing, in one line: its state, then whatever is wrong. */
export function agentLine(agent: Pick<OrchAgent, "status"> & Partial<Pick<OrchAgent, "paused" | "problems">>): string {
  const state = agent.paused
    ? t("Paused")
    : agent.status === "offline"
      ? t("Offline")
      : agent.status === "busy"
        ? t("Busy")
        : agent.status === "starting"
          ? t("Starting…")
          : agent.status === "error"
            ? t("Error")
            : t("Ready");
  const problems = (agent.problems ?? []).map((p) => {
    switch (p) {
      case "vm_stopped":
        return t("Its Linux computer is not running.");
      case "worker_down":
        return t("Its Linux computer is running, but the worker in it does not answer.");
      case "low_disk":
        return t("Its disk is almost full.");
      case "no_browser":
        return t("Chromium is missing: web steps will fail.");
      case "daily_limit":
        return t("Daily limit reached");
    }
  });
  return [state, ...problems].join(" · ");
}

export const ACTIVE: ReadonlySet<TaskStatus> = new Set([
  "queued", "starting", "running", "waiting_for_approval", "waiting_for_answer", "waiting_for_agents", "paused",
]);
export const PAUSABLE: ReadonlySet<TaskStatus> = new Set([
  "queued", "starting", "running", "waiting_for_approval", "waiting_for_answer", "waiting_for_agents",
]);

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "starting":
    case "running":
      return t("Running");
    case "waiting_for_approval":
      return t("Waiting for approval");
    case "waiting_for_answer":
      return t("Waiting for answer");
    case "waiting_for_agents":
      return t("Waiting for agents");
    case "paused":
      return t("Paused");
    case "succeeded":
      return t("Done");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One line of a task's timeline, or null for events the timeline leaves out. */
export function eventLine(e: OrchEvent): string | null {
  const p = e.payload;
  switch (e.type) {
    case "task.queued":
      return t("Queued");
    case "task.started":
      return t("Running");
    case "tool.started":
      return `▸ ${str(p.target) || str(p.op)}`;
    case "tool.completed":
      return `${p.ok === false ? "✗" : "✓"} ${str(p.summary)}`;
    case "browser.navigation":
      return `↗ ${str(p.title) || str(p.url)}`;
    case "artifact.created":
      return `＋ ${str(p.path)}`;
    case "approval.requested":
      return `? ${str(p.op)} · ${str(p.target)}`;
    case "approval.resolved":
      return p.decision === "approve" ? t("Approved") : t("Rejected");
    case "task.question":
      return `? ${str(p.question)}`;
    case "task.answered":
      return t("Answered");
    case "task.paused":
      return t("Paused");
    case "task.resumed":
      return t("Resumed");
    case "agent.delegated":
      return t("Asked {name}: {message}", { name: str(p.toAgentId), message: str(p.message) });
    case "agent.reported":
      return `${str(p.fromAgentId)}: ${str(p.summary)}`;
    case "task.waiting_for_agents":
      return t("Waiting for agents");
    case "goal.checkin":
      return `${t("Goal: {title}", { title: str(p.title) })} · ${str(p.summary)}`;
    case "task.completed":
      return t("Done");
    case "task.failed":
      return `${t("Failed")} · ${str(p.message)}`;
    case "task.cancelled":
      return t("Cancelled");
    default:
      return null;
  }
}

export function approvalLabel(op: string): string {
  if (op === "team.propose") return t("Create team");
  if (op === "team.retire") return t("Retire agent");
  return op;
}
