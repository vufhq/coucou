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

export function keepWslAlive(distro: string, log: (line: string) => void): KeepAlive {
  if (process.platform !== "win32" || !/^[A-Za-z0-9._-]{1,64}$/.test(distro)) return { stop() {} };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // A distro that is not there yet (listed in ORCH_AGENTS before provision.ps1
  // ran) fails at once: wait longer each time, up to 5 min, and say it once.
  let delayMs = 10_000;

  const start = () => {
    if (stopped) return;
    const startedAt = Date.now();
    const child = spawn("wsl.exe", ["-d", distro, "--exec", "sleep", "infinity"], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    child.unref();
    child.on("error", (err) => log(`keep-alive for ${distro} could not start: ${err.message}`));
    child.on("exit", (code) => {
      if (stopped) return;
      const quick = Date.now() - startedAt < 5_000;
      if (!quick) delayMs = 10_000;
      if (delayMs === 10_000) {
        log(
          quick
            ? `keep-alive for ${distro} could not start it (${code}); is it provisioned? Trying again, less and less often`
            : `keep-alive for ${distro} ended (${code}); starting it again in 10 s`,
        );
      }
      timer = setTimeout(start, delayMs);
      if (quick) delayMs = Math.min(delayMs * 2, 5 * 60_000);
    });
  };
  start();

  return {
    stop() {
      // Stops watching; the process itself stays (see above).
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
