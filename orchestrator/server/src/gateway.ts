// The worker's side door: its own listener, its own token, and only the
// handful of calls in the worker protocol. A worker can claim jobs, report
// what they did and say it is alive. It cannot create tasks, approve
// anything or read another agent's jobs.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { z } from "zod";
import {
  EVENT_PAYLOADS,
  Heartbeat,
  Hello,
  JobOutcome,
  READ_ONLY_OPS,
  WorkerEvents,
  type ClaimResponse,
} from "@coucou-orchestrator/protocol";
import type { EventLog } from "./events.ts";
import type { JobSignals } from "./jobs.ts";
import { redact } from "./redact.ts";
import type { Runner } from "./runner.ts";
import type { JobRow, Store } from "./store.ts";
import { bearerMatches } from "./tokens.ts";

export interface GatewayDeps {
  store: Store;
  events: EventLog;
  runner: Runner;
  signals: JobSignals;
  token: string;
  leaseMs: number;
  claimWaitMs: number;
}

function bad(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid", message: error.issues.map((i) => i.message).join("; ") });
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const { store, events, runner, signals } = deps;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

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
    const { agentId, journal } = hello.data;
    if (!store.agent(agentId)) return reply.code(404).send({ error: "unknown_agent" });
    store.touchAgent(agentId);

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
    return { ok: true, leaseMs: deps.leaseMs };
  });

  app.post("/worker/v1/jobs/claim", async (req, reply): Promise<ClaimResponse | FastifyReply> => {
    const body = Heartbeat.pick({ agentId: true }).safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const { agentId } = body.data;
    if (!store.agent(agentId)) return reply.code(404).send({ error: "unknown_agent" });
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
    const job = heldJob(String(req.query.agentId), req.params.id);
    if (!job) return reply.code(409).send({ error: "not_held" });
    store.renewLeases(job.agentId, [job.id], deps.leaseMs);
    for (const e of body.data.events) {
      const payload = EVENT_PAYLOADS[e.type].safeParse({ ...e.payload, jobId: job.id });
      if (!payload.success) return bad(reply, payload.error);
      events.emit(e.type, job.agentId, job.taskId, payload.data as never);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Querystring: { agentId?: string } }>("/worker/v1/jobs/:id/complete", async (req, reply) => {
    const outcome = JobOutcome.safeParse(req.body);
    if (!outcome.success) return bad(reply, outcome.error);
    const job = store.job(req.params.id);
    if (!job || job.agentId !== req.query.agentId) return reply.code(404).send({ error: "not_found" });
    // A repeated report (the worker retrying after a lost answer) is fine.
    if (job.status === "claimed") finish(job, outcome.data);
    if (!store.db.prepare("SELECT 1 FROM jobs WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(job.agentId)) {
      setStatus(job.agentId, "ready");
    }
    return { ok: true, status: store.job(job.id)?.status };
  });

  return app;
}
