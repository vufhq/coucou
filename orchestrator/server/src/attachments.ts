// What the user hands an agent with a message: files dropped on HQ's composer
// and GitHub links. Files wait here, on the backend's disk, until the task
// starts; its first steps then copy each one into the task folder (fs.receive,
// which the model cannot call) and clone each repository. The bytes go once
// the task has ended.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  githubRepo,
  type CreateTaskRequest,
  type Operation,
} from "@coucou-orchestrator/protocol";
import type { StoredAttachment, Store, UploadRow } from "./store.ts";

/** An upload no message took is dropped after this long. */
const UNCLAIMED_FOR_MS = 24 * 60 * 60_000;

/** How long a clone may take. */
const CLONE_TIMEOUT_SEC = 300;

export class Uploads {
  private readonly store: Store;
  private readonly dir: string;

  constructor(store: Store, dir: string) {
    this.store = store;
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  save(name: string, bytes: Buffer): UploadRow {
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("too large");
    this.prune();
    const id = randomUUID();
    writeFileSync(join(this.dir, id), bytes);
    return this.store.addUpload({ id, name: cleanName(name), bytes: bytes.length, sha256: sha256(bytes) });
  }

  /** The bytes of an upload, or null once they are gone. */
  read(id: string): Buffer | null {
    if (!this.store.upload(id)) return null;
    try {
      return readFileSync(join(this.dir, id));
    } catch {
      return null;
    }
  }

  /** Uploads nobody will copy any more: never sent, or their task is over. */
  prune(): void {
    for (const id of this.store.disposableUploads(new Date(Date.now() - UNCLAIMED_FOR_MS))) this.remove(id);
  }

  forgetTask(taskId: string): void {
    for (const id of this.store.uploadsOfTask(taskId)) this.remove(id);
  }

  private remove(id: string): void {
    rmSync(join(this.dir, id), { force: true });
    this.store.deleteUpload(id);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file name as the user may see it: no folders, no control characters, not too long. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 120);
  return name || "file";
}

/**
 * A name the worker accepts (letters, digits, . _ -), keeping the extension:
 * `Rapport été (2).pdf` → `Rapport_ete_2.pdf`.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const ascii = base.normalize("NFKD").replace(/\p{M}/gu, "");
  const dot = ascii.lastIndexOf(".");
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const stem = clean(dot > 0 ? ascii.slice(0, dot) : ascii).slice(0, 80) || "file";
  const ext = dot > 0 ? clean(ascii.slice(dot + 1)).slice(0, 12) : "";
  return ext ? `${stem}.${ext}` : stem;
}

/** `name` or, when taken, `name-2`, `name-3`… (before the extension). */
function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export type AttachmentError = { error: string };

/**
 * What a new task gets copied before it starts, from the uploads and links in
 * its request. An upload must exist and not belong to another task yet.
 */
export function plannedAttachments(
  store: Store,
  req: Pick<CreateTaskRequest, "attachments" | "links">,
): StoredAttachment[] | AttachmentError {
  const items: StoredAttachment[] = [];
  const files = new Set<string>();
  for (const id of new Set(req.attachments ?? [])) {
    const upload = store.upload(id);
    if (!upload || upload.taskId) return { error: `unknown attachment ${id}` };
    const file = unique(safeFileName(upload.name), files);
    items.push({
      kind: "file",
      name: upload.name,
      path: `attachments/${file}`,
      bytes: upload.bytes,
      url: null,
      upload: upload.id,
      sha256: upload.sha256,
    });
  }
  const repos = new Set<string>();
  const folders = new Set<string>();
  for (const link of req.links ?? []) {
    const repo = githubRepo(link);
    if (!repo) return { error: `not a GitHub repository: ${link.slice(0, 80)}` };
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (repos.has(key)) continue;
    repos.add(key);
    items.push({
      kind: "repo",
      name: `${repo.owner}/${repo.repo}`,
      path: `repos/${unique(repo.repo, folders)}`,
      bytes: null,
      url: `https://github.com/${repo.owner}/${repo.repo}`,
    });
  }
  return items;
}

/** The step that brings one attachment into the task folder. */
export function attachmentStep(item: StoredAttachment): { note: string; op: Operation } {
  if (item.kind === "file") {
    return {
      note: `Copying ${item.name} into the task folder`,
      op: {
        op: "fs.receive",
        args: { path: item.path, upload: item.upload, bytes: item.bytes, sha256: item.sha256 },
      },
    };
  }
  // Owner, repository and folder are letters, digits, . _ - only (githubRepo), so the quotes hold.
  return {
    note: `Cloning ${item.name}`,
    op: {
      op: "terminal.shell",
      args: {
        command: `mkdir -p repos && GIT_TERMINAL_PROMPT=0 git clone --depth 1 --quiet -- '${item.url}.git' '${item.path}' && echo "Cloned ${item.url} into ${item.path}"`,
        timeoutSec: CLONE_TIMEOUT_SEC,
      },
    },
  };
}
