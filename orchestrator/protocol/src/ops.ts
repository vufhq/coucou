// The only operations a worker will ever run. The model proposes one of
// these, the backend's policy decides, and the worker validates it again
// before touching anything: a bug on either side cannot widen the set.

import { z } from "zod";

/**
 * A path inside the task's own folder: relative, forward slashes, no `..`,
 * no hidden segments. The worker still resolves it with realpath.
 */
export const RelPath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "relative path of letters, digits, . _ -")
  .refine((p) => p.split("/").every((seg) => seg !== ".." && seg !== "." && !seg.startsWith(".")), "no . or .. segments");

export const HttpUrl = z.url({ protocol: /^https?$/, error: "http or https URL" }).max(2_000);

export const OPS = {
  "browser.navigate": z.object({ url: HttpUrl }).strict(),
  "browser.extract_text": z.object({ maxChars: z.number().int().min(100).max(50_000).optional() }).strict(),
  "browser.screenshot": z.object({ name: RelPath.refine((p) => p.endsWith(".png"), "must end in .png") }).strict(),
  "fs.write_artifact": z
    .object({ path: RelPath, content: z.string().max(200_000), overwrite: z.boolean().optional() })
    .strict(),
  "fs.list": z.object({}).strict(),
  "fs.read": z.object({ path: RelPath }).strict(),
  "terminal.run": z.object({ argv: z.array(z.string().min(1).max(1_000)).min(1).max(32) }).strict(),
} as const;

export type OpName = keyof typeof OPS;
export const OP_NAMES = Object.keys(OPS) as OpName[];
export const OpName = z.enum(OP_NAMES as [OpName, ...OpName[]]);

export type OpArgs<N extends OpName> = z.infer<(typeof OPS)[N]>;

export interface Operation {
  op: OpName;
  args: Record<string, unknown>;
}

/** Operations that change nothing: safe to run again after a lost worker. */
export const READ_ONLY_OPS: ReadonlySet<OpName> = new Set([
  "browser.navigate",
  "browser.extract_text",
  "fs.list",
  "fs.read",
]);

export type ParsedOp = { ok: true; op: Operation } | { ok: false; error: string };

export function parseOperation(op: unknown, args: unknown): ParsedOp {
  const name = OpName.safeParse(op);
  if (!name.success) return { ok: false, error: `unknown operation ${String(op).slice(0, 40)}` };
  const parsed = OPS[name.data].safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: `${name.data}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}` };
  }
  return { ok: true, op: { op: name.data, args: parsed.data as Record<string, unknown> } };
}
