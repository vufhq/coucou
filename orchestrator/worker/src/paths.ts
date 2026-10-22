// Every file operation lands inside its task's folder and nowhere else. The
// protocol's RelPath already refuses `..` and absolute paths; this resolves
// the result for real and refuses symlinks, so a link planted in the folder
// cannot lead out of it.

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PathError extends Error {}

export function taskDir(workspace: string, taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new PathError("invalid task id");
  return join(workspace, "tasks", taskId);
}

export async function ensureTaskDir(workspace: string, taskId: string): Promise<string> {
  const dir = taskDir(workspace, taskId);
  // Group-writable: the runner (group `computer`) works in it too.
  await mkdir(dir, { recursive: true, mode: 0o770 });
  return realpath(dir);
}

/**
 * The absolute path of `rel` inside `root` (which must already be real).
 * Every existing segment is checked: none may be a symlink.
 */
export async function inside(root: string, rel: string): Promise<string> {
  const target = resolve(root, rel);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || fromRoot.includes(`..${sep}`) || resolve(root, fromRoot) !== target) {
    throw new PathError("path leaves the task folder");
  }
  let current = root;
  for (const segment of fromRoot.split(sep)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new PathError("symlinks are not followed");
    } catch (err) {
      if (err instanceof PathError) throw err;
      break; // Does not exist yet: nothing further to check.
    }
  }
  return target;
}
