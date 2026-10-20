// Durable state in one SQLite file (node:sqlite, no native build). The
// backend owns task state: Coucou and the worker can both disappear and come
// back, and everything they need to carry on is here.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_BUDGET,
  type Agent,
  type AgentLimits,
  type Budget,
  type CreateTaskRequest,
  type FailureReason,
  type Goal,
  type JobOutcome,
  type Note,
  type OpName,
  type Schedule,
  type Task,
  type TaskQuestion,
  type TaskStatus,
  type WorkerHealth,
} from "@coucou-orchestrator/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  model_profile_id TEXT NOT NULL,
  last_seen_at TEXT,
  approved_domains TEXT NOT NULL DEFAULT '[]',
  health TEXT,
  custom_name TEXT,
  color TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  tasks_per_day INTEGER NOT NULL DEFAULT 30,
  steps_per_day INTEGER NOT NULL DEFAULT 300
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  model_profile_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  budget TEXT NOT NULL,
  steps INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  goal_id TEXT,
  question TEXT,
  question_count INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '[]',
  question_asked_at TEXT,
  waiting_reason TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  paused_by_agent INTEGER NOT NULL DEFAULT 0,
  paused_from_status TEXT,
  inactive_ms INTEGER NOT NULL DEFAULT 0,
  inactive_since TEXT
);
CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(agent_id, status, created_at);
CREATE TABLE IF NOT EXISTS steps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  n INTEGER NOT NULL,
  note TEXT NOT NULL,
  op TEXT NOT NULL,
  args TEXT NOT NULL,
  approval_id TEXT,
  job_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, n)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  op TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  deadline_ms INTEGER NOT NULL,
  lease_until INTEGER,
  claimed_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS jobs_by_task ON jobs(task_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  op TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  sequence INTEGER,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);
CREATE INDEX IF NOT EXISTS tasks_by_age ON tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS tasks_by_goal ON tasks(goal_id, status);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  schedule TEXT NOT NULL,
  model_profile_id TEXT,
  status TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_task_id TEXT,
  last_summary TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_by_due ON goals(status, archived, next_run_at);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_by_agent ON notes(agent_id, created_at);
`;

/** Columns added after a database was first created: added in place, data kept. */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "agents", column: "health", ddl: "ALTER TABLE agents ADD COLUMN health TEXT" },
  { table: "agents", column: "custom_name", ddl: "ALTER TABLE agents ADD COLUMN custom_name TEXT" },
  { table: "agents", column: "color", ddl: "ALTER TABLE agents ADD COLUMN color TEXT" },
  { table: "agents", column: "paused", ddl: "ALTER TABLE agents ADD COLUMN paused INTEGER NOT NULL DEFAULT 0" },
  { table: "agents", column: "tasks_per_day", ddl: "ALTER TABLE agents ADD COLUMN tasks_per_day INTEGER NOT NULL DEFAULT 30" },
  { table: "agents", column: "steps_per_day", ddl: "ALTER TABLE agents ADD COLUMN steps_per_day INTEGER NOT NULL DEFAULT 300" },
  { table: "tasks", column: "context", ddl: "ALTER TABLE tasks ADD COLUMN context TEXT" },
  { table: "tasks", column: "source", ddl: "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'" },
  { table: "tasks", column: "goal_id", ddl: "ALTER TABLE tasks ADD COLUMN goal_id TEXT" },
  { table: "tasks", column: "question", ddl: "ALTER TABLE tasks ADD COLUMN question TEXT" },
  { table: "tasks", column: "question_count", ddl: "ALTER TABLE tasks ADD COLUMN question_count INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "answers", ddl: "ALTER TABLE tasks ADD COLUMN answers TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "question_asked_at", ddl: "ALTER TABLE tasks ADD COLUMN question_asked_at TEXT" },
  { table: "tasks", column: "waiting_reason", ddl: "ALTER TABLE tasks ADD COLUMN waiting_reason TEXT" },
  { table: "tasks", column: "pause_requested", ddl: "ALTER TABLE tasks ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "paused_by_agent", ddl: "ALTER TABLE tasks ADD COLUMN paused_by_agent INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "paused_from_status", ddl: "ALTER TABLE tasks ADD COLUMN paused_from_status TEXT" },
  { table: "tasks", column: "inactive_ms", ddl: "ALTER TABLE tasks ADD COLUMN inactive_ms INTEGER NOT NULL DEFAULT 0" },
  { table: "tasks", column: "inactive_since", ddl: "ALTER TABLE tasks ADD COLUMN inactive_since TEXT" },
];

export type JobStatus = "queued" | "claimed" | "succeeded" | "failed" | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Step {
  taskId: string;
  n: number;
  note: string;
  op: OpName;
  args: Record<string, unknown>;
  approvalId: string | null;
  jobId: string | null;
  outcome: JobOutcome | null;
}

export interface JobRow {
  id: string;
  taskId: string;
  agentId: string;
  op: OpName;
  args: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  deadlineMs: number;
  leaseUntil: number | null;
  claimedAt: number | null;
  cancelRequested: boolean;
  outcome: JobOutcome | null;
}

export interface ApprovalRow {
  id: string;
  taskId: string;
  agentId: string;
  step: number;
  op: OpName;
  target: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
}

export interface EventRow {
  seq: number;
  id: string;
  taskId: string | null;
  agentId: string;
  sequence: number | null;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface AnswerRow {
  question: TaskQuestion;
  answer: string;
}

type Row = Record<string, SQLInputValue>;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
function localDayRange(at = new Date()): [string, string] {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const end = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}
function parse<T>(v: unknown): T {
  return JSON.parse(String(v)) as T;
}
function parseOrNull<T>(v: unknown): T | null {
  return v == null ? null : parse<T>(v);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.db.exec(SCHEMA);
  }

  private migrate(): void {
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (cols.length > 0 && !cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in one transaction: all of it lands, or none of it. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  ensureAgent(a: { id: string; name: string; vmId: string; modelProfileId: string }): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, vm_id, model_profile_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, vm_id = excluded.vm_id, model_profile_id = excluded.model_profile_id`,
      )
      .run(a.id, a.name, a.vmId, a.modelProfileId);
  }

  agents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY id").all() as Row[]).map((row) =>
      toAgent(row, this.agentUsage(String(row.id))),
    );
  }

  agent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row, this.agentUsage(id)) : null;
  }

  setAgentStatus(id: string, status: Agent["status"]): boolean {
    const r = this.db.prepare("UPDATE agents SET status = ? WHERE id = ? AND status != ?").run(status, id, status);
    return Number(r.changes) > 0;
  }

  /** The user's name and colour for an agent; null puts the default back, undefined leaves it. */
  setAgentIdentity(id: string, identity: { name?: string | null; color?: string | null }): void {
    if (identity.name !== undefined) this.db.prepare("UPDATE agents SET custom_name = ? WHERE id = ?").run(identity.name, id);
    if (identity.color !== undefined) {
      this.db.prepare("UPDATE agents SET color = ? WHERE id = ?").run(identity.color?.toUpperCase() ?? null, id);
    }
  }

  setAgentPaused(id: string, paused: boolean): void {
    this.db.prepare("UPDATE agents SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  setAgentLimits(id: string, limits: AgentLimits): void {
    this.db
      .prepare("UPDATE agents SET tasks_per_day = ?, steps_per_day = ? WHERE id = ?")
      .run(limits.tasksPerDay, limits.stepsPerDay, id);
  }

  agentUsage(id: string, at = new Date()): Agent["usage"] {
    const [start, end] = localDayRange(at);
    const tasks = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND started_at >= ? AND started_at < ?")
      .get(id, start, end) as Row;
    const steps = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM steps
         JOIN tasks ON tasks.id = steps.task_id
         WHERE tasks.agent_id = ? AND steps.created_at >= ? AND steps.created_at < ?`,
      )
      .get(id, start, end) as Row;
    return { tasksToday: Number(tasks.n), stepsToday: Number(steps.n) };
  }

  setAgentHealth(id: string, health: WorkerHealth): void {
    this.db.prepare("UPDATE agents SET health = ? WHERE id = ?").run(json({ ...health, checkedAt: now() }), id);
  }

  touchAgent(id: string): void {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  approvedDomains(id: string): string[] {
    const row = this.db.prepare("SELECT approved_domains FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? parse<string[]>(row.approved_domains) : [];
  }

  approveDomain(id: string, domain: string): void {
    const domains = new Set(this.approvedDomains(id));
    domains.add(domain);
    this.db.prepare("UPDATE agents SET approved_domains = ? WHERE id = ?").run(json([...domains].sort()), id);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * Creates the task, or returns the one already created with this key.
   * `created` tells the caller which, so it only announces new tasks.
   */
  createTask(
    req: Omit<CreateTaskRequest, "agentId" | "source"> & {
      agentId: string;
      source?: "user" | "chat" | "goal";
      goalId?: string | null;
    },
    modelProfileId: string,
  ): { task: Task; created: boolean } {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(req.idempotencyKey) as
        | Row
        | undefined;
      if (existing) return { task: toTask(existing), created: false };
      const id = randomUUID();
      const budget: Budget = { ...DEFAULT_BUDGET, ...req.budget };
      const t = now();
      this.db
        .prepare(
          `INSERT INTO tasks (
             id, agent_id, prompt, status, source, goal_id, model_profile_id, workspace,
             budget, idempotency_key, context, created_at, updated_at
           ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, req.agentId, req.prompt, req.source ?? "user", req.goalId ?? null, modelProfileId,
          `/workspace/tasks/${id}`, json(budget), req.idempotencyKey,
          req.context?.trim() || null, t, t,
        );
      return { task: this.task(id)!, created: true };
    });
  }

  task(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  /** The chat this task came from, if any. */
  taskContext(id: string): string | null {
    const row = this.db.prepare("SELECT context FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return (row?.context as string | null) ?? null;
  }

  taskStartedAt(id: string): string | null {
    const row = this.db.prepare("SELECT started_at FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return (row?.started_at as string | null) ?? null;
  }

  tasks(filter: { active?: boolean; limit?: number; agentId?: string; source?: Task["source"]; goalId?: string } = {}): Task[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.active) clauses.push("status NOT IN ('succeeded','failed','cancelled')");
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      values.push(filter.agentId);
    }
    if (filter.source) {
      clauses.push("source = ?");
      values.push(filter.source);
    }
    if (filter.goalId) {
      clauses.push("goal_id = ?");
      values.push(filter.goalId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, filter.limit ?? 50) as Row[];
    return rows.map(toTask);
  }

  /** Tasks the runner has to drive: started and not finished. */
  inFlightTasks(): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE status IN ('starting','running','waiting_for_approval','waiting_for_answer') ORDER BY created_at",
        )
        .all() as Row[]
    ).map(toTask);
  }

  /** Tasks waiting for this agent. */
  queuedCount(agentId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'queued'").get(agentId) as Row;
    return Number(row.n);
  }

  /** How many tasks are being worked on, all agents together. */
  inFlightCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('starting','running','waiting_for_approval')")
      .get() as Row;
    return Number(row.n);
  }

  nextQueued(agentId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1")
      .get(agentId) as Row | undefined;
    return row ? toTask(row) : null;
  }

  agentBusy(agentId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE agent_id = ? AND status IN ('starting','running','waiting_for_approval') LIMIT 1",
      )
      .get(agentId);
    return row !== undefined;
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    const row = this.db
      .prepare("SELECT status, inactive_since, inactive_ms FROM tasks WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return;
    const t = now();
    const wasInactive = row.status === "paused" || row.status === "waiting_for_answer";
    const isInactive = status === "paused" || status === "waiting_for_answer";
    let inactiveMs = Number(row.inactive_ms ?? 0);
    if (wasInactive && !isInactive && row.inactive_since) {
      inactiveMs += Math.max(0, Date.parse(t) - Date.parse(String(row.inactive_since)));
    }
    const inactiveSince = isInactive ? (wasInactive ? (row.inactive_since ?? t) : t) : null;
    const startedAt = status === "starting" ? t : null;
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, updated_at = ?, started_at = COALESCE(started_at, ?),
             inactive_ms = ?, inactive_since = ?
         WHERE id = ?`,
      )
      .run(status, t, startedAt, inactiveMs, inactiveSince, id);
  }

  setWaitingReason(id: string, reason: Task["waitingReason"]): void {
    const row = this.db
      .prepare("SELECT status, started_at, inactive_ms, inactive_since FROM tasks WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return;
    const t = now();
    let inactiveMs = Number(row.inactive_ms ?? 0);
    let inactiveSince = row.inactive_since ?? null;
    const waitingAfterStart = row.status === "queued" && row.started_at != null;
    if (reason && waitingAfterStart && !inactiveSince) inactiveSince = t;
    if (!reason && waitingAfterStart && inactiveSince) {
      inactiveMs += Math.max(0, Date.parse(t) - Date.parse(String(inactiveSince)));
      inactiveSince = null;
    }
    this.db
      .prepare(
        `UPDATE tasks
         SET waiting_reason = ?, inactive_ms = ?, inactive_since = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, inactiveMs, inactiveSince, t, id);
  }

  requestPause(id: string, byAgent: boolean): void {
    const row = this.db
      .prepare("SELECT pause_requested, paused_by_agent FROM tasks WHERE id = ?")
      .get(id) as Row | undefined;
    const userAlreadyRequested =
      Number(row?.pause_requested ?? 0) === 1 && Number(row?.paused_by_agent ?? 0) === 0;
    this.db
      .prepare("UPDATE tasks SET pause_requested = 1, paused_by_agent = ?, updated_at = ? WHERE id = ?")
      .run(byAgent && !userAlreadyRequested ? 1 : 0, now(), id);
  }

  clearPauseRequest(id: string): void {
    this.db
      .prepare("UPDATE tasks SET pause_requested = 0, paused_by_agent = 0, updated_at = ? WHERE id = ?")
      .run(now(), id);
  }

  pauseTask(id: string, from: TaskStatus, byAgent: boolean): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET paused_from_status = ?, paused_by_agent = ?, pause_requested = 0,
             waiting_reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(from, byAgent ? 1 : 0, now(), id);
    this.setTaskStatus(id, "paused");
    // Approval wait already excludes this interval. If it resolves while the
    // task remains paused, inactivity starts at that boundary instead.
    if (from === "waiting_for_approval") {
      this.db.prepare("UPDATE tasks SET inactive_since = NULL WHERE id = ?").run(id);
    }
  }

  resumeTask(id: string): TaskStatus {
    const row = this.db.prepare("SELECT question FROM tasks WHERE id = ?").get(id) as Row;
    const restore = row.question != null ? "waiting_for_answer" : "queued";
    this.db
      .prepare(
        "UPDATE tasks SET pause_requested = 0, paused_by_agent = 0, paused_from_status = NULL, waiting_reason = NULL WHERE id = ?",
      )
      .run(id);
    this.setTaskStatus(id, restore);
    return restore;
  }

  pauseRequested(id: string): boolean {
    const row = this.db.prepare("SELECT pause_requested FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return Number(row?.pause_requested ?? 0) === 1;
  }

  pausedByAgent(id: string): boolean {
    const row = this.db.prepare("SELECT paused_by_agent FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return Number(row?.paused_by_agent ?? 0) === 1;
  }

  pausedFromStatus(id: string): TaskStatus | null {
    const row = this.db.prepare("SELECT paused_from_status FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return (row?.paused_from_status as TaskStatus | null) ?? null;
  }

  startTaskInactivity(id: string): void {
    this.db
      .prepare("UPDATE tasks SET inactive_since = COALESCE(inactive_since, ?), updated_at = ? WHERE id = ?")
      .run(now(), now(), id);
  }

  activeTasksForAgent(agentId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE agent_id = ? AND status NOT IN ('succeeded','failed','cancelled')
           ORDER BY created_at`,
        )
        .all(agentId) as Row[]
    ).map(toTask);
  }

  tasksWithPendingQuestions(): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE question IS NOT NULL AND status NOT IN ('succeeded','failed','cancelled')
           ORDER BY question_asked_at`,
        )
        .all() as Row[]
    ).map(toTask);
  }

  setQuestion(id: string, question: TaskQuestion): void {
    const t = now();
    this.db
      .prepare(
        `UPDATE tasks
         SET question = ?, question_count = question_count + 1, question_asked_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(json(question), t, t, id);
    this.setTaskStatus(id, "waiting_for_answer");
  }

  questionCount(id: string): number {
    const row = this.db.prepare("SELECT question_count FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return Number(row?.question_count ?? 0);
  }

  questionAskedAt(id: string): string | null {
    const row = this.db.prepare("SELECT question_asked_at FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return (row?.question_asked_at as string | null) ?? null;
  }

  answerQuestion(id: string, answer: string): TaskQuestion | null {
    return this.tx(() => {
      const row = this.db.prepare("SELECT question, answers FROM tasks WHERE id = ?").get(id) as Row | undefined;
      if (!row?.question) return null;
      const question = parse<TaskQuestion>(row.question);
      const answers = parse<AnswerRow[]>(row.answers ?? "[]");
      answers.push({ question, answer });
      this.db
        .prepare("UPDATE tasks SET question = NULL, question_asked_at = NULL, answers = ?, updated_at = ? WHERE id = ?")
        .run(json(answers), now(), id);
      return question;
    });
  }

  taskAnswers(id: string): AnswerRow[] {
    const row = this.db.prepare("SELECT answers FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? parse<AnswerRow[]>(row.answers ?? "[]") : [];
  }

  taskInactiveMs(id: string, at = Date.now()): number {
    const row = this.db
      .prepare("SELECT inactive_ms, inactive_since FROM tasks WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) return 0;
    return Number(row.inactive_ms ?? 0) +
      (row.inactive_since ? Math.max(0, at - Date.parse(String(row.inactive_since))) : 0);
  }

  finishTask(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    detail: { result?: { summary: string; artifacts: string[] }; error?: { reason: FailureReason; message: string } },
  ): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result = ?, error = ?, question = NULL, question_asked_at = NULL,
             waiting_reason = NULL, inactive_since = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, detail.result ? json(detail.result) : null, detail.error ? json(detail.error) : null, now(), id);
  }

  requestCancel(id: string): boolean {
    const r = this.db
      .prepare(
        "UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status NOT IN ('succeeded','failed','cancelled')",
      )
      .run(now(), id);
    return Number(r.changes) > 0;
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  addStep(s: { taskId: string; note: string; op: OpName; args: Record<string, unknown> }): Step {
    return this.tx(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM steps WHERE task_id = ?").get(s.taskId) as Row;
      const n = Number(row.n) + 1;
      this.db
        .prepare("INSERT INTO steps (task_id, n, note, op, args, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(s.taskId, n, s.note, s.op, json(s.args), now());
      this.db.prepare("UPDATE tasks SET steps = ?, updated_at = ? WHERE id = ?").run(n, now(), s.taskId);
      return this.step(s.taskId, n)!;
    });
  }

  step(taskId: string, n: number): Step | null {
    const row = this.db.prepare("SELECT * FROM steps WHERE task_id = ? AND n = ?").get(taskId, n) as Row | undefined;
    return row ? toStep(row) : null;
  }

  steps(taskId: string): Step[] {
    return (this.db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY n").all(taskId) as Row[]).map(toStep);
  }

  lastStep(taskId: string): Step | null {
    const row = this.db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY n DESC LIMIT 1").get(taskId) as
      | Row
      | undefined;
    return row ? toStep(row) : null;
  }

  setStepApproval(taskId: string, n: number, approvalId: string): void {
    this.db.prepare("UPDATE steps SET approval_id = ? WHERE task_id = ? AND n = ?").run(approvalId, taskId, n);
  }

  setStepJob(taskId: string, n: number, jobId: string): void {
    this.db.prepare("UPDATE steps SET job_id = ? WHERE task_id = ? AND n = ?").run(jobId, taskId, n);
  }

  setStepOutcome(taskId: string, n: number, outcome: JobOutcome): void {
    this.db.prepare("UPDATE steps SET outcome = ? WHERE task_id = ? AND n = ?").run(json(outcome), taskId, n);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  createJob(j: { taskId: string; agentId: string; op: OpName; args: Record<string, unknown>; deadlineMs: number }): JobRow {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, task_id, agent_id, op, args, status, deadline_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, j.taskId, j.agentId, j.op, json(j.args), j.deadlineMs, t, t);
    return this.job(id)!;
  }

  job(id: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Hands the oldest queued job to a worker, under a lease. */
  claimJob(agentId: string, leaseMs: number): JobRow | null {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT id FROM jobs WHERE agent_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1")
        .get(agentId) as Row | undefined;
      if (!row) return null;
      const t = Date.now();
      this.db
        .prepare(
          "UPDATE jobs SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, lease_until = ?, updated_at = ? WHERE id = ?",
        )
        .run(t, t + leaseMs, now(), String(row.id));
      return this.job(String(row.id));
    });
  }

  /** Renews the leases of the jobs a worker says it is running; returns the ones to cancel. */
  renewLeases(agentId: string, jobIds: string[], leaseMs: number): string[] {
    const cancel: string[] = [];
    for (const id of jobIds) {
      const job = this.job(id);
      if (!job || job.agentId !== agentId) continue;
      if (job.status !== "claimed" || job.cancelRequested) {
        cancel.push(id);
        continue;
      }
      this.db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(Date.now() + leaseMs, id);
    }
    return cancel;
  }

  /** Records a job's end. False when it had already ended (a duplicate report). */
  finishJob(id: string, outcome: JobOutcome): boolean {
    const status: JobStatus = outcome.status;
    const r = this.db
      .prepare(
        "UPDATE jobs SET status = ?, outcome = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','claimed')",
      )
      .run(status, json(outcome), now(), id);
    return Number(r.changes) > 0;
  }

  requeueJob(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'queued', lease_until = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id);
  }

  requestJobCancel(id: string): void {
    this.db.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(now(), id);
  }

  cancelRequestedJobs(agentId: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM jobs WHERE agent_id = ? AND status = 'claimed' AND cancel_requested = 1")
        .all(agentId) as Row[]
    ).map((r) => String(r.id));
  }

  /** Claimed jobs whose lease ran out: the worker stopped renewing them. */
  expiredLeases(at = Date.now()): JobRow[] {
    return (
      this.db.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND lease_until < ?").all(at) as Row[]
    ).map(toJob);
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  createApproval(a: { taskId: string; agentId: string; step: number; op: OpName; target: string; reason: string }): ApprovalRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, agent_id, step, op, target, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, a.taskId, a.agentId, a.step, a.op, a.target, a.reason, now());
    return this.approval(id)!;
  }

  approval(id: string): ApprovalRow | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  pendingApprovals(agentId?: string): ApprovalRow[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND agent_id = ? ORDER BY created_at").all(agentId)
      : this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all();
    return (rows as Row[]).map(toApproval);
  }

  /** Settles a pending approval. False when it was already settled. */
  decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">): boolean {
    const r = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, now(), id);
    return Number(r.changes) > 0;
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  createGoal(input: {
    agentId: string;
    title: string;
    instructions: string;
    schedule: Schedule;
    modelProfileId?: string | null;
    nextRunAt: string | null;
  }): Goal {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO goals (
           id, agent_id, title, instructions, schedule, model_profile_id, status,
           next_run_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id, input.agentId, input.title, input.instructions, json(input.schedule),
        input.modelProfileId ?? null, input.nextRunAt, t, t,
      );
    return this.goal(id)!;
  }

  goal(id: string): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ? AND archived = 0").get(id) as Row | undefined;
    return row ? toGoal(row) : null;
  }

  goalIncludingArchived(id: string): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Row | undefined;
    return row ? toGoal(row) : null;
  }

  goals(agentId?: string): Goal[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM goals WHERE archived = 0 AND agent_id = ? ORDER BY created_at DESC").all(agentId)
      : this.db.prepare("SELECT * FROM goals WHERE archived = 0 ORDER BY created_at DESC").all();
    return (rows as Row[]).map(toGoal);
  }

  updateGoal(
    id: string,
    patch: Partial<Pick<Goal, "title" | "instructions" | "schedule" | "modelProfileId" | "status" | "nextRunAt">>,
  ): Goal | null {
    const fields: string[] = [];
    const values: SQLInputValue[] = [];
    const add = (name: string, value: SQLInputValue) => {
      fields.push(`${name} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.instructions !== undefined) add("instructions", patch.instructions);
    if (patch.schedule !== undefined) add("schedule", json(patch.schedule));
    if (patch.modelProfileId !== undefined) add("model_profile_id", patch.modelProfileId);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.nextRunAt !== undefined) add("next_run_at", patch.nextRunAt);
    if (fields.length === 0) return this.goal(id);
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE goals SET ${fields.join(", ")} WHERE id = ? AND archived = 0`).run(...values);
    return this.goal(id);
  }

  archiveGoal(id: string): boolean {
    const r = this.db
      .prepare("UPDATE goals SET archived = 1, next_run_at = NULL, updated_at = ? WHERE id = ? AND archived = 0")
      .run(now(), id);
    return Number(r.changes) > 0;
  }

  dueGoals(at = new Date()): Goal[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM goals
           WHERE archived = 0 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
           ORDER BY next_run_at`,
        )
        .all(at.toISOString()) as Row[]
    ).map(toGoal);
  }

  activeGoalTask(goalId: string): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE goal_id = ? AND status NOT IN ('succeeded','failed','cancelled')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(goalId) as Row | undefined;
    return row ? toTask(row) : null;
  }

  recordGoalRun(goalId: string, taskId: string, nextRunAt: string | null): void {
    const t = now();
    this.db
      .prepare(
        `UPDATE goals
         SET last_run_at = ?, last_task_id = ?, next_run_at = ?, updated_at = ?
         WHERE id = ? AND archived = 0`,
      )
      .run(t, taskId, nextRunAt, t, goalId);
  }

  completeGoalRun(goalId: string, summary: string, achieved: boolean): Goal | null {
    const t = now();
    this.db
      .prepare(
        `UPDATE goals
         SET last_summary = ?, status = CASE WHEN ? THEN 'achieved' ELSE status END,
             next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END, updated_at = ?
         WHERE id = ?`,
      )
      .run(summary, achieved ? 1 : 0, achieved ? 1 : 0, t, goalId);
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as Row | undefined;
    return row ? toGoal(row) : null;
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  notes(agentId: string): Note[] {
    return (
      this.db.prepare("SELECT * FROM notes WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC").all(agentId) as Row[]
    ).map(toNote);
  }

  addNote(input: { agentId: string; text: string; source: Note["source"]; taskId?: string | null }): Note | null {
    if (input.source === "agent") {
      const duplicate = this.db
        .prepare("SELECT * FROM notes WHERE agent_id = ? AND text = ? ORDER BY created_at DESC LIMIT 1")
        .get(input.agentId, input.text) as Row | undefined;
      if (duplicate) return toNote(duplicate);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO notes (id, agent_id, text, source, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.agentId, input.text, input.source, input.taskId ?? null, now());
    const count = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE agent_id = ?").get(input.agentId) as Row).n,
    );
    if (count > 50) {
      const excess = count - 50;
      this.db
        .prepare(
          `DELETE FROM notes WHERE id IN (
             SELECT id FROM notes WHERE agent_id = ?
             ORDER BY CASE WHEN source = 'agent' THEN 0 ELSE 1 END, created_at, rowid
             LIMIT ?
           )`,
        )
        .run(input.agentId, excess);
    }
    const kept = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
    return kept ? toNote(kept) : null;
  }

  deleteNote(agentId: string, noteId: string): boolean {
    const r = this.db.prepare("DELETE FROM notes WHERE id = ? AND agent_id = ?").run(noteId, agentId);
    return Number(r.changes) > 0;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** Appends an event; the per-task sequence is assigned in the same transaction. */
  appendEvent(e: { taskId: string | null; agentId: string; type: string; payload: Record<string, unknown> }): EventRow {
    return this.tx(() => {
      let sequence: number | null = null;
      if (e.taskId) {
        const row = this.db
          .prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM events WHERE task_id = ?")
          .get(e.taskId) as Row;
        sequence = Number(row.s) + 1;
      }
      const id = randomUUID();
      const r = this.db
        .prepare("INSERT INTO events (id, task_id, agent_id, sequence, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, e.taskId, e.agentId, sequence, e.type, now(), json(e.payload));
      return this.eventBySeq(Number(r.lastInsertRowid))!;
    });
  }

  eventBySeq(seq: number): EventRow | null {
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  eventsAfter(seq: number, filter: { taskId?: string; limit?: number } = {}): EventRow[] {
    const limit = filter.limit ?? 500;
    const rows = filter.taskId
      ? this.db.prepare("SELECT * FROM events WHERE seq > ? AND task_id = ? ORDER BY seq LIMIT ?").all(seq, filter.taskId, limit)
      : this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit);
    return (rows as Row[]).map(toEvent);
  }

  // ── Retention ─────────────────────────────────────────────────────────────

  /**
   * Removes finished tasks last changed before `before`, with everything they
   * own, and agent-level events as old. Never touches a task still in flight.
   * Returns how many tasks went.
   */
  pruneBefore(before: Date): number {
    const cutoff = before.toISOString();
    return this.tx(() => {
      const old = `SELECT id FROM tasks WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?`;
      for (const table of ["events", "approvals", "jobs", "steps"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE task_id IN (${old})`).run(cutoff);
      }
      this.db.prepare("DELETE FROM events WHERE task_id IS NULL AND timestamp < ?").run(cutoff);
      return Number(this.db.prepare(`DELETE FROM tasks WHERE id IN (${old})`).run(cutoff).changes);
    });
  }

  artifacts(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'artifact.created' ORDER BY seq")
      .all(taskId) as Row[];
    return [...new Set(rows.map((r) => String(parse<{ path: string }>(r.payload).path)))];
  }
}

function toAgent(r: Row, usage: Agent["usage"]): Agent {
  return {
    id: String(r.id),
    name: String(r.custom_name ?? r.name),
    vmId: String(r.vm_id),
    status: String(r.status) as Agent["status"],
    paused: Number(r.paused ?? 0) === 1,
    limits: {
      tasksPerDay: Number(r.tasks_per_day ?? 30),
      stepsPerDay: Number(r.steps_per_day ?? 300),
    },
    usage,
    color: (r.color as string | null) ?? null,
    modelProfileId: String(r.model_profile_id),
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
    health: parseOrNull(r.health),
  };
}

function toTask(r: Row): Task {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    prompt: String(r.prompt),
    status: String(r.status) as TaskStatus,
    source: String(r.source ?? "user") as Task["source"],
    goalId: (r.goal_id as string | null) ?? null,
    question: parseOrNull(r.question),
    waitingReason: (r.waiting_reason as Task["waitingReason"]) ?? null,
    modelProfileId: String(r.model_profile_id),
    workspace: String(r.workspace),
    budget: parse<Budget>(r.budget),
    steps: Number(r.steps),
    result: parseOrNull(r.result),
    error: parseOrNull(r.error),
    cancelRequested: Number(r.cancel_requested) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toGoal(r: Row): Goal {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    title: String(r.title),
    instructions: String(r.instructions),
    schedule: parse<Schedule>(r.schedule),
    modelProfileId: (r.model_profile_id as string | null) ?? null,
    status: String(r.status) as Goal["status"],
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastTaskId: (r.last_task_id as string | null) ?? null,
    lastSummary: (r.last_summary as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toNote(r: Row): Note {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    text: String(r.text),
    source: String(r.source) as Note["source"],
    taskId: (r.task_id as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

function toStep(r: Row): Step {
  return {
    taskId: String(r.task_id),
    n: Number(r.n),
    note: String(r.note),
    op: String(r.op) as OpName,
    args: parse(r.args),
    approvalId: (r.approval_id as string | null) ?? null,
    jobId: (r.job_id as string | null) ?? null,
    outcome: parseOrNull(r.outcome),
  };
}

function toJob(r: Row): JobRow {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    agentId: String(r.agent_id),
    op: String(r.op) as OpName,
    args: parse(r.args),
    status: String(r.status) as JobStatus,
    attempts: Number(r.attempts),
    deadlineMs: Number(r.deadline_ms),
    leaseUntil: r.lease_until == null ? null : Number(r.lease_until),
    claimedAt: r.claimed_at == null ? null : Number(r.claimed_at),
    cancelRequested: Number(r.cancel_requested) === 1,
    outcome: parseOrNull(r.outcome),
  };
}

function toApproval(r: Row): ApprovalRow {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    agentId: String(r.agent_id),
    step: Number(r.step),
    op: String(r.op) as OpName,
    target: String(r.target),
    reason: String(r.reason),
    status: String(r.status) as ApprovalStatus,
    createdAt: String(r.created_at),
  };
}

function toEvent(r: Row): EventRow {
  return {
    seq: Number(r.seq),
    id: String(r.id),
    taskId: (r.task_id as string | null) ?? null,
    agentId: String(r.agent_id),
    sequence: r.sequence == null ? null : Number(r.sequence),
    type: String(r.type),
    timestamp: String(r.timestamp),
    payload: parse(r.payload),
  };
}
