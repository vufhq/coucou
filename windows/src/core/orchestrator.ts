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

export type TaskStatus = "queued" | "starting" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export interface OrchTask {
  id: string;
  agentId: string;
  prompt: string;
  modelProfileId: string;
  status: TaskStatus;
  steps: number;
  result: { summary: string; artifacts: string[] } | null;
  error: { reason: string; message: string } | null;
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

export interface OrchAgent {
  id: string;
  name: string;
  status: "offline" | "starting" | "ready" | "busy" | "error";
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
  tasks: () => callOrThrow<{ tasks: OrchTask[] | null; agents: OrchAgent[] | null; approvals: OrchApproval[] | null }>("orchestrator_tasks"),
  task: (taskId: string) =>
    callOrThrow<{ task: OrchTask; approvals: OrchApproval[]; events: OrchEvent[] }>("orchestrator_task", { taskId }),
  submit: (prompt: string, idempotencyKey: string, modelProfileId: string | null) =>
    callOrThrow<{ task: OrchTask; created: boolean }>("orchestrator_submit", { prompt, idempotencyKey, modelProfileId }),
  models: () => callOrThrow<{ profiles: { id: string }[]; default: string | null }>("orchestrator_models"),
  cancel: (taskId: string) => callOrThrow<{ task: OrchTask }>("orchestrator_cancel", { taskId }),
  decide: (agentId: string, approvalId: string, approve: boolean) =>
    callOrThrow<unknown>("orchestrator_decide", { agentId, approvalId, approve }),
  files: (agentId: string, taskId: string) =>
    callOrThrow<{ files: { path: string; bytes: number }[] }>("orchestrator_files", { agentId, taskId }),
  saveFile: (agentId: string, taskId: string, path: string) =>
    callOrThrow<string>("orchestrator_save_file", { agentId, taskId, path }),
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

export const ACTIVE: ReadonlySet<TaskStatus> = new Set(["queued", "starting", "running", "waiting_for_approval"]);

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "starting":
    case "running":
      return t("Running");
    case "waiting_for_approval":
      return t("Waiting for approval");
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
