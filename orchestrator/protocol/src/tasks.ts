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
  "waiting_for_answer",
  "paused",
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
  source: z.enum(["user", "chat"]).optional().default("user"),
  /** Which agent runs it. Left out, the backend picks one (an idle one first). */
  agentId: AgentId.optional(),
  /**
   * Chosen by the client and sent again on a retry: the same key returns the
   * task already created instead of starting a second one.
   */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  modelProfileId: z.string().min(1).max(64).optional(),
  budget: Budget.partial().optional(),
  /**
   * The conversation this task comes from (Coucou's chat with the agent), so
   * a follow-up like "now make it shorter" makes sense. Background for the
   * model, never instructions.
   */
  context: z.string().max(8_000).optional(),
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
  "unanswered",
  "internal",
]);
export type FailureReason = z.infer<typeof FailureReason>;

export const TaskQuestion = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.string()),
});
export type TaskQuestion = z.infer<typeof TaskQuestion>;

export const Task = z.object({
  id: z.string(),
  agentId: AgentId,
  prompt: z.string(),
  status: TaskStatus,
  source: z.enum(["user", "chat", "goal"]),
  goalId: z.string().nullable(),
  question: TaskQuestion.nullable(),
  waitingReason: z.enum(["agent_paused", "daily_limit"]).nullable(),
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
  paused: z.boolean(),
  limits: z.object({
    tasksPerDay: z.number().int(),
    stepsPerDay: z.number().int(),
  }),
  usage: z.object({
    tasksToday: z.number().int(),
    stepsToday: z.number().int(),
  }),
  /** The colour the user gave it (#RRGGBB), or null for Coucou's default. */
  color: z.string().nullable(),
  modelProfileId: z.string(),
  lastSeenAt: z.string().nullable(),
  /** The worker's last health report, and when it came. */
  health: z
    .object({
      diskFreeBytes: z.number(),
      diskTotalBytes: z.number(),
      browserReady: z.boolean(),
      checkedAt: z.string(),
    })
    .nullable(),
});
export type Agent = z.infer<typeof Agent>;

/**
 * What is wrong with an agent's computer, if anything, as a code Coucou
 * words in the user's language:
 * - vm_stopped: the WSL distro is not running
 * - worker_down: the distro runs but its worker does not answer
 * - low_disk: under 1 GiB free in the workspace
 * - no_browser: Chromium is missing, browser steps will fail
 */
export const AgentProblem = z.enum(["vm_stopped", "worker_down", "low_disk", "no_browser", "daily_limit"]);
export type AgentProblem = z.infer<typeof AgentProblem>;

export const AgentLimits = z
  .object({
    tasksPerDay: z.number().int().min(1).max(500),
    stepsPerDay: z.number().int().min(10).max(5_000),
  })
  .strict();
export type AgentLimits = z.infer<typeof AgentLimits>;

export const TaskAnswer = z
  .object({
    questionId: z.string().min(1),
    answer: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type TaskAnswer = z.infer<typeof TaskAnswer>;

/** What the user may change about an agent: its name and colour. Null puts the default back. */
export const AgentIdentity = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u, "no control characters")
      .nullable()
      .optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "a colour like #22C55E")
      .nullable()
      .optional(),
  })
  .strict();
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const ApprovalDecision = z.object({
  approvalId: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
