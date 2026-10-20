// The orchestrator backend, as started by `npm start`. A separate process on
// purpose: closing Coucou must not stop a running task.

import { join } from "node:path";
import { createBackend } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ClaudeCliAdapter } from "./model/claude-cli.ts";
import { CLAUDE_CLI_PROFILE, ModelRouter } from "./model/router.ts";
import { loadTokens } from "./tokens.ts";
import { keepWslAlive } from "./vm.ts";

const config = loadConfig();
const tokens = await loadTokens();

const models = new ModelRouter();
models.register(
  { ...CLAUDE_CLI_PROFILE, model: process.env.ORCH_CLAUDE_MODEL ?? "default" },
  new ClaudeCliAdapter({ model: process.env.ORCH_CLAUDE_MODEL, workDir: join(config.dataDir, "model-sandbox") }),
);

const backend = createBackend(config, tokens, models);
const keepAlives = config.agents
  .filter((a) => a.vmId.startsWith("wsl:") && process.env.ORCH_KEEP_ALIVE !== "0")
  .map((a) => keepWslAlive(a.vmId.slice(4), (line) => console.log(`orchestrator: ${line}`)));
const { apiPort, workerPort } = await backend.listen();
console.log(`orchestrator: API on http://${config.apiHost}:${apiPort}, workers on http://${config.workerHost}:${workerPort}`);
console.log(`orchestrator: data in ${config.dataDir}`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log("orchestrator: stopping; running tasks resume on the next start");
    for (const k of keepAlives) k.stop();
    void backend.close().then(() => process.exit(0));
  });
}
