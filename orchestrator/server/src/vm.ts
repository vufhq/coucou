// The one thing the backend does to an agent's VM: keep it running. (It also
// asks the VM tool which VMs are running, to tell a stopped VM from a stuck
// worker.) A fixed command, no input from any task or model; it never creates,
// changes or deletes a VM.
//
// Two kinds of VM, told apart by the vmId prefix:
//   - `wsl:<distro>` on Windows: a WSL2 distro.
//   - `lima:<instance>` on a Mac: a Lima VM (Apple's Virtualization framework).
//
// WSL stops a distro that has no process started from Windows, even with
// systemd services inside, so the backend holds one idle `sleep` open in it.
// The `sleep` is left running when the backend stops, on purpose: a backend
// restart must not take the VM down with a job in flight. Each start adds at
// most one more idle process; `wsl --terminate agent-01` clears them all.
//
// wsl.exe is started through `cmd /c start /b`, never as a detached child: a
// detached console program has no console, so Windows 11 opens one for it in
// the default terminal, a window over whatever the user is doing (a game);
// closing it kills the sleep and the next start opened another one. Here cmd
// gets a console with no window, wsl.exe shares it, and as cmd's child it is
// outside the backend's job, so it outlives the backend.
//
// A Lima VM keeps running on its own once started; it only stops when the Mac
// restarts or someone runs `limactl stop`. Keeping it alive is `limactl start`
// when it is found stopped. Lima's host agent runs apart from the backend, so
// the VM outlives the backend too.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Whether an agent's VM is running: true, false, or null when it cannot tell. */
export type VmProbe = (vmId: string) => Promise<boolean | null>;

/** A WSL distro or Lima instance name: nothing a shell or a flag could read as more. */
const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `wsl:agent-01` → `{ kind: "wsl", name: "agent-01" }`; null for anything else. */
export function parseVmId(vmId: string): { kind: "wsl" | "lima"; name: string } | null {
  const m = /^(wsl|lima):(.+)$/.exec(vmId);
  if (!m || !VM_NAME.test(m[2]!)) return null;
  return { kind: m[1] as "wsl" | "lima", name: m[2]! };
}

/**
 * `wsl.exe --list --running --quiet`, read only. Only `wsl:<distro>` VMs are
 * known; anything else is null.
 */
export const wslRunning: VmProbe = (vmId) => {
  const distro = /^wsl:([A-Za-z0-9._-]{1,64})$/.exec(vmId)?.[1];
  if (process.platform !== "win32" || !distro) return Promise.resolve(null);
  return new Promise((resolve) => {
    // wsl.exe writes UTF-16; with no distro running it exits non-zero.
    const opts = { windowsHide: true, timeout: 10_000, encoding: "utf16le" as const };
    execFile("wsl.exe", ["--list", "--running", "--quiet"], opts, (err, stdout) => {
      const running = String(stdout ?? "").split(/\r?\n/).map((l) => l.replace(/^\uFEFF/, "").trim()).filter(Boolean);
      if (err) {
        resolve(running.length === 0 && !err.killed ? false : null);
        return;
      }
      resolve(running.includes(distro));
    });
  });
};

/**
 * Where limactl is: ORCH_LIMACTL, else Homebrew's (Apple silicon, then Intel),
 * else the PATH's. Coucou starts the backend from a Mac app, whose PATH has no
 * Homebrew folder.
 */
export function limactlPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.ORCH_LIMACTL) return env.ORCH_LIMACTL;
  for (const p of ["/opt/homebrew/bin/limactl", "/usr/local/bin/limactl"]) if (exists(p)) return p;
  return "limactl";
}

/**
 * Whether a Lima VM is running, from `limactl list --json <instance>` (read
 * only): one JSON object per line, `status` "Running", "Stopped" or "Broken".
 * Only `lima:<instance>` VMs are known; anything else is null.
 */
export const limaRunning: VmProbe = (vmId) => {
  const vm = parseVmId(vmId);
  if (process.platform !== "darwin" || vm?.kind !== "lima") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(limactlPath(), ["list", "--json", vm.name], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(limaStatus(String(stdout), vm.name));
    });
  });
};

/** `limactl list --json` output → running, stopped, or null when the instance is not listed. */
export function limaStatus(stdout: string, instance: string): boolean | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { name?: unknown; status?: unknown };
      if (row.name === instance) return row.status === "Running";
    } catch {
      // Not a JSON line (a warning): skip it.
    }
  }
  return null;
}

/** The probe for any vmId: WSL's or Lima's, by prefix. */
export const vmRunning: VmProbe = (vmId) => {
  const vm = parseVmId(vmId);
  if (vm?.kind === "wsl") return wslRunning(vmId);
  if (vm?.kind === "lima") return limaRunning(vmId);
  return Promise.resolve(null);
};

export interface KeepAlive {
  stop(): void;
}

/** Starts a stopped Lima VM. limactl waits for the boot; its host agent outlives the backend. */
export function startLimaVm(instance: string, log: (line: string) => void): void {
  const child = spawn(limactlPath(), ["start", "--tty=false", instance], { stdio: "ignore", detached: true });
  child.on("error", (err) => log(`keep-alive for ${instance} could not run limactl: ${err.message}`));
  child.unref();
}

/** Starts one idle `sleep` in the distro, with no window (see above). */
export function startWslSleep(distro: string, log: (line: string) => void): void {
  const child = spawn("cmd.exe", [`/d /c start "" /b wsl.exe -d ${distro} --exec sleep infinity`], {
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.on("error", (err) => log(`keep-alive for ${distro} could not start: ${err.message}`));
}

export const KEEP_ALIVE_CHECK_MS = 30_000;

/**
 * Starts the sleep, then checks every 30 s that the distro still runs and
 * starts another when it doesn't (the sleep was killed, or WSL shut down).
 */
export function keepWslAlive(
  distro: string,
  log: (line: string) => void,
  deps: { probe?: VmProbe; start?: typeof startWslSleep } = {},
): KeepAlive {
  return keepVmAlive(`wsl:${distro}`, log, deps);
}

/**
 * Keeps any VM up: WSL's sleep, or `limactl start` for a Lima VM. Starts it
 * at once (a running Lima VM ignores a second start; a WSL distro gets one more
 * idle sleep), then checks every 30 s.
 */
export function keepVmAlive(
  vmId: string,
  log: (line: string) => void,
  deps: { probe?: VmProbe; start?: (name: string, log: (line: string) => void) => void } = {},
): KeepAlive {
  const vm = parseVmId(vmId);
  if (!vm) return { stop() {} };
  const probe = deps.probe ?? (vm.kind === "wsl" ? wslRunning : limaRunning);
  const start = deps.start ?? (vm.kind === "wsl" ? startWslSleep : startLimaVm);
  const name = vm.name;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // A VM that is not there yet (listed in ORCH_AGENTS before it was
  // provisioned) never comes up: check less often each time, up to 5 min, and say it once.
  let delayMs = KEEP_ALIVE_CHECK_MS;
  let failing = false;

  const check = async () => {
    const running = await probe(vmId);
    if (stopped) return;
    if (running === false) {
      if (!failing) log(`keep-alive for ${name}: it is not running; starting it again`);
      else if (delayMs === KEEP_ALIVE_CHECK_MS) {
        log(`keep-alive for ${name} could not start it; is it provisioned? Trying again, less and less often`);
      }
      if (failing) delayMs = Math.min(delayMs * 2, 5 * 60_000);
      failing = true;
      start(name, log);
    } else if (running) {
      failing = false;
      delayMs = KEEP_ALIVE_CHECK_MS;
    }
    timer = setTimeout(() => void check(), delayMs);
  };
  start(name, log);
  timer = setTimeout(() => void check(), delayMs);

  return {
    stop() {
      // Stops watching; the VM itself stays (see above).
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
