// The one door into the event log. Every event is checked against its type's
// schema, redacted, stored with its sequence numbers, and only then handed to
// live subscribers (the SSE streams). A subscriber that falls behind or
// reconnects reads the same rows back from the store, so live and replayed
// events are identical.

import { EventEmitter } from "node:events";
import { EVENT_PAYLOADS, EVENT_VERSION, type AgentEvent, type EventPayload, type EventType } from "@coucou-orchestrator/protocol";
import { redact } from "./redact.ts";
import type { EventRow, Store } from "./store.ts";

export function toWire(row: EventRow): AgentEvent {
  return {
    v: EVENT_VERSION,
    id: row.id,
    seq: row.seq,
    taskId: row.taskId,
    agentId: row.agentId,
    sequence: row.sequence,
    type: row.type as EventType,
    timestamp: row.timestamp,
    payload: row.payload,
  };
}

export class EventLog {
  private readonly emitter = new EventEmitter();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    // One listener per open SSE stream; Coucou plus a few tabs at most.
    this.emitter.setMaxListeners(100);
  }

  emit<T extends EventType>(type: T, agentId: string, taskId: string | null, payload: EventPayload<T>): AgentEvent {
    const clean = EVENT_PAYLOADS[type].parse(redact(payload)) as Record<string, unknown>;
    const event = toWire(this.store.appendEvent({ taskId, agentId, type, payload: clean }));
    this.emitter.emit("event", event);
    return event;
  }

  after(seq: number, filter: { taskId?: string; limit?: number } = {}): AgentEvent[] {
    return this.store.eventsAfter(seq, filter).map(toWire);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
