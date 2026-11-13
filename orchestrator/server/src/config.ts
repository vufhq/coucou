// Where the backend listens and keeps its state. Everything has a default for
// the single-PC setup and can be overridden through the environment, which is
// also how the tests run it in a temporary folder.

import { existsSync, renameSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { AgentId } from "@vufh-orchestrator/protocol";
import { remoteVmId, type Remote } from "./tunnel.ts";

export interface Config {
  dataDir: string;
  /** vufh's API: loopback only. */
  apiHost: string;
  apiPort: number;
  /** The worker's listener: loopback, or ORCH_WORKER_HOST. */
  workerHost: string;
  workerPort: number;
  /**
   * Also listen for workers on WSL's adapter, whenever it has an address
   * (wsl-door.ts). Off when ORCH_WORKER_HOST says where to listen.
   */
  followWsl?: boolean;
  /** A claimed job is lost when no heartbeat renews it for this long. */
  leaseMs: number;
  /** How long a claim waits for a job before answering "nothing". */
  claimWaitMs: number;
  /** Finished tasks, their events and their folders in the VM go after this many days. 0 keeps everything. */
  retentionDays: number;
  /** The model profile used when a task names none. */
  defaultModelProfile: string;
  /**
   * Provisioned computers: a WSL distro of the same name, or, with `remote`, a
   * machine elsewhere that the backend reaches over SSH (tunnel.ts).
   */
  agents: { id: string; name: string; vmId: string; remote?: Remote }[];
  /** ORCH_SSH_KEY: the private key for remote computers, when ssh would not find it by itself. */
  sshKeyFile?: string;
  /** How many tasks may be worked on at the same time, all computers together; the others wait. */
  maxParallel: number;
  /** How many tasks one computer works on at once. */
  tasksPerComputer: number;
  /** The user's own GitHub App (device flow); public, no secret. GitHub is off without it. */
  githubClientId?: string;
  /** Risky actions (pushes) a level-3 agent makes a day before it asks again. */
  riskyPerDay: number;
}

/**
 * The Windows side of WSL's NAT network ("vEthernet (WSL…)"), or null while
 * WSL has no adapter (it is not running yet). That address is what the distro
 * sees as its default gateway, so the worker finds it without configuration.
 * It changes when WSL restarts: read it again, never once (wsl-door.ts).
 */
export function wslHostAddress(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/wsl/i.test(name)) continue;
    const v4 = addrs?.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** `agent-02` → `Agent 02`. */
export function agentName(id: string): string {
  return id.replace(/^agent-/, "Agent ").replace(/^./, (c) => c.toUpperCase());
}

/** A host name or an IPv4 address: it ends up on ssh's command line, so nothing else. */
const REMOTE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/**
 * ORCH_AGENTS: a comma-separated list of agent ids, agent-01 when unset.
 * `agent-03@203.0.113.7` (or `@host:2222`) is a computer elsewhere, made by
 * `provision.ps1 -RemoteHost`.
 */
export function parseAgents(raw: string | undefined): Config["agents"] {
  const entries = (raw ?? "agent-01").split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const agents: Config["agents"] = [];
  for (const entry of entries) {
    const at = entry.indexOf("@");
    const id = at < 0 ? entry : entry.slice(0, at);
    const parsed = AgentId.safeParse(id);
    if (!parsed.success) throw new Error(`ORCH_AGENTS: ${JSON.stringify(id)} is not an agent id (a-z, 0-9 and -, up to 24)`);
    let remote: Remote | undefined;
    if (at >= 0) {
      const [host = "", port = "22", ...rest] = entry.slice(at + 1).split(":");
      const n = /^[0-9]{1,5}$/.test(port) ? Number(port) : 0;
      if (rest.length > 0 || !REMOTE_HOST.test(host) || n < 1 || n > 65_535) {
        throw new Error(`ORCH_AGENTS: ${JSON.stringify(entry)} is not agent@host or agent@host:port (a host name or an IPv4 address)`);
      }
      remote = { host, port: n };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    agents.push(remote
      ? { id, name: agentName(id), vmId: remoteVmId(remote), remote }
      : { id, name: agentName(id), vmId: `wsl:${id}` });
  }
  if (agents.length === 0) throw new Error("ORCH_AGENTS names no agent");
  return agents;
}

const DATA_DIR = "VufhOrchestrator";
/** The data folder's name before the app was renamed. */
const LEGACY_DATA_DIR = "CoucouOrchestrator";

function dataBase(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA ?? join(env.HOME ?? ".", ".local", "share");
}

/**
 * Renames the data folder from before the rename, once, as the backend starts
 * (main.ts). One still in use stays where it is, and loadConfig uses it there.
 */
export function adoptLegacyDataDir(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ORCH_DATA_DIR) return;
  const dir = join(dataBase(env), DATA_DIR);
  const legacy = join(dataBase(env), LEGACY_DATA_DIR);
  if (existsSync(dir) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, dir);
  } catch {
    // Another backend holds it open.
  }
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const dir = join(dataBase(env), DATA_DIR);
  const legacy = join(dataBase(env), LEGACY_DATA_DIR);
  return !existsSync(dir) && existsSync(legacy) ? legacy : dir;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const agents = parseAgents(env.ORCH_AGENTS);
  // A worker runs up to 4 operations at once (WORKER_SLOTS), whatever this says.
  const tasksPerComputer = Math.max(1, int(env.ORCH_TASKS_PER_COMPUTER, 2));
  return {
    dataDir: env.ORCH_DATA_DIR ?? defaultDataDir(env),
    apiHost: "127.0.0.1",
    apiPort: int(env.ORCH_API_PORT, 47620),
    workerHost: env.ORCH_WORKER_HOST ?? "127.0.0.1",
    followWsl: env.ORCH_WORKER_HOST === undefined,
    workerPort: int(env.ORCH_WORKER_PORT, 47621),
    leaseMs: int(env.ORCH_LEASE_MS, 15_000),
    claimWaitMs: int(env.ORCH_CLAIM_WAIT_MS, 25_000),
    retentionDays: Math.max(0, int(env.ORCH_RETENTION_DAYS, 30)),
    defaultModelProfile: env.ORCH_MODEL_PROFILE ?? "claude-cli",
    agents,
    // Unset: every computer full.
    maxParallel: Math.max(1, int(env.ORCH_MAX_PARALLEL, agents.length * tasksPerComputer)),
    tasksPerComputer,
    githubClientId: env.ORCH_GITHUB_CLIENT_ID?.trim() || undefined,
    sshKeyFile: env.ORCH_SSH_KEY?.trim() || undefined,
    riskyPerDay: Math.max(0, int(env.ORCH_RISKY_PER_DAY, 10)),
  };
}
