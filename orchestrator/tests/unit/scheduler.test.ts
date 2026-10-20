import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceSchedule, nextScheduleTime } from "../../server/src/scheduler.ts";

const originalTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  process.env.TZ = originalTz;
});

describe("goal schedule maths", () => {
  it("returns null for manual schedules and preserves every-N-hour slots during catch-up", () => {
    expect(nextScheduleTime({ kind: "manual" }, new Date())).toBeNull();
    const due = new Date("2026-01-01T10:00:00Z");
    expect(advanceSchedule({ kind: "every", hours: 2 }, due, new Date("2026-01-01T15:00:00Z"))?.toISOString()).toBe(
      "2026-01-01T16:00:00.000Z",
    );
  });

  it("uses local wall-clock time across the spring DST gap", () => {
    const after = new Date(2026, 2, 8, 1, 45);
    const next = nextScheduleTime({ kind: "daily", time: "02:30" }, after)!;
    expect([next.getHours(), next.getMinutes()]).toEqual([3, 30]);
    expect(next.getDate()).toBe(8);
  });

  it("uses the first occurrence of an ambiguous local time in the fall", () => {
    const after = new Date(2026, 10, 1, 0, 30);
    const next = nextScheduleTime({ kind: "daily", time: "01:30" }, after)!;
    expect(next.getHours()).toBe(1);
    expect(next.getTimezoneOffset()).toBe(240);
  });

  it("moves a Friday weekday schedule to Monday", () => {
    const fridayAfterRun = new Date(2026, 9, 23, 18, 0);
    const next = nextScheduleTime({ kind: "weekdays", time: "09:15" }, fridayAfterRun)!;
    expect([next.getDay(), next.getDate(), next.getHours(), next.getMinutes()]).toEqual([1, 26, 9, 15]);
  });
});
