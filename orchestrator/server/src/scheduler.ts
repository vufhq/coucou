import type { Schedule } from "@coucou-orchestrator/protocol";
import type { EventLog } from "./events.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";

const HOUR_MS = 60 * 60_000;

function clock(time: string): [number, number] {
  const [hour, minute] = time.split(":").map(Number);
  return [hour!, minute!];
}

/** The first scheduled local time strictly after `after`. */
export function nextScheduleTime(schedule: Schedule, after: Date): Date | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "every") return new Date(after.getTime() + schedule.hours * HOUR_MS);
  const [hour, minute] = clock(schedule.time);
  for (let add = 0; add <= 7; add++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + add,
      hour,
      minute,
      0,
      0,
    );
    if (candidate <= after) continue;
    if (schedule.kind === "weekdays") {
      const day = candidate.getDay();
      if (day === 0 || day === 6) continue;
    }
    return candidate;
  }
  throw new Error("could not find the next scheduled time");
}

/** Advances a due schedule to its first future slot, without replaying missed slots. */
export function advanceSchedule(schedule: Schedule, due: Date, now: Date): Date | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind !== "every") return nextScheduleTime(schedule, now);
  const interval = schedule.hours * HOUR_MS;
  const elapsed = Math.max(0, now.getTime() - due.getTime());
  const slots = Math.floor(elapsed / interval) + 1;
  return new Date(due.getTime() + slots * interval);
}

export class GoalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly store: Store;
  private readonly events: EventLog;
  private readonly runner: Runner;
  private readonly pollMs: number;

  constructor(store: Store, events: EventLog, runner: Runner, pollMs = 30_000) {
    this.store = store;
    this.events = events;
    this.runner = runner;
    this.pollMs = pollMs;
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts one catch-up run for each due goal and advances past all missed slots. */
  tick(at = new Date()): void {
    for (const goal of this.store.dueGoals(at)) {
      const due = goal.nextRunAt ? new Date(goal.nextRunAt) : at;
      const next = advanceSchedule(goal.schedule, due, at)?.toISOString() ?? null;
      const active = this.store.activeGoalTask(goal.id);
      if (!active) {
        this.runner.runGoal(goal.id, `scheduled-${goal.id}-${goal.nextRunAt ?? at.toISOString()}`, next);
      } else {
        this.store.updateGoal(goal.id, { nextRunAt: next });
        this.events.emit("goal.updated", goal.agentId, null, { goalId: goal.id });
      }
    }
  }
}
