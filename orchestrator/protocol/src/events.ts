// The versioned event envelope Coucou reads, and the allowlisted event types.
//
// `seq` is global and strictly increasing: Coucou remembers the last one it
// saw and asks for everything after it, which is how a closed and reopened
// island catches up. `sequence` counts within one task, as the brief asks.
// Agent-level events (heartbeat, status) belong to no task.

import { z } from "zod";
import { AgentId, FailureReason, TaskStatus } from "./tasks.ts";
import { OpName } from "./ops.ts";

export const EVENT_VERSION = 1;

export const EVENT_TYPES = [
  "task.queued",
  "task.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "agent.heartbeat",
  "agent.status_changed",
  "tool.started",
  "tool.output",
  "tool.completed",
  "browser.navigation",
  "browser.screenshot_available",
  "approval.requested",
  "approval.resolved",
  "artifact.created",
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Payload shape for each event type. Unknown keys are refused. */
export const EVENT_PAYLOADS = {
  "task.queued": z.object({ prompt: z.string() }).strict(),
  "task.started": z.object({ prompt: z.string(), modelProfileId: z.string() }).strict(),
  "task.completed": z.object({ summary: z.string(), artifacts: z.array(z.string()) }).strict(),
  "task.failed": z.object({ reason: FailureReason, message: z.string() }).strict(),
  "task.cancelled": z.object({}).strict(),
  "agent.heartbeat": z.object({}).strict(),
  "agent.status_changed": z.object({ status: z.enum(["offline", "starting", "ready", "busy", "error"]) }).strict(),
  "tool.started": z.object({ jobId: z.string(), op: OpName, target: z.string() }).strict(),
  "tool.output": z.object({ jobId: z.string(), text: z.string().max(4_096) }).strict(),
  "tool.completed": z
    .object({ jobId: z.string(), op: OpName, ok: z.boolean(), summary: z.string().max(2_000) })
    .strict(),
  "browser.navigation": z.object({ jobId: z.string(), url: z.string(), title: z.string() }).strict(),
  "browser.screenshot_available": z.object({ jobId: z.string(), path: z.string() }).strict(),
  "approval.requested": z
    .object({ approvalId: z.string(), op: OpName, target: z.string(), reason: z.string() })
    .strict(),
  "approval.resolved": z
    .object({ approvalId: z.string(), decision: z.enum(["approve", "reject", "expired"]) })
    .strict(),
  "artifact.created": z.object({ jobId: z.string(), path: z.string(), bytes: z.number().int() }).strict(),
} as const satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

export const AgentEvent = z.object({
  v: z.literal(EVENT_VERSION),
  id: z.string(),
  seq: z.number().int().positive(),
  taskId: z.string().nullable(),
  agentId: AgentId,
  sequence: z.number().int().positive().nullable(),
  type: EventType,
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export function parsePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EVENT_PAYLOADS[type].parse(payload) as EventPayload<T>;
}

/** Status a task-level event moves the task to, for clients that only watch events. */
export const STATUS_AFTER: Partial<Record<EventType, TaskStatus>> = {
  "task.queued": "queued",
  "task.started": "running",
  "task.completed": "succeeded",
  "task.failed": "failed",
  "task.cancelled": "cancelled",
  "approval.requested": "waiting_for_approval",
};
