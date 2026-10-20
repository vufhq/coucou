// Old task folders go, so the VM's disk does not fill up over months. The
// backend sets how long finished tasks are kept; a folder goes one day after
// that, counted from the last change to anything in it, so a task the backend
// still lists never loses its files first. Symlinks are never followed.

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The latest change to the folder or anything below it. */
async function lastChange(dir: string): Promise<number> {
  let latest = (await lstat(dir)).mtimeMs;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? await lastChange(full) : (await lstat(full)).mtimeMs);
  }
  return latest;
}

/** Removes task folders unchanged for `retentionDays` + 1 days. Returns the ids removed. */
export async function pruneTaskDirs(workspace: string, retentionDays: number, at = Date.now()): Promise<string[]> {
  if (retentionDays <= 0) return [];
  const root = join(workspace, "tasks");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!TASK_ID.test(name)) continue;
    const dir = join(root, name);
    try {
      if (!(await lstat(dir)).isDirectory()) continue;
      if (at - (await lastChange(dir)) < (retentionDays + 1) * DAY_MS) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Changed or gone while we looked: leave it for the next sweep.
    }
  }
  return removed;
}
