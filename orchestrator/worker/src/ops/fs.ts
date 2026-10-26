// File operations, all inside the task's folder.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { MAX_FETCH_BYTES, type OpArgs } from "@coucou-orchestrator/protocol";
import { PathError, inside } from "../paths.ts";
import type { OpContext, OpResult } from "../worker.ts";

const MAX_LIST = 500;
const MAX_READ_CHARS = 20_000;

export async function writeArtifact(ctx: OpContext, args: OpArgs<"fs.write_artifact">): Promise<OpResult> {
  const path = await inside(ctx.dir, args.path);
  const exists = await stat(path).then(() => true, () => false);
  if (exists && args.overwrite !== true) {
    throw new PathError(`${args.path} already exists; set overwrite to replace it`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  await writeFile(path, args.content, { mode: 0o640 });
  const bytes = Buffer.byteLength(args.content);
  ctx.report("artifact.created", { path: args.path, bytes });
  return { result: `Wrote ${bytes} bytes to ${args.path}.` };
}

export async function listFiles(ctx: OpContext): Promise<OpResult> {
  const files: { path: string; bytes: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= MAX_LIST) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path: relative(ctx.dir, full).split("\\").join("/"), bytes: (await stat(full)).size });
    }
  };
  await walk(ctx.dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { result: JSON.stringify(files) };
}

export async function readText(ctx: OpContext, args: OpArgs<"fs.read">): Promise<OpResult> {
  const path = await inside(ctx.dir, args.path);
  const text = await readFile(path, "utf8");
  return { result: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(cut)` : text };
}

/** A whole file, bytes as they are, for a download the user asked for. */
export async function fetchFile(ctx: OpContext, args: OpArgs<"fs.fetch">): Promise<OpResult> {
  const path = await inside(ctx.dir, args.path);
  const info = await stat(path);
  if (!info.isFile()) throw new PathError(`${args.path} is not a file`);
  if (info.size > MAX_FETCH_BYTES) throw new PathError(`${args.path} is larger than ${Math.floor(MAX_FETCH_BYTES / 1024 / 1024)} MB`);
  const bytes = await readFile(path);
  await ctx.upload(bytes);
  return { result: JSON.stringify({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) };
}

/** A file the user attached, pulled from the backend; written only if it arrived whole. */
export async function receiveFile(ctx: OpContext, args: OpArgs<"fs.receive">): Promise<OpResult> {
  const path = await inside(ctx.dir, args.path);
  const bytes = await ctx.download();
  if (bytes.length !== args.bytes || createHash("sha256").update(bytes).digest("hex") !== args.sha256) {
    throw new PathError(`${args.path} did not arrive whole`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o770 });
  // Group-readable and writable: the runner works on it like on the agent's own files.
  // Not reported as an artifact: it is the user's file, not the agent's work.
  await writeFile(path, bytes, { mode: 0o660 });
  return { result: `Copied the user's file to ${args.path} (${bytes.length} bytes).` };
}
