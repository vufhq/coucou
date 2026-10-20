// Where the backend listens and keeps its state. Everything has a default for
// the single-PC setup and can be overridden through the environment, which is
// also how the tests run it in a temporary folder.

import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { AgentId } from "@coucou-orchestrator/protocol";

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
  /** Finished tasks, their events and their folders in the VM go after this many days. 0 keeps everything. */
  retentionDays: number;
  /** The model profile used when a task names none. */
  defaultModelProfile: string;
  /** Agents the backend knows about, each with its own WSL distro of the same name. */
  agents: { id: string; name: string; vmId: string }[];
  /** How many agents may work at the same time; the others' tasks wait. */
  maxParallel: number;
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

/** `agent-02` → `Agent 02`. */
export function agentName(id: string): string {
  return id.replace(/^agent-/, "Agent ").replace(/^./, (c) => c.toUpperCase());
}

/** ORCH_AGENTS: a comma-separated list of agent ids, agent-01 when unset. */
export function parseAgents(raw: string | undefined): Config["agents"] {
  const ids = (raw ?? "agent-01").split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const agents: Config["agents"] = [];
  for (const id of ids) {
    const parsed = AgentId.safeParse(id);
    if (!parsed.success) throw new Error(`ORCH_AGENTS: ${JSON.stringify(id)} is not an agent id (a-z, 0-9 and -, up to 24)`);
    if (seen.has(id)) continue;
    seen.add(id);
    agents.push({ id, name: agentName(id), vmId: `wsl:${id}` });
  }
  if (agents.length === 0) throw new Error("ORCH_AGENTS names no agent");
  return agents;
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
    retentionDays: Math.max(0, int(env.ORCH_RETENTION_DAYS, 30)),
    defaultModelProfile: env.ORCH_MODEL_PROFILE ?? "claude-cli",
    agents: parseAgents(env.ORCH_AGENTS),
    maxParallel: Math.max(1, int(env.ORCH_MAX_PARALLEL, 2)),
  };
}
