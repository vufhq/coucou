import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEP_ALIVE_CHECK_MS, keepWslAlive } from "../../server/src/vm.ts";

describe("keepWslAlive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts once, then only when the distro stopped", async () => {
    const answers = [true, false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const start = vi.fn();
    const log = vi.fn();
    const k = keepWslAlive("agent-01", log, { probe, start });
    expect(start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS);
    expect(start).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("keep-alive for agent-01: it is not running; starting it again");
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS * 3);
    expect(start).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith("wsl:agent-01");
    k.stop();
  });

  it("backs off for a distro that never comes up, and says so once", async () => {
    const probe = vi.fn(async () => false);
    const start = vi.fn();
    const log = vi.fn();
    const k = keepWslAlive("agent-02", log, { probe, start });
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS * 2); // checks at 30 s and 60 s
    expect(start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS * 2); // next check at 120 s
    expect(start).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.filter(([l]) => String(l).includes("is it provisioned?"))).toHaveLength(1);
    k.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).toHaveBeenCalledTimes(4);
  });

  it("refuses a name that is not a distro name", () => {
    const start = vi.fn();
    keepWslAlive("a b&calc", () => {}, { probe: async () => false, start });
    expect(start).not.toHaveBeenCalled();
  });
});
