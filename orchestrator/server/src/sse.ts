// Server-Sent Events with replay. A client says where it stopped (the
// `Last-Event-ID` header, or `?after=`), gets every stored event after that,
// then live ones, in order and without gaps or doubles: live events that
// arrive during the replay are held back and only sent if the replay did not
// already cover them.

import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@coucou-orchestrator/protocol";
import type { EventLog } from "./events.ts";

const KEEPALIVE_MS = 15_000;
const PAGE = 500;

function write(res: ServerResponse, event: AgentEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function streamEvents(
  res: ServerResponse,
  events: EventLog,
  opts: { after: number; taskId?: string; onClose?: () => void },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Clients reconnect after this long if the stream drops.
  res.write("retry: 2000\n\n");

  let last = opts.after;
  let replaying = true;
  const held: AgentEvent[] = [];
  const matches = (e: AgentEvent) => !opts.taskId || e.taskId === opts.taskId;

  const unsubscribe = events.subscribe((e) => {
    if (!matches(e)) return;
    if (replaying) {
      held.push(e);
      return;
    }
    if (e.seq > last) {
      write(res, e);
      last = e.seq;
    }
  });

  for (;;) {
    const page = events.after(last, { taskId: opts.taskId, limit: PAGE });
    for (const e of page) {
      write(res, e);
      last = e.seq;
    }
    if (page.length < PAGE) break;
  }
  replaying = false;
  for (const e of held) {
    if (e.seq > last) {
      write(res, e);
      last = e.seq;
    }
  }

  const ping = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_MS);
  res.on("close", () => {
    clearInterval(ping);
    unsubscribe();
    opts.onClose?.();
  });
}

/** Where a reconnecting client stopped: the header wins over the query. */
export function resumePoint(header: string | string[] | undefined, query: unknown): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const fromQuery = typeof query === "string" ? query : undefined;
  const n = Number.parseInt(raw ?? fromQuery ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
