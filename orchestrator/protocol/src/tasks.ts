// Tasks: what Coucou submits and what the backend keeps about each one.

import { z } from "zod";

/** Same rule as Coucou's `coucou_agent` tag: the pill becomes `agent_<id>`. */
export const AgentId = z.string().regex(/^[a-z0-9-]{1,24}$/).refine((id) => id !== "claude", "reserved");
export type AgentId = z.infer<typeof AgentId>;

export const TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const FINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);

export const Budget = z.object({
  maxSteps: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(10_000).max(6 * 60 * 60_000),
  /** Per operation, enforced by the worker as well. */
  opTimeoutMs: z.number().int().min(1_000).max(10 * 60_000),
});
export type Budget = z.infer<typeof Budget>;

export const DEFAULT_BUDGET: Budget = { maxSteps: 20, timeoutMs: 10 * 60_000, opTimeoutMs: 60_000 };

export const CreateTaskRequest = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  agentId: AgentId.default("agent-01"),
  /**
   * Chosen by the client and sent again on a retry: the same key returns the
   * task already created instead of starting a second one.
   */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  modelProfileId: z.string().min(1).max(64).optional(),
  budget: Budget.partial().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/** Why a task failed, in words the island can show. */
export const FailureReason = z.enum([
  "timeout",
  "max_steps",
  "worker_lost",
  "interrupted",
  "model_error",
  "rate_limited",
  "policy_denied",
  "rejected",
  "operation_failed",
  "internal",
]);
export type FailureReason = z.infer<typeof FailureReason>;

export const Task = z.object({
  id: z.string(),
  agentId: AgentId,
  prompt: z.string(),
  status: TaskStatus,
  modelProfileId: z.string(),
  workspace: z.string(),
  budget: Budget,
  steps: z.number().int(),
  result: z.object({ summary: z.string(), artifacts: z.array(z.string()) }).nullable(),
  error: z.object({ reason: FailureReason, message: z.string() }).nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const Agent = z.object({
  id: AgentId,
  name: z.string(),
  vmId: z.string(),
  status: z.enum(["offline", "starting", "ready", "busy", "error"]),
  modelProfileId: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const ApprovalDecision = z.object({
  approvalId: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
