// The worker protocol: the narrow channel between the backend and the worker
// inside the VM. The worker only ever calls out; the VM opens no ports.

import { z } from "zod";
import { AgentId } from "./tasks.ts";
import { WorkerOpName } from "./ops.ts";

export const WORKER_PROTOCOL = "worker/v1";

export const JobError = z.object({
  code: z.enum(["invalid", "refused", "timeout", "cancelled", "failed", "interrupted"]),
  message: z.string().max(2_000),
});

export const JobOutcome = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  /** Short, already-truncated result the model gets to see. */
  result: z.string().max(20_000).optional(),
  error: JobError.optional(),
});
export type JobOutcome = z.infer<typeof JobOutcome>;

/** What the worker's journal says about a job, sent on every (re)connection. */
export const JournalEntry = z.object({
  jobId: z.string(),
  state: z.enum(["started", "finished"]),
  outcome: JobOutcome.optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/** How the agent's computer is doing, as the worker sees it. */
export const WorkerHealth = z.object({
  /** Free and total bytes on the disk that holds the workspace. */
  diskFreeBytes: z.number().int().nonnegative(),
  diskTotalBytes: z.number().int().nonnegative(),
  /** Chromium is installed and can be found. */
  browserReady: z.boolean(),
});
export type WorkerHealth = z.infer<typeof WorkerHealth>;

export const Hello = z.object({
  agentId: AgentId,
  version: z.string().max(32),
  capabilities: z.array(WorkerOpName),
  journal: z.array(JournalEntry).max(500),
  health: WorkerHealth.optional(),
});
export type Hello = z.infer<typeof Hello>;

export const HelloResponse = z.object({
  ok: z.literal(true),
  leaseMs: z.number().int().positive(),
  /** Task folders untouched for longer than this are removed. 0 keeps them. */
  retentionDays: z.number().int().nonnegative().default(0),
});

/** A claim, with the worker's health now and then (at most once a minute). */
export const ClaimRequest = z.object({ agentId: AgentId, health: WorkerHealth.optional() });
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/** The largest file a download carries (Coucou reads at most 8 MiB). */
export const MAX_FETCH_BYTES = 8 * 1024 * 1024 - 64 * 1024;

export const Job = z.object({
  id: z.string(),
  taskId: z.string(),
  op: WorkerOpName,
  args: z.record(z.string(), z.unknown()),
  deadlineMs: z.number().int().positive(),
});
export type Job = z.infer<typeof Job>;

export const ClaimResponse = z.object({
  job: Job.nullable(),
  /** Jobs the worker is running that must stop now. */
  cancel: z.array(z.string()),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const Heartbeat = z.object({ agentId: AgentId, running: z.array(z.string()).max(16) });
export type Heartbeat = z.infer<typeof Heartbeat>;

export const HeartbeatResponse = z.object({ cancel: z.array(z.string()) });

/** Events a worker may report. Task-level events are the backend's alone. */
export const WORKER_EVENT_TYPES = [
  "tool.output",
  "browser.navigation",
  "browser.screenshot_available",
  "artifact.created",
] as const;

export const WorkerEvent = z.object({
  type: z.enum(WORKER_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type WorkerEvent = z.infer<typeof WorkerEvent>;

export const WorkerEvents = z.object({ events: z.array(WorkerEvent).min(1).max(50) });
