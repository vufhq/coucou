// The orchestrator backend, as started by `npm start`. A separate process on
// purpose: closing Coucou must not stop a running task.

import { join } from "node:path";
import { createBackend } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ClaudeCliAdapter } from "./model/claude-cli.ts";
import { CursorCliAdapter } from "./model/cursor-cli.ts";
import { OpenAICompatibleAdapter } from "./model/openai-compatible.ts";
import { CLAUDE_CLI_PROFILE, CURSOR_CLI_PROFILE, ModelRouter } from "./model/router.ts";
import { loadTokens } from "./tokens.ts";
import { keepWslAlive } from "./vm.ts";

const config = loadConfig();

/** ORCH_LOCAL_URL, kept only when it points at this machine: `local` means local. */
function loopbackUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`orchestrator: ORCH_LOCAL_URL is not a URL: ${raw}`);
    process.exit(1);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !(host === "localhost" || host === "::1" || /^127\./.test(host))) {
    console.error("orchestrator: ORCH_LOCAL_URL must be http://127.0.0.1, http://localhost or http://[::1]");
    process.exit(1);
  }
  return raw;
}
const tokens = await loadTokens();

// The subscriptions this machine has. Each falls back to the other only when
// it is rate-limited or unavailable (ORCH_MODEL_FALLBACK=0 turns that off).
const cursorInstall = process.env.ORCH_CURSOR_DIR ?? join(process.env.LOCALAPPDATA ?? "", "cursor-agent");
const hasCursor = CursorCliAdapter.available(cursorInstall);
// Codex (codex-cli.ts) is not registered yet: its read-only sandbox still lets
// the model run commands that read files, provider credentials included. It is
// wired in once it is locked down and passes the same canary probe as Cursor.
const localEndpoint = loopbackUrl(process.env.ORCH_LOCAL_URL);
const fallback = process.env.ORCH_MODEL_FALLBACK !== "0";

const models = new ModelRouter();
const fallbackIds = (ids: string[]) => (fallback ? ids : []);
models.register(
  { ...CLAUDE_CLI_PROFILE, model: process.env.ORCH_CLAUDE_MODEL ?? "default" },
  new ClaudeCliAdapter({ model: process.env.ORCH_CLAUDE_MODEL, workDir: join(config.dataDir, "model-sandbox") }),
  fallbackIds([
    ...(hasCursor ? [CURSOR_CLI_PROFILE.id] : []),
    ...(localEndpoint ? ["local"] : []),
  ]),
);
if (hasCursor) {
  models.register(
    { ...CURSOR_CLI_PROFILE, model: process.env.ORCH_CURSOR_MODEL ?? "default" },
    new CursorCliAdapter({
      installDir: cursorInstall,
      model: process.env.ORCH_CURSOR_MODEL,
      stateDir: process.env.ORCH_CURSOR_STATE_DIR ?? join(config.dataDir, "cursor"),
    }),
    fallbackIds([
      CLAUDE_CLI_PROFILE.id,
      ...(localEndpoint ? ["local"] : []),
    ]),
  );
}
if (localEndpoint) {
  models.register(
    { id: "local", provider: "openai-compatible", model: process.env.ORCH_LOCAL_MODEL ?? "local", endpoint: localEndpoint, capabilities: { streaming: false, toolCalling: false, structuredOutput: false } },
    new OpenAICompatibleAdapter({
      endpoint: localEndpoint,
      model: process.env.ORCH_LOCAL_MODEL ?? "local",
    }),
  );
}
if (!models.has(config.defaultModelProfile)) {
  console.error(`orchestrator: model profile ${config.defaultModelProfile} is not available; have ${models.list().map((p) => p.id).join(", ")}`);
  process.exit(1);
}

const backend = createBackend(config, tokens, models);
const keepAlives = config.agents
  .filter((a) => a.vmId.startsWith("wsl:") && process.env.ORCH_KEEP_ALIVE !== "0")
  .map((a) => keepWslAlive(a.vmId.slice(4), (line) => console.log(`orchestrator: ${line}`)));
const { apiPort, workerPort } = await backend.listen();
console.log(`orchestrator: API on http://${config.apiHost}:${apiPort}, workers on http://${config.workerHost}:${workerPort}`);
console.log(`orchestrator: data in ${config.dataDir}`);
console.log(
  `orchestrator: models ${models.list().map((p) => (p.fallbacks.length ? `${p.id} (then ${p.fallbacks.join(", ")})` : p.id)).join(", ")}; default ${config.defaultModelProfile}`,
);

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
