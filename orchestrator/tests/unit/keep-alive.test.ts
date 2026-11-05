import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, vmDriver } from "../../server/src/config.ts";
import { KEEP_ALIVE_CHECK_MS, keepVmAlive, keepWslAlive, limactlPath, limaStatus, parseVmId } from "../../server/src/vm.ts";

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

describe("Lima VMs (a Mac)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads vm ids of both kinds, and nothing else", () => {
    expect(parseVmId("wsl:agent-01")).toEqual({ kind: "wsl", name: "agent-01" });
    expect(parseVmId("lima:coucou-agent-01")).toEqual({ kind: "lima", name: "coucou-agent-01" });
    expect(parseVmId("lima:-rm")).toBeNull();
    expect(parseVmId("lima:a b")).toBeNull();
    expect(parseVmId("docker:agent-01")).toBeNull();
  });

  it("reads limactl's JSON lines", () => {
    const out = [
      'time="…" level=warning msg="not JSON"',
      JSON.stringify({ name: "other", status: "Running" }),
      JSON.stringify({ name: "coucou-agent-01", status: "Stopped" }),
    ].join("\n");
    expect(limaStatus(out, "coucou-agent-01")).toBe(false);
    expect(limaStatus(out, "other")).toBe(true);
    expect(limaStatus(out, "coucou-agent-02")).toBeNull();
  });

  it("starts a stopped Lima VM again, by its instance name", async () => {
    const answers = [false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const start = vi.fn();
    const k = keepVmAlive("lima:coucou-agent-01", () => {}, { probe, start });
    expect(start).toHaveBeenCalledWith("coucou-agent-01", expect.any(Function));
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_CHECK_MS);
    expect(start).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith("lima:coucou-agent-01");
    k.stop();
  });

  it("finds Homebrew's limactl when the PATH has none", () => {
    expect(limactlPath({ ORCH_LIMACTL: "/x/limactl" })).toBe("/x/limactl");
    expect(limactlPath({}, (p) => p === "/usr/local/bin/limactl")).toBe("/usr/local/bin/limactl");
    expect(limactlPath({}, () => false)).toBe("limactl");
  });
});

describe("the VM driver in the config", () => {
  it("is Lima on a Mac and WSL elsewhere, unless ORCH_VM_DRIVER says", () => {
    expect(vmDriver({}, "darwin")).toBe("lima");
    expect(vmDriver({}, "win32")).toBe("wsl");
    expect(vmDriver({ ORCH_VM_DRIVER: "wsl" }, "darwin")).toBe("wsl");
    expect(() => vmDriver({ ORCH_VM_DRIVER: "qemu" }, "darwin")).toThrow(/ORCH_VM_DRIVER/);
  });

  it("names a Mac's computers coucou-<id> and reaches them on loopback", () => {
    const config = loadConfig({ HOME: "/Users/u", ORCH_AGENTS: "agent-01,agent-02" }, "darwin");
    expect(config.agents.map((a) => a.vmId)).toEqual(["lima:coucou-agent-01", "lima:coucou-agent-02"]);
    expect(config.workerHost).toBe("127.0.0.1");
    expect(config.dataDir).toBe("/Users/u/Library/Application Support/CoucouOrchestrator");
  });

  it("keeps Windows as it was", () => {
    const config = loadConfig({ LOCALAPPDATA: "C:\\L", ORCH_AGENTS: "agent-01", ORCH_WORKER_HOST: "172.20.0.1" }, "win32");
    expect(config.agents[0]!.vmId).toBe("wsl:agent-01");
    expect(config.workerHost).toBe("172.20.0.1");
  });
});
