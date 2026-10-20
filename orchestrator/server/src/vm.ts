// The one thing the backend does to an agent's VM: keep it running. WSL stops
// a distro that has no process started from Windows, even with systemd
// services inside, so the backend holds one idle `sleep` open in it. A fixed
// command, no input from any task or model; it never creates, changes or
// deletes a VM.
//
// The `sleep` is left running when the backend stops, on purpose: a backend
// restart must not take the VM down with a job in flight. Each start adds at
// most one more idle process; `wsl --terminate agent-01` clears them all.

import { spawn } from "node:child_process";

export interface KeepAlive {
  stop(): void;
}

export function keepWslAlive(distro: string, log: (line: string) => void): KeepAlive {
  if (process.platform !== "win32" || !/^[A-Za-z0-9._-]{1,64}$/.test(distro)) return { stop() {} };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const start = () => {
    if (stopped) return;
    const child = spawn("wsl.exe", ["-d", distro, "--exec", "sleep", "infinity"], {
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    child.unref();
    child.on("error", (err) => log(`keep-alive for ${distro} could not start: ${err.message}`));
    child.on("exit", (code) => {
      if (stopped) return;
      log(`keep-alive for ${distro} ended (${code}); starting it again in 10 s`);
      timer = setTimeout(start, 10_000);
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
