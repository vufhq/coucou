// The worker's memory of its jobs, on the VM's persistent disk. A job is
// written as "started" before it runs and "finished" (with its outcome) after,
// so whatever restarts — the worker, the VM, the backend — the backend can be
// told exactly which jobs never ran, which may have half-run, and which
// finished but were never reported.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JournalEntry, type JobOutcome } from "@coucou-orchestrator/protocol";

const KEEP_MS = 24 * 60 * 60_000;

export class Journal {
  private readonly dir: string;

  constructor(workspace: string) {
    this.dir = join(workspace, ".coucou", "journal");
  }

  private file(jobId: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(jobId)) throw new Error("invalid job id");
    return join(this.dir, `${jobId}.json`);
  }

  private async write(entry: JournalEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.file(entry.jobId);
    // Write then rename, so a crash never leaves half an entry.
    await writeFile(`${path}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  started(jobId: string): Promise<void> {
    return this.write({ jobId, state: "started" });
  }

  finished(jobId: string, outcome: JobOutcome): Promise<void> {
    return this.write({ jobId, state: "finished", outcome });
  }

  async has(jobId: string): Promise<JournalEntry | null> {
    try {
      return JournalEntry.parse(JSON.parse(await readFile(this.file(jobId), "utf8")));
    } catch {
      return null;
    }
  }

  /** Every entry still worth reporting; old finished ones are cleared away. */
  async entries(): Promise<JournalEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const path = join(this.dir, name);
      try {
        const entry = JournalEntry.parse(JSON.parse(await readFile(path, "utf8")));
        if (entry.state === "finished" && Date.now() - (await stat(path)).mtimeMs > KEEP_MS) {
          await rm(path, { force: true });
          continue;
        }
        out.push(entry);
      } catch {
        await rm(path, { force: true });
      }
    }
    return out.slice(-500);
  }
}
