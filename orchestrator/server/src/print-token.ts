// Prints an agent's worker token for provisioning (`npm run worker-token --
// agent-02`), so it can be piped straight into that agent's VM without ever
// being written to a file on Windows. Creates the token on first use.

import { AgentId } from "@coucou-orchestrator/protocol";
import { workerToken } from "./tokens.ts";

const agentId = AgentId.parse(process.argv[2] ?? "agent-01");
process.stdout.write(await workerToken(agentId));
