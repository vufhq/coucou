// The backend's connection to a computer that is not on this PC (a rented
// machine, provision.ps1 -RemoteHost). The worker always calls the backend,
// never the other way round, and a machine on the internet cannot call a PC
// behind a router: so the backend opens one SSH connection out to it and
// keeps it open, and the worker's calls come back through it.
//
// On the far side the connection ends in a socket, /workspace/.coucou/
// backend.sock, in the worker's own folder: nothing listens on a port there,
// and what the agents run (the runner, another user) cannot enter that folder.
// The login is `agent`, which that machine's SSH server gives no shell and
// no command, only that forward (setup.sh, "The backend's way in"). The backend runs no
// command there and never creates, changes or deletes a machine.
//
// ssh.exe is Windows' own; the key is the user's (their agent, their
// ~/.ssh/config, or ORCH_SSH_KEY). The machine's key must already be in
// known_hosts, where provision.ps1's first connection put it: a machine that
// answers with another key is refused.

import { spawn, type ChildProcess } from "node:child_process";

export interface Remote {
  host: string;
  port: number;
}

/** The login setup.sh allows to open the socket, and where the worker looks for it. */
export const TUNNEL_USER = "agent";
export const TUNNEL_SOCKET = "/workspace/.coucou/backend.sock";

/** `ssh:203.0.113.7:22`, a remote computer's vmId. */
export function remoteVmId(remote: Remote): string {
  return `ssh:${remote.host}:${remote.port}`;
}

export function isRemoteVm(vmId: string): boolean {
  return vmId.startsWith("ssh:");
}

/** ssh's arguments: no command, no terminal, never a prompt, one forward. */
export function tunnelArgs(remote: Remote, target: { host: string; port: number }, keyFile?: string): string[] {
  return [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
    ...(keyFile ? ["-i", keyFile, "-o", "IdentitiesOnly=yes"] : []),
    "-p", String(remote.port),
    "-R", `${TUNNEL_SOCKET}:${target.host}:${target.port}`,
    `${TUNNEL_USER}@${remote.host}`,
  ];
}

export interface Tunnel {
  /** Whether ssh has stayed connected long enough to believe the socket is there. */
  up(): boolean;
  stop(): void;
}

export const TUNNEL_RETRY_MS = 3_000;
const TUNNEL_RETRY_MAX_MS = 60_000;
/** ssh says nothing when the forward is ready; it exits when it is not. */
const TUNNEL_SETTLE_MS = 20_000;

type Spawn = (args: string[]) => ChildProcess;

const sshSpawn: Spawn = (args) =>
  spawn(process.platform === "win32" ? "ssh.exe" : "ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

/**
 * Opens the connection and opens it again whenever it drops: after 3 s, then
 * less and less often up to a minute while it keeps failing. The reason ssh
 * gave is logged when it changes, not at every try. It stops with the backend
 * (the worker then waits, as a WSL one does while the backend is down).
 */
export function keepTunnel(
  name: string,
  remote: Remote,
  target: { host: string; port: number },
  log: (line: string) => void,
  deps: { spawn?: Spawn; keyFile?: string } = {},
): Tunnel {
  const start = deps.spawn ?? sshSpawn;
  const args = tunnelArgs(remote, target, deps.keyFile);
  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  let delayMs = TUNNEL_RETRY_MS;
  let lastReason = "";

  const again = (reason: string) => {
    child = null;
    if (stopped) return;
    // A connection that held is a new story: say why it ended, try again soon.
    if (Date.now() - startedAt >= TUNNEL_SETTLE_MS) {
      delayMs = TUNNEL_RETRY_MS;
      lastReason = "";
    }
    if (reason !== lastReason) log(`connection to ${name} (${remote.host}) ended: ${reason}; trying again`);
    lastReason = reason;
    timer = setTimeout(open, delayMs);
    delayMs = Math.min(delayMs * 2, TUNNEL_RETRY_MAX_MS);
  };

  function open() {
    timer = null;
    if (stopped) return;
    startedAt = Date.now();
    let said = "";
    let ended = false;
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      again(reason);
    };
    const started = start(args);
    child = started;
    started.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      said = (said + chunk).slice(-2_000);
    });
    started.on("error", (err) => end(`ssh could not start: ${err.message}`));
    started.on("exit", (code) => {
      const last = said.trim().split(/\r?\n/).pop()?.trim();
      end(last || `ssh exited (${code ?? "killed"})`);
    });
  }
  open();

  return {
    up: () => child !== null && Date.now() - startedAt >= TUNNEL_SETTLE_MS,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill();
    },
  };
}
