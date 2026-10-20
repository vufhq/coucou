// Wires the backend together. `main.ts` runs it for real; the tests run the
// very same thing in a temporary folder with a scripted model.

import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApi } from "./api.ts";
import type { Config } from "./config.ts";
import { EventLog } from "./events.ts";
import { buildGateway } from "./gateway.ts";
import { JobSignals } from "./jobs.ts";
import type { ModelRouter } from "./model/router.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";
import type { Tokens } from "./tokens.ts";

export interface Backend {
  store: Store;
  events: EventLog;
  runner: Runner;
  api: FastifyInstance;
  gateway: FastifyInstance;
  /** Starts listening and resumes in-flight tasks. Returns the bound ports. */
  listen(): Promise<{ apiPort: number; workerPort: number }>;
  close(): Promise<void>;
}

export function createBackend(
  config: Config,
  tokens: Tokens,
  models: ModelRouter,
  opts: { pollMs?: number; modelRetries?: number } = {},
): Backend {
  const store = new Store(join(config.dataDir, "orchestrator.db"));
  for (const agent of config.agents) store.ensureAgent({ ...agent, modelProfileId: config.defaultModelProfile });
  const events = new EventLog(store);
  const signals = new JobSignals();
  const runner = new Runner(store, events, models, {
    leaseMs: config.leaseMs,
    defaultModelProfile: config.defaultModelProfile,
    ...opts,
  });
  const api = buildApi({ store, events, runner, signals, token: tokens.api });
  const gateway = buildGateway({
    store,
    events,
    runner,
    signals,
    token: tokens.worker,
    leaseMs: config.leaseMs,
    claimWaitMs: config.claimWaitMs,
  });

  return {
    store,
    events,
    runner,
    api,
    gateway,
    async listen() {
      await api.listen({ host: config.apiHost, port: config.apiPort });
      await gateway.listen({ host: config.workerHost, port: config.workerPort });
      runner.start();
      const port = (s: FastifyInstance) => {
        const addr = s.server.address();
        return typeof addr === "object" && addr ? addr.port : 0;
      };
      return { apiPort: port(api), workerPort: port(gateway) };
    },
    async close() {
      await runner.stop();
      // Open event streams would otherwise keep the server alive.
      api.server.closeAllConnections?.();
      gateway.server.closeAllConnections?.();
      await Promise.allSettled([api.close(), gateway.close()]);
      store.close();
    },
  };
}
