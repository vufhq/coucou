// The workers' door on WSL's network. A WSL computer calls the backend at its
// default gateway: the Windows side of WSL's NAT adapter, which exists only
// while WSL runs and takes a new address when WSL restarts. So the address
// cannot be read once at start (the backend often starts first, at login):
// this keeps a second listener for the gateway on that address, opens it when
// the adapter appears and moves it when the address changes. The gateway's own
// listener stays on loopback, where remote computers' connections come in.
//
// It listens on that one address only, never on every interface.

import { createServer, type RequestListener, type Server } from "node:http";

export interface WslDoor {
  /** The address it is listening on now, if any. */
  address(): string | null;
  close(): Promise<void>;
}

export function keepWslDoor(opts: {
  port: number;
  /** The gateway's own request handler. */
  handler: RequestListener;
  /** The adapter's address now, or null while WSL has none. */
  addressOf: () => string | null;
  log: (line: string) => void;
  pollMs?: number;
}): WslDoor {
  let open: { address: string; server: Server } | null = null;
  let lastProblem = "";

  const shut = (server: Server) =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });

  const check = () => {
    const want = opts.addressOf();
    if (want === (open?.address ?? null)) return;
    if (open) {
      opts.log(`workers no longer on http://${open.address}:${opts.port}`);
      void shut(open.server);
      open = null;
    }
    if (!want) return;
    const server = createServer(opts.handler);
    const mine = { address: want, server };
    // An address that is not ready yet, or a port in use: tried again at the next check.
    server.on("error", (err) => {
      if (open === mine) open = null;
      const problem = `cannot listen for workers on ${want}:${opts.port}: ${err.message}`;
      if (problem !== lastProblem) opts.log(problem);
      lastProblem = problem;
    });
    server.listen(opts.port, want, () => {
      lastProblem = "";
      opts.log(`workers also on http://${want}:${opts.port}`);
    });
    open = mine;
  };

  check();
  const timer = setInterval(check, opts.pollMs ?? 5_000);
  timer.unref();

  return {
    address: () => (open?.server.listening ? open.address : null),
    async close() {
      clearInterval(timer);
      const was = open;
      open = null;
      if (was) await shut(was.server);
    },
  };
}
