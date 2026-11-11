// Wires the backend together. `main.ts` runs it for real; the tests run the
// very same thing in a temporary folder with a scripted model.

import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApi } from "./api.ts";
import { Uploads } from "./attachments.ts";
import type { Config } from "./config.ts";
import { EventLog } from "./events.ts";
import { buildGateway } from "./gateway.ts";
import { Github, memorySlot } from "./github.ts";
import { Downloads, JobSignals } from "./jobs.ts";
import type { ModelRouter } from "./model/router.ts";
import { Runner } from "./runner.ts";
import { GoalScheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Tokens } from "./tokens.ts";
import { wslRunning, type VmProbe } from "./vm.ts";

const PRUNE_EVERY_MS = 6 * 60 * 60_000;

export interface Backend {
  store: Store;
  events: EventLog;
  runner: Runner;
  scheduler: GoalScheduler;
  github: Github;
  api: FastifyInstance;
  gateway: FastifyInstance;
  /** Starts listening and resumes in-flight tasks. Returns the bound ports. */
  listen(): Promise<{ apiPort: number; workerPort: number }>;
  close(): Promise<void>;
}

/** Finished tasks past the retention period go; 0 days keeps everything. */
function prune(store: Store, days: number): void {
  if (days <= 0) return;
  const removed = store.pruneBefore(new Date(Date.now() - days * 24 * 60 * 60_000));
  if (removed > 0) console.log(`orchestrator: removed ${removed} task(s) older than ${days} days`);
}

export function createBackend(
  config: Config,
  tokens: Tokens,
  models: ModelRouter,
  opts: {
    pollMs?: number;
    modelRetries?: number;
    transientRetryDelaysMs?: number[];
    schedulerPollMs?: number;
    /** Whether an agent's VM is running; the WSL check by default. */
    vmProbe?: VmProbe;
    /** The user's GitHub sign-in; kept in memory only by default. */
    github?: Github;
  } = {},
): Backend {
  const github = opts.github ?? new Github({ clientId: config.githubClientId, slot: memorySlot() });
  const store = new Store(join(config.dataDir, "orchestrator.db"));
  const firstComputer = config.agents[0];
  if (!firstComputer) throw new Error("at least one computer is required");
  // Any configured computer runs any agent; an agent whose own computer was
  // dropped from ORCH_AGENTS moves to the first.
  const moved = store.useComputers(config.agents);
  if (moved > 0) console.log(`orchestrator: moved ${moved} agent(s) to ${firstComputer.id}`);
  store.ensureChief({ ...firstComputer, modelProfileId: config.defaultModelProfile });
  const events = new EventLog(store);
  const signals = new JobSignals();
  const downloads = new Downloads();
  const uploads = new Uploads(store, join(config.dataDir, "uploads"));
  const runner = new Runner(store, events, models, {
    leaseMs: config.leaseMs,
    defaultModelProfile: config.defaultModelProfile,
    maxParallel: config.maxParallel,
    tasksPerComputer: config.tasksPerComputer,
    pollMs: opts.pollMs,
    modelRetries: opts.modelRetries,
    transientRetryDelaysMs: opts.transientRetryDelaysMs,
    uploads,
    github,
    riskyPerDay: config.riskyPerDay,
  });
  const scheduler = new GoalScheduler(store, events, runner, opts.schedulerPollMs);
  const api = buildApi({ store, events, runner, signals, downloads, uploads, models, github, token: tokens.api, vmProbe: opts.vmProbe ?? wslRunning });
  const gateway = buildGateway({
    store,
    events,
    runner,
    signals,
    downloads,
    uploads,
    github,
    tokens: tokens.workers,
    leaseMs: config.leaseMs,
    claimWaitMs: config.claimWaitMs,
    retentionDays: config.retentionDays,
  });

  let pruner: NodeJS.Timeout | null = null;

  return {
    store,
    events,
    runner,
    scheduler,
    github,
    api,
    gateway,
    async listen() {
      await api.listen({ host: config.apiHost, port: config.apiPort });
      await gateway.listen({ host: config.workerHost, port: config.workerPort });
      runner.start();
      scheduler.start();
      prune(store, config.retentionDays);
      uploads.prune();
      pruner = setInterval(() => {
        prune(store, config.retentionDays);
        uploads.prune();
      }, PRUNE_EVERY_MS);
      pruner.unref();
      const port = (s: FastifyInstance) => {
        const addr = s.server.address();
        return typeof addr === "object" && addr ? addr.port : 0;
      };
      return { apiPort: port(api), workerPort: port(gateway) };
    },
    async close() {
      if (pruner) clearInterval(pruner);
      scheduler.stop();
      await runner.stop();
      // Open event streams would otherwise keep the server alive.
      api.server.closeAllConnections?.();
      gateway.server.closeAllConnections?.();
      await Promise.allSettled([api.close(), gateway.close()]);
      store.close();
    },
  };
}
