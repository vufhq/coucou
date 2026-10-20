import { z } from "zod";
import { AgentId } from "./tasks.ts";

const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "a time like 09:30");

export const Schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("every"), hours: z.number().int().min(1).max(168) }).strict(),
  z.object({ kind: z.literal("daily"), time: ClockTime }).strict(),
  z.object({ kind: z.literal("weekdays"), time: ClockTime }).strict(),
]);
export type Schedule = z.infer<typeof Schedule>;

export const GoalStatus = z.enum(["active", "paused", "achieved"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const Goal = z.object({
  id: z.string(),
  agentId: AgentId,
  title: z.string().min(1).max(80),
  instructions: z.string().min(1).max(4_000),
  schedule: Schedule,
  modelProfileId: z.string().nullable(),
  status: GoalStatus,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  lastSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof Goal>;

export const CreateGoalRequest = z
  .object({
    agentId: AgentId,
    title: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(4_000),
    schedule: Schedule,
    modelProfileId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;

export const UpdateGoalRequest = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    instructions: z.string().trim().min(1).max(4_000).optional(),
    schedule: Schedule.optional(),
    modelProfileId: z.string().min(1).max(64).nullable().optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;

export const GoalRunRequest = z
  .object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) })
  .strict();

export const Note = z.object({
  id: z.string(),
  agentId: AgentId,
  text: z.string().min(1).max(300),
  source: z.enum(["agent", "user"]),
  taskId: z.string().nullable(),
  createdAt: z.string(),
});
export type Note = z.infer<typeof Note>;

export const CreateNoteRequest = z.object({ text: z.string().trim().min(1).max(300) }).strict();
