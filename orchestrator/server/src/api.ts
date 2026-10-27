// The API Coucou talks to: loopback only, one bearer token, JSON in and out,
// and the event streams. It never runs anything itself; it reads the store
// and hands commands to the runner.

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  AgentId,
  AgentIdentity,
  AgentLimits,
  ApprovalDecision,
  CreateAgentRequest,
  CreateGoalRequest,
  CreateNoteRequest,
  CreateTeamRequest,
  CreateTaskRequest,
  GoalRunRequest,
  MAX_ATTACHMENT_BYTES,
  RelPath,
  TaskAnswer,
  UpdateTeamRequest,
  UpdateGoalRequest,
  type Agent,
  type AgentProblem,
} from "@coucou-orchestrator/protocol";
import type { Uploads } from "./attachments.ts";
import type { EventLog } from "./events.ts";
import type { ModelRouter } from "./model/router.ts";
import { runBackendJob, type Downloads, type JobSignals } from "./jobs.ts";
import { redactText } from "./redact.ts";
import type { Runner } from "./runner.ts";
import { resumePoint, streamEvents } from "./sse.ts";
import type { Store } from "./store.ts";
import { nextScheduleTime } from "./scheduler.ts";
import { bearerMatches } from "./tokens.ts";
import type { VmProbe } from "./vm.ts";

export interface ApiDeps {
  store: Store;
  events: EventLog;
  runner: Runner;
  signals: JobSignals;
  downloads: Downloads;
  /** Files attached to messages; without it, POST /api/attachments is not there. */
  uploads?: Uploads;
  models: ModelRouter;
  token: string;
  vmProbe: VmProbe;
  /** How long a file request waits for the worker. */
  fileTimeoutMs?: number;
}

const TaskQuery = z.object({
  active: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  agentId: AgentId.optional(),
  source: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(["user", "chat", "goal", "delegated"])).min(1))
    .optional(),
  goalId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
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
  const problems: AgentProblem[] = [];
  if (agent.status === "offline") {
    problems.push(vmRunning === false ? "vm_stopped" : "worker_down");
  } else {
    const h = agent.health;
    if (h && h.diskTotalBytes > 0 && h.diskFreeBytes < LOW_DISK_BYTES) problems.push("low_disk");
    if (h && !h.browserReady) problems.push("no_browser");
  }
  if (
    agent.usage.tasksToday >= agent.limits.tasksPerDay ||
    agent.usage.stepsToday >= agent.limits.stepsPerDay
  ) {
    problems.push("daily_limit");
  }
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
  // Attached files, on their one route; everything else is JSON.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  const chiefId = () => store.agents().find((agent) => agent.kind === "chief")!.id;

  app.addHook("onRequest", async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/tasks", async (req, reply) => {
    const body = CreateTaskRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (body.data.agentId && !store.agent(body.data.agentId)) return bad(reply, `unknown agent ${body.data.agentId}`);
    if (body.data.modelProfileId && !deps.models.has(body.data.modelProfileId)) {
      return bad(reply, `unknown model profile ${body.data.modelProfileId}`);
    }
    const submitted = runner.submit(body.data);
    if ("error" in submitted) return bad(reply, submitted.error);
    const { task, created } = submitted;
    return reply.code(created ? 201 : 200).send({ task, created });
  });

  // A file for the next message, bytes as they are; its id goes in the task's
  // `attachments`. It waits here until the task copies it to the computer.
  app.post<{ Querystring: { name?: string } }>(
    "/api/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES },
    async (req, reply) => {
      if (!deps.uploads) return reply.code(404).send({ error: "not_found" });
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "invalid", message: "expected application/octet-stream" });
      const name = z.string().min(1).max(255).safeParse(req.query.name);
      if (!name.success) return bad(reply, "name is required");
      const upload = deps.uploads.save(name.data, req.body);
      return reply.code(201).send({ attachment: { id: upload.id, name: upload.name, bytes: upload.bytes } });
    },
  );

  app.get("/api/tasks", async (req, reply) => {
    const q = TaskQuery.safeParse(req.query);
    if (!q.success) return bad(reply, q.error);
    // Read together, so a client can stream from `lastSeq` and miss nothing.
    const lastSeq = Number((store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s);
    return {
      tasks: store.tasks({
        active: q.data.active === "1",
        limit: q.data.limit,
        agentId: q.data.agentId,
        source: q.data.source,
        goalId: q.data.goalId,
        parentTaskId: q.data.parentTaskId,
      }),
      lastSeq,
    };
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
    return {
      task,
      children: store.childTasks(task.id),
      steps,
      approvals,
      events: events.after(0, { taskId: task.id, limit: 500 }),
    };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (req, reply) => {
    const task = runner.cancel(req.params.id);
    if (!task) return reply.code(404).send({ error: "not_found" });
    return { task };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/answer", async (req, reply) => {
    const body = TaskAnswer.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.task(req.params.id)) return reply.code(404).send({ error: "not_found" });
    if (!runner.answer(req.params.id, body.data.questionId, body.data.answer)) {
      return reply.code(409).send({ error: "no_pending_question" });
    }
    return { task: store.task(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/pause", async (req, reply) => {
    const task = runner.pause(req.params.id);
    if (task === null) return reply.code(404).send({ error: "not_found" });
    if (task === "not_pausable") return reply.code(409).send({ error: "not_pausable" });
    return { task };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (req, reply) => {
    const task = runner.resume(req.params.id);
    if (task === null) return reply.code(404).send({ error: "not_found" });
    if (task === "not_paused") return reply.code(409).send({ error: "not_paused" });
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
    default: store.agents()[0]?.modelProfileId ?? null,
  }));

  app.get("/api/agents", async () => {
    const agents = await Promise.all(
      store.agents().map(async (agent) => ({
        ...agent,
        problems: agentProblems(agent, agent.status === "offline" ? await vmRunning(agent.vmId) : null),
      })),
    );
    const computers = await Promise.all(
      store.computers().map(async (computer) => {
        const probe = computer.status === "offline" ? await vmRunning(computer.vmId) : null;
        const problems: AgentProblem[] = [];
        if (computer.status === "offline") problems.push(probe === false ? "vm_stopped" : "worker_down");
        if (computer.status !== "offline" && computer.health?.diskTotalBytes &&
            computer.health.diskFreeBytes < LOW_DISK_BYTES) problems.push("low_disk");
        if (computer.status !== "offline" && computer.health && !computer.health.browserReady) problems.push("no_browser");
        return { ...computer, problems, capacity: runner.tasksPerComputer };
      }),
    );
    return { agents, teams: store.teams(), computers, approvals: store.pendingApprovals() };
  });

  // The user renames or recolours an agent; every window hears it.
  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const body = AgentIdentity.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const current = store.agent(req.params.id);
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (body.data.teamId && !store.team(body.data.teamId)) return bad(reply, `unknown team ${body.data.teamId}`);
    if (body.data.computerId && !store.isConfiguredComputer(body.data.computerId)) {
      return bad(reply, `unknown computer ${body.data.computerId}`);
    }
    store.setAgentIdentity(req.params.id, body.data);
    events.emit("agent.updated", req.params.id, null, {});
    return { agent: store.agent(req.params.id) };
  });

  app.post("/api/agents", async (req, reply) => {
    const body = CreateAgentRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (store.agents().length >= 12) return reply.code(409).send({ error: "too_many_agents" });
    if (body.data.teamId && !store.team(body.data.teamId)) return bad(reply, `unknown team ${body.data.teamId}`);
    // One shared computer: a new agent goes on the first configured one.
    const computerId = body.data.computerId ?? store.defaultComputerId();
    if (!computerId || !store.isConfiguredComputer(computerId)) return bad(reply, `unknown computer ${String(computerId)}`);
    const agent = store.createAgent({
      ...body.data,
      computerId,
      createdBy: "user",
      modelProfileId: store.agents()[0]?.modelProfileId ?? "",
    });
    events.emit("agent.updated", agent.id, null, {});
    return reply.code(201).send({ agent });
  });

  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const agent = store.agent(req.params.id);
    if (!agent) return reply.code(404).send({ error: "not_found" });
    if (agent.kind === "chief") return reply.code(409).send({ error: "chief" });
    runner.retireAgent(agent.id);
    return { ok: true };
  });

  app.post("/api/teams", async (req, reply) => {
    const body = CreateTeamRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const team = store.createTeam(body.data.name);
    events.emit("team.updated", chiefId(), null, {});
    return reply.code(201).send({ team });
  });

  app.patch<{ Params: { id: string } }>("/api/teams/:id", async (req, reply) => {
    const body = UpdateTeamRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const team = store.updateTeam(req.params.id, body.data);
    if (!team) return reply.code(404).send({ error: "not_found" });
    events.emit("team.updated", chiefId(), null, {});
    return { team };
  });

  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (req, reply) => {
    const members = store.agents().filter((agent) => agent.teamId === req.params.id);
    if (!store.deleteTeam(req.params.id)) return reply.code(404).send({ error: "not_found" });
    for (const member of members) events.emit("agent.updated", member.id, null, {});
    events.emit("team.updated", chiefId(), null, {});
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    if (!runner.pauseAgent(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { agent: store.agent(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    if (!runner.resumeAgent(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { agent: store.agent(req.params.id) };
  });

  app.put<{ Params: { id: string } }>("/api/agents/:id/limits", async (req, reply) => {
    const body = AgentLimits.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.agent(req.params.id)) return reply.code(404).send({ error: "not_found" });
    store.setAgentLimits(req.params.id, body.data);
    events.emit("agent.updated", req.params.id, null, {});
    runner.pump(req.params.id);
    return { agent: store.agent(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/memory", async (req, reply) => {
    if (!store.agent(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { notes: store.notes(req.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/memory", async (req, reply) => {
    const body = CreateNoteRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.agent(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const note = runner.remember(req.params.id, body.data.text, "user");
    if (!note) return bad(reply, "note is empty after removing control characters");
    return reply.code(201).send({ note });
  });

  app.delete<{ Params: { id: string; noteId: string } }>("/api/agents/:id/memory/:noteId", async (req, reply) => {
    if (!store.agent(req.params.id) || !store.deleteNote(req.params.id, req.params.noteId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    events.emit("memory.updated", req.params.id, null, {});
    return { ok: true };
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

  app.get("/api/goals", async (req, reply) => {
    const query = z.object({ agentId: AgentId.optional() }).safeParse(req.query);
    if (!query.success) return bad(reply, query.error);
    return { goals: store.goals(query.data.agentId) };
  });

  app.post("/api/goals", async (req, reply) => {
    const body = CreateGoalRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    if (!store.agent(body.data.agentId)) return bad(reply, `unknown agent ${body.data.agentId}`);
    if (body.data.modelProfileId && !deps.models.has(body.data.modelProfileId)) {
      return bad(reply, `unknown model profile ${body.data.modelProfileId}`);
    }
    const goal = store.createGoal({
      ...body.data,
      nextRunAt: nextScheduleTime(body.data.schedule, new Date())?.toISOString() ?? null,
    });
    events.emit("goal.updated", goal.agentId, null, { goalId: goal.id });
    return reply.code(201).send({ goal });
  });

  app.patch<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const body = UpdateGoalRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const current = store.goal(req.params.id);
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (body.data.modelProfileId && !deps.models.has(body.data.modelProfileId)) {
      return bad(reply, `unknown model profile ${body.data.modelProfileId}`);
    }
    const schedule = body.data.schedule ?? current.schedule;
    const status = body.data.status ?? current.status;
    const rescheduled = body.data.schedule !== undefined || body.data.status !== undefined;
    const nextRunAt = rescheduled && status === "active"
      ? nextScheduleTime(schedule, new Date())?.toISOString() ?? null
      : status === "paused"
        ? null
        : current.nextRunAt;
    const goal = store.updateGoal(current.id, { ...body.data, nextRunAt })!;
    events.emit("goal.updated", goal.agentId, null, { goalId: goal.id });
    return { goal };
  });

  app.delete<{ Params: { id: string } }>("/api/goals/:id", async (req, reply) => {
    const goal = store.goal(req.params.id);
    if (!goal) return reply.code(404).send({ error: "not_found" });
    store.archiveGoal(goal.id);
    events.emit("goal.updated", goal.agentId, null, { goalId: goal.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/goals/:id/run", async (req, reply) => {
    const body = GoalRunRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const result = runner.runGoal(req.params.id, body.data.idempotencyKey);
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "already_running") return reply.code(409).send({ error: "already_running" });
    return { task: result.task, created: result.created };
  });

  // Files live in the VM; the worker lists and reads them for us.
  app.get<{ Params: { id: string }; Querystring: { taskId?: string } }>("/api/agents/:id/files", async (req, reply) => {
    const agentId = AgentId.safeParse(req.params.id);
    const task = req.query.taskId ? store.task(req.query.taskId) : null;
    if (!agentId.success || !task || task.agentId !== agentId.data) return reply.code(404).send({ error: "not_found" });
    const computerId = store.agent(task.agentId)?.computerId;
    if (!computerId) return reply.code(404).send({ error: "not_found" });
    const outcome = await runBackendJob(store, signals, { taskId: task.id, agentId: computerId, op: "fs.list", args: {} }, fileTimeoutMs);
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
        runBackendJob(
          store,
          signals,
          { taskId: task.id, agentId: store.agent(task.agentId)?.computerId ?? "", op, args: { path: path.data } },
          fileTimeoutMs,
        );

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
