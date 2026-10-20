// The API Coucou talks to: loopback only, one bearer token, JSON in and out,
// and the event streams. It never runs anything itself; it reads the store
// and hands commands to the runner.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  AgentId,
  ApprovalDecision,
  CreateTaskRequest,
  RelPath,
  type Agent,
  type AgentProblem,
} from "@coucou-orchestrator/protocol";
import type { EventLog } from "./events.ts";
import type { ModelRouter } from "./model/router.ts";
import { runBackendJob, type Downloads, type JobSignals } from "./jobs.ts";
import { redactText } from "./redact.ts";
import type { Runner } from "./runner.ts";
import { resumePoint, streamEvents } from "./sse.ts";
import type { Store } from "./store.ts";
import { bearerMatches } from "./tokens.ts";
import type { VmProbe } from "./vm.ts";

export interface ApiDeps {
  store: Store;
  events: EventLog;
  runner: Runner;
  signals: JobSignals;
  downloads: Downloads;
  models: ModelRouter;
  token: string;
  vmProbe: VmProbe;
  /** How long a file request waits for the worker. */
  fileTimeoutMs?: number;
}

const TaskQuery = z.object({
  active: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Below this, the agent's disk is reported as nearly full. */
const LOW_DISK_BYTES = 1024 ** 3;

/** Text files are redacted on the way out, like everything else that leaves the VM as text. */
const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/plain",
  htm: "text/plain",
  xml: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
};
const BINARY_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  zip: "application/zip",
};

/** What is wrong with an agent's computer, from its status, its last health report and the VM check. */
export function agentProblems(agent: Agent, vmRunning: boolean | null): AgentProblem[] {
  if (agent.status === "offline") return [vmRunning === false ? "vm_stopped" : "worker_down"];
  const problems: AgentProblem[] = [];
  const h = agent.health;
  if (h && h.diskTotalBytes > 0 && h.diskFreeBytes < LOW_DISK_BYTES) problems.push("low_disk");
  if (h && !h.browserReady) problems.push("no_browser");
  return problems;
}

function bad(reply: FastifyReply, error: z.ZodError | string) {
  const message = typeof error === "string" ? error : error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
  return reply.code(400).send({ error: "invalid", message });
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const { store, events, runner, signals } = deps;
  const fileTimeoutMs = deps.fileTimeoutMs ?? 30_000;
  // wsl.exe takes a moment; Coucou asks for agents on every redraw.
  const vmChecks = new Map<string, { at: number; running: Promise<boolean | null> }>();
  const vmRunning = (vmId: string) => {
    const hit = vmChecks.get(vmId);
    if (hit && Date.now() - hit.at < 10_000) return hit.running;
    const running = deps.vmProbe(vmId).catch(() => null);
    vmChecks.set(vmId, { at: Date.now(), running });
    return running;
  };
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/tasks", async (req, reply) => {
    const body = CreateTaskRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.agent(body.data.agentId)) return bad(reply, `unknown agent ${body.data.agentId}`);
    if (body.data.modelProfileId && !deps.models.has(body.data.modelProfileId)) {
      return bad(reply, `unknown model profile ${body.data.modelProfileId}`);
    }
    const { task, created } = runner.submit(body.data);
    return reply.code(created ? 201 : 200).send({ task, created });
  });

  app.get("/api/tasks", async (req, reply) => {
    const q = TaskQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    // Read together, so a client can stream from `lastSeq` and miss nothing.
    const lastSeq = Number((store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s);
    return { tasks: store.tasks({ active: q.data.active === "1", limit: q.data.limit }), lastSeq };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = store.task(req.params.id);
    if (!task) return reply.code(404).send({ error: "not_found" });
    const approvals = store.pendingApprovals(task.agentId).filter((a) => a.taskId === task.id);
    const steps = store.steps(task.id).map((s) => ({
      n: s.n,
      note: s.note,
      op: s.op,
      status: s.outcome?.status ?? (s.approvalId && !s.jobId ? "waiting_for_approval" : "running"),
    }));
    return { task, steps, approvals, events: events.after(0, { taskId: task.id, limit: 500 }) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const task = runner.cancel(req.params.id);
    if (!task) return reply.code(404).send({ error: "not_found" });
    return { task };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/tasks/:id/events", async (req, reply) => {
    if (!store.task(req.params.id)) return reply.code(404).send({ error: "not_found" });
    reply.hijack();
    streamEvents(reply.raw, events, {
      after: resumePoint(req.headers["last-event-id"], req.query.after),
      taskId: req.params.id,
    });
  });

  app.get<{ Querystring: { after?: string } }>("/api/events", async (req, reply) => {
    reply.hijack();
    streamEvents(reply.raw, events, { after: resumePoint(req.headers["last-event-id"], req.query.after) });
  });

  app.get("/api/models", async () => ({
    profiles: deps.models.list(),
    default: store.agent("agent-01")?.modelProfileId ?? null,
  }));

  app.get("/api/agents", async () => {
    const agents = await Promise.all(
      store.agents().map(async (agent) => ({
        ...agent,
        problems: agentProblems(agent, agent.status === "offline" ? await vmRunning(agent.vmId) : null),
      })),
    );
    return { agents, approvals: store.pendingApprovals() };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/approval", async (req, reply) => {
    const body = ApprovalDecision.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const approval = store.approval(body.data.approvalId);
    if (!approval || approval.agentId !== req.params.id) return reply.code(404).send({ error: "not_found" });
    const applied = runner.resolveApproval(approval.id, body.data.decision);
    if (!applied) return reply.code(409).send({ error: "already_decided", status: store.approval(approval.id)?.status });
    return { approval: store.approval(approval.id) };
  });

  // Files live in the VM; the worker lists and reads them for us.
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>("/api/agents/:id/files", async (req, reply) => {
    const agentId = AgentId.safeParse(req.params.id);
    const task = req.query.taskId ? store.task(req.query.taskId) : null;
    if (!agentId.success || !task || task.agentId !== agentId.data) return reply.code(404).send({ error: "not_found" });
    const outcome = await runBackendJob(store, signals, { taskId: task.id, agentId: task.agentId, op: "fs.list", args: {} }, fileTimeoutMs);
    if (!outcome) return reply.code(504).send({ error: "worker_unavailable" });
    if (outcome.status !== "succeeded") return reply.code(502).send({ error: "failed", message: outcome.error?.message });
    return { taskId: task.id, files: JSON.parse(outcome.result ?? "[]") as unknown };
  });

  app.get<{ Params: { id: string; taskId: string; "*": string } }>(
    "/api/agents/:id/files/:taskId/*",
    async (req, reply) => {
      const task = store.task(req.params.taskId);
      const path = RelPath.safeParse(req.params["*"]);
      if (!task || task.agentId !== req.params.id) return reply.code(404).send({ error: "not_found" });
      if (!path.success) return bad(reply, path.error);
      const name = path.data.split("/").pop() ?? "file";
      const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
      const disposition = `attachment; filename="${name.replace(/"/g, "")}"`;
      const job = (op: "fs.fetch" | "fs.read") =>
        runBackendJob(store, signals, { taskId: task.id, agentId: task.agentId, op, args: { path: path.data } }, fileTimeoutMs);

      let outcome = await job("fs.fetch");
      if (outcome?.status === "failed" && outcome.error?.code === "invalid") {
        // A worker from before downloads (0.1): it can only read text.
        outcome = await job("fs.read");
        if (!outcome) return reply.code(504).send({ error: "worker_unavailable" });
        if (outcome.status !== "succeeded") return reply.code(404).send({ error: "not_found", message: outcome.error?.message });
        return reply.header("Content-Type", "text/plain; charset=utf-8").header("Content-Disposition", disposition).send(outcome.result ?? "");
      }
      if (!outcome) return reply.code(504).send({ error: "worker_unavailable" });
      if (outcome.status !== "succeeded") return reply.code(404).send({ error: "not_found", message: outcome.error?.message });
      const bytes = deps.downloads.take(outcome.jobId);
      const sent = JSON.parse(outcome.result ?? "{}") as { bytes?: number; sha256?: string };
      if (!bytes || bytes.length !== sent.bytes || createHash("sha256").update(bytes).digest("hex") !== sent.sha256) {
        return reply.code(502).send({ error: "failed", message: "the file did not arrive whole" });
      }
      const text = TEXT_TYPES[ext];
      if (text) {
        return reply
          .header("Content-Type", `${text}; charset=utf-8`)
          .header("Content-Disposition", disposition)
          .send(redactText(bytes.toString("utf8")));
      }
      return reply
        .header("Content-Type", BINARY_TYPES[ext] ?? "application/octet-stream")
        .header("Content-Disposition", disposition)
        .send(bytes);
    },
  );

  return app;
}
