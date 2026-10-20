// Where the backend listens and keeps its state. Everything has a default for
// the single-PC setup and can be overridden through the environment, which is
// also how the tests run it in a temporary folder.

import { networkInterfaces } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  /** Coucou's API: loopback only. */
  apiHost: string;
  apiPort: number;
  /** The worker's listener, on the interface the VM can reach. */
  workerHost: string;
  workerPort: number;
  /** A claimed job is lost when no heartbeat renews it for this long. */
  leaseMs: number;
  /** How long a claim waits for a job before answering "nothing". */
  claimWaitMs: number;
  /** The model profile used when a task names none. */
  defaultModelProfile: string;
  /** Agents the backend knows about. Phase 1 has exactly one. */
  agents: { id: string; name: string; vmId: string }[];
}

/**
 * The Windows side of WSL's NAT network ("vEthernet (WSL…)"). That address is
 * what the distro sees as its default gateway, so the worker finds it without
 * configuration. Falls back to loopback, which only works in mirrored mode.
 */
export function wslHostAddress(): string {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/wsl/i.test(name)) continue;
    const v4 = addrs?.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  return "127.0.0.1";
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = env.LOCALAPPDATA ?? join(env.HOME ?? ".", ".local", "share");
  return {
    dataDir: env.ORCH_DATA_DIR ?? join(base, "CoucouOrchestrator"),
    apiHost: "127.0.0.1",
    apiPort: int(env.ORCH_API_PORT, 47620),
    workerHost: env.ORCH_WORKER_HOST ?? wslHostAddress(),
    workerPort: int(env.ORCH_WORKER_PORT, 47621),
    leaseMs: int(env.ORCH_LEASE_MS, 15_000),
    claimWaitMs: int(env.ORCH_CLAIM_WAIT_MS, 25_000),
    defaultModelProfile: env.ORCH_MODEL_PROFILE ?? "claude-cli",
    agents: [{ id: "agent-01", name: "Agent 01", vmId: "wsl:agent-01" }],
  };
}
