// What a model may answer at each step: one operation to run, or "done".
//
// Kept flat on purpose: every provider and local model can fill an object
// with a `kind` and a few fields, while nested unions trip many of them up.
// The arguments are then checked against the operation's own schema.

import { z } from "zod";
import { BACKEND_ONLY_OPS, MODEL_OP_NAMES, parseOperation, type Operation } from "./ops.ts";

export const RawDecision = z.object({
  kind: z.enum(["action", "ask", "done"]),
  /** One short sentence for the activity timeline; never shown to the worker. */
  note: z.string().max(300).optional(),
  op: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  summary: z.string().max(4_000).optional(),
  question: z.string().trim().min(1).max(500).optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
  remember: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
  goalAchieved: z.boolean().optional(),
});

export type Decision =
  | { kind: "action"; note: string; op: Operation }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "done"; summary: string; remember: string[]; goalAchieved: boolean };

export type ParsedDecision = { ok: true; decision: Decision } | { ok: false; error: string };

export function parseDecision(value: unknown): ParsedDecision {
  const raw = RawDecision.safeParse(value);
  if (!raw.success) return { ok: false, error: "the answer is not a decision object" };
  const d = raw.data;
  if (d.kind === "done") {
    if (!d.summary?.trim()) return { ok: false, error: "done needs a summary" };
    return {
      ok: true,
      decision: {
        kind: "done",
        summary: d.summary.trim(),
        remember: d.remember ?? [],
        goalAchieved: d.goalAchieved ?? false,
      },
    };
  }
  if (d.kind === "ask") {
    if (!d.question) return { ok: false, error: "ask needs a question" };
    return { ok: true, decision: { kind: "ask", question: d.question, options: d.options ?? [] } };
  }
  const op = parseOperation(d.op, d.args);
  if (!op.ok) return { ok: false, error: op.error };
  if (BACKEND_ONLY_OPS.has(op.op.op)) return { ok: false, error: `unknown operation ${op.op.op}` };
  return { ok: true, decision: { kind: "action", note: d.note?.trim() ?? "", op: op.op } };
}

/** JSON Schema handed to providers that support structured output. */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["action", "ask", "done"] },
    note: { type: "string", description: "One short sentence: what this step does and why." },
    op: { type: "string", enum: MODEL_OP_NAMES },
    args: { type: "object", description: "Arguments of the operation, as described in the instructions." },
    summary: { type: "string", description: "With kind=done: the final answer for the user, in Markdown." },
    question: { type: "string", minLength: 1, maxLength: 500, description: "With kind=ask: the question for the user." },
    options: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 80 },
      description: "With kind=ask: optional suggested answers.",
    },
    remember: {
      type: "array",
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 300 },
      description: "With kind=done: durable facts useful for later tasks.",
    },
    goalAchieved: { type: "boolean", description: "With kind=done: whether this goal is fully achieved." },
  },
} as const;
