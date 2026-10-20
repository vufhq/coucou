// Prints the worker's token for provisioning (`npm run worker-token`), so it
// can be piped straight into the VM without ever being written to a file on
// Windows. Creates the token on first use, like the backend does.

import { loadTokens } from "./tokens.ts";

const tokens = await loadTokens();
process.stdout.write(tokens.worker);
