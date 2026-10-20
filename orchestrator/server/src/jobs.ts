// Jobs the backend itself sends the worker (a file listing for Coucou), and
// waiting for a job's end. Task steps never go through here: the runner owns
// those.

import { EventEmitter } from "node:events";
import type { JobOutcome, OpName } from "@coucou-orchestrator/protocol";
import type { Store } from "./store.ts";

export class JobSignals {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  finished(jobId: string): void {
    this.emitter.emit(jobId);
  }

  /** Resolves with the job's outcome, or null if it did not end in time. */
  wait(store: Store, jobId: string, timeoutMs: number): Promise<JobOutcome | null> {
    const now = store.job(jobId)?.outcome;
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.emitter.off(jobId, done);
        resolve(store.job(jobId)?.outcome ?? null);
      };
      const timer = setTimeout(done, timeoutMs);
      this.emitter.on(jobId, done);
    });
  }
}

export async function runBackendJob(
  store: Store,
  signals: JobSignals,
  job: { taskId: string; agentId: string; op: OpName; args: Record<string, unknown> },
  timeoutMs: number,
): Promise<JobOutcome | null> {
  const row = store.createJob({ ...job, deadlineMs: timeoutMs });
  const outcome = await signals.wait(store, row.id, timeoutMs);
  if (!outcome) {
    // Nobody picked it up (worker offline) or it ran too long: withdraw it.
    store.requestJobCancel(row.id);
    store.finishJob(row.id, { status: "cancelled", error: { code: "timeout", message: "no answer from the worker" } });
  }
  return outcome;
}
