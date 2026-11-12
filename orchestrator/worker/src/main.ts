// vufh-worker, as systemd starts it inside the agent's VM.
//
// Configuration comes from the environment (the unit's EnvironmentFile) and
// the token from systemd's credential store, which only this service reads:
//   ORCH_AGENT_ID      agent-01
//   ORCH_BACKEND_URL   optional; default http://<default gateway>:47621
//   ORCH_BACKEND_SOCKET  a remote computer: the socket the backend's SSH connection opens
//   ORCH_WORKSPACE     /workspace
//   ORCH_COMPUTER      /computer, shared with vufh-runner (task folders, the agents' own folders)
//   ORCH_RUNNER_SOCKET /run/vufh-runner.sock
//   $CREDENTIALS_DIRECTORY/worker-token   (or ORCH_WORKER_TOKEN, for development)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BackendClient } from "./client.ts";
import { Journal } from "./journal.ts";
import { playwrightDriver } from "./ops/browser.ts";
import { socketShell } from "./ops/shell.ts";
import { Worker } from "./worker.ts";

/** The default gateway is the Windows host in WSL's NAT mode. */
async function defaultGateway(): Promise<string> {
  const table = await readFile("/proc/net/route", "utf8");
  for (const line of table.split("\n").slice(1)) {
    const [, dest, gateway] = line.trim().split(/\s+/);
    if (dest === "00000000" && gateway) {
      const n = Number.parseInt(gateway, 16);
      return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255].join(".");
    }
  }
  return "127.0.0.1";
}

async function token(): Promise<string> {
  if (process.env.ORCH_WORKER_TOKEN) return process.env.ORCH_WORKER_TOKEN;
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) throw new Error("no worker token: CREDENTIALS_DIRECTORY is not set");
  return (await readFile(join(dir, "worker-token"), "utf8")).trim();
}

const workspace = process.env.ORCH_WORKSPACE ?? "/workspace";
// A remote computer has no gateway that is the PC: the backend comes to it.
const socket = process.env.ORCH_BACKEND_SOCKET || undefined;
const base = socket ? "http://backend" : (process.env.ORCH_BACKEND_URL ?? `http://${await defaultGateway()}:47621`);
const agentId = process.env.ORCH_AGENT_ID ?? "agent-01";
const browser = playwrightDriver((line) => console.log(`vufh-worker: ${line}`));

const worker = new Worker({
  client: new BackendClient(base, await token(), agentId, socket),
  journal: new Journal(workspace),
  browser,
  workspace,
  computer: process.env.ORCH_COMPUTER ?? workspace,
  shell: socketShell(process.env.ORCH_RUNNER_SOCKET ?? "/run/vufh-runner.sock"),
  log: (line) => console.log(`vufh-worker: ${line}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    void browser.close().finally(() => process.exit(0));
  });
}

console.log(`vufh-worker: ${agentId}, backend ${socket ?? base}, workspace ${workspace}`);
await worker.run();
