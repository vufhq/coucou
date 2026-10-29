// The only operations a worker will ever run. The model proposes one of
// these, the backend's policy decides, and the worker validates it again
// before touching anything: a bug on either side cannot widen the set.

import { z } from "zod";
import { AgentId, AgentOutfit } from "./tasks.ts";

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

/** How long a shell command may run, unless the model asks for less or more. */
export const SHELL_DEFAULT_TIMEOUT_SEC = 120;
export const SHELL_MAX_TIMEOUT_SEC = 600;

/** `owner/name` on github.com. */
export const GithubRepo = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "owner/name of a GitHub repository")
  .refine((r) => !r.endsWith(".git") && !r.split("/")[1]!.startsWith("."), "owner/name, without .git");

/** A branch name git accepts, never an option and never a full ref. */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/, "a branch name of letters, digits and . _ / -")
  .refine(
    (b) => !b.startsWith("refs/") && !b.includes("..") && !b.includes("//") && !b.endsWith("/") && !b.endsWith(".") && !b.endsWith(".lock") && !b.split("/").some((s) => s.startsWith(".")),
    "not a valid branch name",
  );

export const HttpUrl =z.url({ protocol: /^https?$/, error: "http or https URL" }).max(2_000);

/** The largest file the user may attach to a message. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const WORKER_OPS = {
  "browser.navigate": z.object({ url: HttpUrl }).strict(),
  "browser.extract_text": z.object({ maxChars: z.number().int().min(100).max(50_000).optional() }).strict(),
  "browser.screenshot": z.object({ name: RelPath.refine((p) => p.endsWith(".png"), "must end in .png") }).strict(),
  "fs.write_artifact": z
    .object({ path: RelPath, content: z.string().max(200_000), overwrite: z.boolean().optional() })
    .strict(),
  "fs.list": z.object({}).strict(),
  "fs.read": z.object({ path: RelPath }).strict(),
  "fs.fetch": z.object({ path: RelPath }).strict(),
  // A file the user attached, pulled from the backend into the task folder.
  "fs.receive": z
    .object({
      path: RelPath,
      upload: z.uuid(),
      bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  "terminal.run": z.object({ argv: z.array(z.string().min(1).max(1_000)).min(1).max(32) }).strict(),
  // A bash command line on the shared computer, as its sandboxed `runner`
  // user. `cwd` is a folder under the task folder, or `~/…` for the agent's
  // own folder that outlives the task.
  "terminal.shell": z
    .object({
      command: z.string().min(1).max(8_000),
      cwd: z
        .string()
        .max(200)
        .regex(/^(?:~|~\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/, "a folder in the task folder, or ~/…")
        .refine((p) => p.split("/").every((seg) => seg !== ".." && seg !== "."), "no . or .. segments")
        .optional(),
      timeoutSec: z.number().int().min(1).max(SHELL_MAX_TIMEOUT_SEC).optional(),
    })
    .strict(),
  // Through the user's GitHub account. The worker runs git itself, with the
  // token only in that one process: the shell never gets it.
  "git.clone": z.object({ repo: GithubRepo, dir: RelPath }).strict(),
  // Pushes the local branch `branch` of the repo in `dir` to the same branch
  // of `repo`, never forced. `repo` must be one this agent cloned with git.clone.
  "git.push": z.object({ repo: GithubRepo, dir: RelPath, branch: BranchName }).strict(),
} as const;

/** Operations that use the user's GitHub account. */
export const GITHUB_OPS: ReadonlySet<string> = new Set(["git.clone", "git.push"]);

const Member = z
  .object({
    name: z.string().trim().min(1).max(40),
    role: z.string().trim().min(1).max(60),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    outfit: AgentOutfit.optional(),
    persona: z.string().trim().min(1).max(1_000),
    // Ignored: every agent shares one computer. Still accepted so a reply
    // that names one doesn't fail to parse.
    computerId: AgentId.optional(),
  })
  .strict();

const OrganizeChange = z.union([
  z.object({ renameTeam: z.object({ teamId: z.string().min(1), name: z.string().trim().min(1).max(40) }).strict() }).strict(),
  z
    .object({
      moveAgent: z.object({ agentId: AgentId, teamId: z.string().min(1).nullable(), order: z.number().int().min(0).optional() }).strict(),
    })
    .strict(),
  z.object({ setRole: z.object({ agentId: AgentId, role: z.string().trim().min(1).max(60) }).strict() }).strict(),
  z.object({ renameAgent: z.object({ agentId: AgentId, name: z.string().trim().min(1).max(40) }).strict() }).strict(),
  z
    .object({
      restyle: z
        .object({
          agentId: AgentId,
          color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
          outfit: AgentOutfit.optional(),
        })
        .strict()
        .refine((value) => value.color !== undefined || value.outfit !== undefined, "color or outfit is required"),
    })
    .strict(),
]);

export const MANAGEMENT_OPS = {
  "team.propose": z
    .object({
      team: z.union([
        z.object({ name: z.string().trim().min(1).max(40) }).strict(),
        z.object({ id: z.string().min(1) }).strict(),
      ]),
      members: z.array(Member).min(1).max(8),
    })
    .strict(),
  "team.organize": z.object({ changes: z.array(OrganizeChange).min(1).max(20) }).strict(),
  "team.retire": z.object({ agentId: AgentId }).strict(),
  "agent.delegate": z
    .object({
      assignments: z
        .array(z.object({ agentId: AgentId, message: z.string().trim().min(1).max(4_000) }).strict())
        .min(1)
        .max(6),
    })
    .strict(),
  "agent.answer": z.object({ taskId: z.string().min(1), answer: z.string().trim().min(1).max(2_000) }).strict(),
  "agent.wait": z.object({ taskIds: z.array(z.string().min(1)).max(12).optional() }).strict(),
} as const;

export const OPS = { ...WORKER_OPS, ...MANAGEMENT_OPS } as const;

export type WorkerOpName = keyof typeof WORKER_OPS;
/** Kept worker-only: existing workers send this list in hello unchanged. */
export const OP_NAMES = Object.keys(WORKER_OPS) as WorkerOpName[];
export const WorkerOpName = z.enum(OP_NAMES as [WorkerOpName, ...WorkerOpName[]]);

export type ManagementOpName = keyof typeof MANAGEMENT_OPS;
export const MANAGEMENT_OP_NAMES = Object.keys(MANAGEMENT_OPS) as ManagementOpName[];
export const MANAGEMENT_OP_SET: ReadonlySet<OpName> = new Set(MANAGEMENT_OP_NAMES);

export type OpName = keyof typeof OPS;
export const ALL_OP_NAMES = Object.keys(OPS) as OpName[];
export const OpName = z.enum(ALL_OP_NAMES as [OpName, ...OpName[]]);

export type OpArgs<N extends OpName> = z.infer<(typeof OPS)[N]>;

export interface Operation {
  op: OpName;
  args: Record<string, unknown>;
}

/**
 * Operations that change nothing, or only write the same bytes again: safe to
 * run again after a lost worker.
 */
export const READ_ONLY_OPS: ReadonlySet<WorkerOpName> = new Set([
  "browser.navigate",
  "browser.extract_text",
  "fs.list",
  "fs.read",
  "fs.fetch",
  "fs.receive",
]);

/**
 * Operations only the backend asks for, on the user's behalf (a file
 * download for Coucou, a file the user attached). A model answer naming one
 * is refused.
 */
export const BACKEND_ONLY_OPS: ReadonlySet<OpName> = new Set(["fs.fetch", "fs.receive"]);

/** What a model may propose. */
export const MODEL_OP_NAMES = ALL_OP_NAMES.filter((op) => !BACKEND_ONLY_OPS.has(op));

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
