// The worker's side door: its own listener, a token per agent, and only the
// handful of calls in the worker protocol. A worker can claim jobs, report
// what they did and say it is alive. It cannot create tasks, approve
// anything or touch another agent's jobs: which agent is calling comes from
// its token, and an agent id in a request must match it.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { z } from "zod";
import {
  ClaimRequest,
  EVENT_PAYLOADS,
  Heartbeat,
  Hello,
  JobOutcome,
  MAX_FETCH_BYTES,
  READ_ONLY_OPS,
  WorkerEvents,
  type ClaimResponse,
} from "@coucou-orchestrator/protocol";
import type { EventLog } from "./events.ts";
import type { Downloads, JobSignals } from "./jobs.ts";
import { redact } from "./redact.ts";
import type { Runner } from "./runner.ts";
import type { JobRow, Store } from "./store.ts";
import { agentForBearer } from "./tokens.ts";

export interface GatewayDeps {
  store: Store;
  events: EventLog;
  runner: Runner;
  signals: JobSignals;
  downloads: Downloads;
  /** Agent id → its worker token. */
  tokens: ReadonlyMap<string, string>;
  leaseMs: number;
  claimWaitMs: number;
  retentionDays: number;
}

function bad(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid", message: error.issues.map((i) => i.message).join("; ") });
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const { store, events, runner, signals } = deps;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  // Download bytes, on their one route; everything else is JSON.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FETCH_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  const callers = new WeakMap<object, string>();
  app.addHook("onRequest", async (req, reply) => {
    const agentId = agentForBearer(req.headers.authorization, deps.tokens);
    if (!agentId) return reply.code(401).send({ error: "unauthorized" });
    callers.set(req.raw, agentId);
  });
  /** The agent the token belongs to. */
  const caller = (req: { raw: object }): string => callers.get(req.raw)!;
  /** A request naming another agent than its token's. */
  const impostor = (req: { raw: object }, reply: FastifyReply, agentId: string) =>
    agentId !== caller(req) ? reply.code(403).send({ error: "wrong_agent" }) : null;

  const setStatus = (agentId: string, status: "ready" | "busy") => {
    if (store.setAgentStatus(agentId, status)) events.emit("agent.status_changed", agentId, null, { status });
  };

  /** A job this agent holds right now, or null. */
  const heldJob = (agentId: string, jobId: string): JobRow | null => {
    const job = store.job(jobId);
    return job && job.agentId === agentId && job.status === "claimed" ? job : null;
  };

  const finish = (job: JobRow, outcome: JobOutcome) => {
    if (store.finishJob(job.id, redact(outcome))) {
      signals.finished(job.id);
      runner.jobFinished(job.taskId);
    }
  };

  app.post("/worker/v1/hello", async (req, reply) => {
    const hello = Hello.safeParse(req.body);
    if (!hello.success) return bad(reply, hello.error);
    const { agentId, journal, health } = hello.data;
    if (impostor(req, reply, agentId)) return reply;
    if (!store.agent(agentId)) return reply.code(404).send({ error: "unknown_agent" });
    store.touchAgent(agentId);
    if (health) store.setAgentHealth(agentId, health);

    // Reconcile what the worker remembers with what we remember.
    const known = new Map(journal.map((j) => [j.jobId, j]));
    for (const entry of journal) {
      const job = heldJob(agentId, entry.jobId);
      if (!job) continue;
      if (entry.state === "finished" && entry.outcome) finish(job, entry.outcome);
    }
    const claimed = store.db
      .prepare("SELECT id FROM jobs WHERE agent_id = ? AND status = 'claimed'")
      .all(agentId) as { id: string }[];
    for (const { id } of claimed) {
      const job = heldJob(agentId, id);
      if (!job) continue;
      const entry = known.get(id);
      if (!entry) {
        // Claimed but never started: the worker died before touching it.
        store.requeueJob(id);
      } else if (entry.state === "started") {
        // Started and then the worker restarted: it may have half-run.
        if (READ_ONLY_OPS.has(job.op) && job.attempts < 2) store.requeueJob(id);
        else finish(job, { status: "failed", error: { code: "interrupted", message: "the worker restarted during this operation" } });
      }
    }
    setStatus(agentId, "ready");
    runner.pump(agentId);
    return { ok: true, leaseMs: deps.leaseMs, retentionDays: deps.retentionDays };
  });

  app.post("/worker/v1/jobs/claim", async (req, reply): Promise<ClaimResponse | FastifyReply> => {
    const body = ClaimRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const { agentId, health } = body.data;
    if (impostor(req, reply, agentId)) return reply;
    if (!store.agent(agentId)) return reply.code(404).send({ error: "unknown_agent" });
    if (health) store.setAgentHealth(agentId, health);
    const until = Date.now() + deps.claimWaitMs;
    // The response's close (not the request's, which fires once the body is
    // read) tells us the worker hung up while we were waiting.
    let closed = false;
    reply.raw.on("close", () => {
      closed = true;
    });
    for (;;) {
      store.touchAgent(agentId);
      const cancel = store.cancelRequestedJobs(agentId);
      if (closed) return { job: null, cancel };
      const job = store.claimJob(agentId, deps.leaseMs);
      if (job) {
        setStatus(agentId, "busy");
        return { job: { id: job.id, taskId: job.taskId, op: job.op, args: job.args, deadlineMs: job.deadlineMs }, cancel };
      }
      setStatus(agentId, "ready");
      if (cancel.length > 0 || closed || Date.now() >= until) return { job: null, cancel };
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  app.post("/worker/v1/heartbeat", async (req, reply) => {
    const body = Heartbeat.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (impostor(req, reply, body.data.agentId)) return reply;
    store.touchAgent(body.data.agentId);
    const cancel = new Set([
      ...store.renewLeases(body.data.agentId, body.data.running, deps.leaseMs),
      ...store.cancelRequestedJobs(body.data.agentId),
    ]);
    return { cancel: [...cancel] };
  });

  app.post<{ Params: { id: string }; Querystring: { agentId?: string } }>("/worker/v1/jobs/:id/events", async (req, reply) => {
    const body = WorkerEvents.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const job = heldJob(caller(req), req.params.id);
    if (!job) return reply.code(409).send({ error: "not_held" });
    store.renewLeases(job.agentId, [job.id], deps.leaseMs);
    for (const e of body.data.events) {
      const payload = EVENT_PAYLOADS[e.type].safeParse({ ...e.payload, jobId: job.id });
      if (!payload.success) return bad(reply, payload.error);
      events.emit(e.type, job.agentId, job.taskId, payload.data as never);
    }
    return { ok: true };
  });

  // A download's bytes, for a job the backend itself asked for. Held for the
  // API answer only; never stored, never in an event.
  app.post<{ Params: { id: string }; Querystring: { agentId?: string } }>("/worker/v1/jobs/:id/file", async (req, reply) => {
    const job = heldJob(caller(req), req.params.id);
    if (!job || job.op !== "fs.fetch") return reply.code(409).send({ error: "not_held" });
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "expected application/octet-stream" });
    store.renewLeases(job.agentId, [job.id], deps.leaseMs);
    deps.downloads.put(job.id, req.body);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Querystring: { agentId?: string } }>("/worker/v1/jobs/:id/complete", async (req, reply) => {
    const outcome = JobOutcome.safeParse(req.body);
    if (!outcome.success) return bad(reply, outcome.error);
    const job = store.job(req.params.id);
    if (!job || job.agentId !== caller(req)) return reply.code(404).send({ error: "not_found" });
    // A repeated report (the worker retrying after a lost answer) is fine.
    if (job.status === "claimed") finish(job, outcome.data);
    if (!store.db.prepare("SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(job.agentId)) {
      setStatus(job.agentId, "ready");
    }
    return { ok: true, status: store.job(job.id)?.status };
  });

  return app;
}
