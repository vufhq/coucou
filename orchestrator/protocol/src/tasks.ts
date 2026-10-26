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
  "waiting_for_agents",
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

export const MAX_TASK_ATTACHMENTS = 8;
export const MAX_TASK_LINKS = 4;

/** `https://github.com/owner/repo`, maybe with `.git` or a page inside the repository after it. */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/;

/** The repository a GitHub link points into, or null. */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  const m = GITHUB_REPO.exec(url);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1]!, repo: m[2]! };
}

export const GithubLink = z
  .string()
  .max(2_000)
  .refine((url) => githubRepo(url) !== null, "a link to a GitHub repository");

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
  /** Files the user attached (ids from POST /api/attachments), copied into the task folder first. */
  attachments: z.array(z.uuid()).max(MAX_TASK_ATTACHMENTS).optional(),
  /** GitHub repositories the user linked, cloned into the task folder first. */
  links: z.array(GithubLink).max(MAX_TASK_LINKS).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/** What a task got before it started: a file the user attached, or a repository cloned for it. */
export const TaskAttachment = z.object({
  kind: z.enum(["file", "repo"]),
  /** The file's name as the user saw it, or `owner/repo`. */
  name: z.string(),
  /** Where it is, relative to the task folder. */
  path: z.string(),
  bytes: z.number().int().nullable(),
  /** The repository's link. */
  url: z.string().nullable(),
});
export type TaskAttachment = z.infer<typeof TaskAttachment>;

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
  source: z.enum(["user", "chat", "goal", "delegated"]),
  parentTaskId: z.string().nullable(),
  goalId: z.string().nullable(),
  question: TaskQuestion.nullable(),
  /** Questions the task asked and the answers it got, oldest first. */
  answers: z.array(
    z.object({
      question: TaskQuestion,
      answer: z.string(),
      askedAt: z.string().optional(),
      answeredAt: z.string().optional(),
    }),
  ),
  waitingReason: z.enum(["agent_paused", "daily_limit", "computer_offline"]).nullable(),
  /** Files and repositories copied into the task folder before the first step. */
  attachments: z.array(TaskAttachment),
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
  kind: z.enum(["chief", "coworker"]),
  role: z.string().nullable(),
  outfit: z
    .enum([
      "none",
      "partyHat",
      "beanie",
      "crown",
      "sunglasses",
      "roundGlasses",
      "bow",
      "scarf",
      "witchHat",
      "pumpkin",
      "santaHat",
      "bunnyEars",
    ])
    .nullable(),
  teamId: z.string().nullable(),
  order: z.number(),
  computerId: AgentId,
  createdBy: z.enum(["system", "user", "chief"]),
  persona: z.string().nullable(),
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

export const AgentOutfit = Agent.shape.outfit.unwrap();
export type AgentOutfit = z.infer<typeof AgentOutfit>;

export const Team = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  order: z.number(),
  createdAt: z.string(),
});
export type Team = z.infer<typeof Team>;

export const Computer = z.object({
  id: AgentId,
  vmId: z.string(),
  status: z.enum(["offline", "starting", "ready", "busy", "error"]),
  lastSeenAt: z.string().nullable(),
  health: Agent.shape.health,
  problems: z.array(z.enum(["vm_stopped", "worker_down", "low_disk", "no_browser"])),
  agentIds: z.array(AgentId),
});
export type Computer = z.infer<typeof Computer>;

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

const AgentName = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u, "no control characters");
const AgentColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "a colour like #22C55E");
const AgentRole = z.string().trim().min(1).max(60);
const AgentPersona = z.string().trim().min(1).max(1_000);

/** What the user may change about an agent. Null puts the default back. */
export const AgentIdentity = z
  .object({
    name: AgentName.nullable().optional(),
    color: AgentColor.nullable().optional(),
    role: AgentRole.nullable().optional(),
    outfit: AgentOutfit.nullable().optional(),
    teamId: z.string().min(1).nullable().optional(),
    order: z.number().int().min(0).optional(),
    computerId: AgentId.optional(),
    persona: AgentPersona.nullable().optional(),
  })
  .strict();
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const CreateAgentRequest = z
  .object({
    name: AgentName,
    role: AgentRole.optional(),
    color: AgentColor.optional(),
    outfit: AgentOutfit.optional(),
    teamId: z.string().min(1).optional(),
    computerId: AgentId.optional(),
    persona: AgentPersona.optional(),
  })
  .strict();
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const CreateTeamRequest = z.object({ name: z.string().trim().min(1).max(40) }).strict();
export const UpdateTeamRequest = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    order: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

export const ApprovalDecision = z.object({
  approvalId: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
