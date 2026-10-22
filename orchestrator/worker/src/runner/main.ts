// coucou-runner, as systemd starts it inside the agents' computer: socket
// activation hands it the listening socket as fd 3 (coucou-runner.socket).
// Without systemd, ORCH_RUNNER_SOCKET names a path to listen on.
//   ORCH_COMPUTER        /computer

import { createRunner } from "./server.ts";

const root = process.env.ORCH_COMPUTER ?? "/computer";
const runner = createRunner({ root });

if (process.env.LISTEN_FDS === "1") {
  runner.listen({ fd: 3 });
} else {
  runner.listen(process.env.ORCH_RUNNER_SOCKET ?? "/run/coucou-runner.sock");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => runner.close(() => process.exit(0)));
}

console.log(`coucou-runner: running commands in ${root}`);
