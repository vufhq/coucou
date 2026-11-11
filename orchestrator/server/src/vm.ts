// The one thing the backend does to an agent's VM: keep it running. (It also
// asks WSL which distros are running, to tell a stopped VM from a stuck worker.) WSL stops
// a distro that has no process started from Windows, even with systemd
// services inside, so the backend holds one idle `sleep` open in it. A fixed
// command, no input from any task or model; it never creates, changes or
// deletes a VM.
//
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

import { execFile, spawn } from "node:child_process";

/** Whether an agent's VM is running: true, false, or null when it cannot tell. */
export type VmProbe = (vmId: string) => Promise<boolean | null>;

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

export interface KeepAlive {
  stop(): void;
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
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(distro)) return { stop() {} };
  const probe = deps.probe ?? wslRunning;
  const start = deps.start ?? startWslSleep;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // A distro that is not there yet (listed in ORCH_AGENTS before provision.ps1
  // ran) never comes up: check less often each time, up to 5 min, and say it once.
  let delayMs = KEEP_ALIVE_CHECK_MS;
  let failing = false;

  const check = async () => {
    const running = await probe(`wsl:${distro}`);
    if (stopped) return;
    if (running === false) {
      if (!failing) log(`keep-alive for ${distro}: it is not running; starting it again`);
      else if (delayMs === KEEP_ALIVE_CHECK_MS) {
        log(`keep-alive for ${distro} could not start it; is it provisioned? Trying again, less and less often`);
      }
      if (failing) delayMs = Math.min(delayMs * 2, 5 * 60_000);
      failing = true;
      start(distro, log);
    } else if (running) {
      failing = false;
      delayMs = KEEP_ALIVE_CHECK_MS;
    }
    timer = setTimeout(() => void check(), delayMs);
  };
  start(distro, log);
  timer = setTimeout(() => void check(), delayMs);

  return {
    stop() {
      // Stops watching; the process itself stays (see above).
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
