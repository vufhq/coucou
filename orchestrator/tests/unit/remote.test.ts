// Computers that are not on this PC: how ORCH_AGENTS names one, the SSH
// connection the backend keeps open to it, the worker's calls through a
// socket, and tasks staying on the disk their agent lives on.

import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAgents } from "../../server/src/config.ts";
import { Store } from "../../server/src/store.ts";
import { TUNNEL_RETRY_MS, keepTunnel, tunnelArgs } from "../../server/src/tunnel.ts";
import { BackendClient, BackendError } from "../../worker/src/client.ts";

describe("ORCH_AGENTS with remote computers", () => {
  it("reads agent@host and agent@host:port beside WSL ones", () => {
    expect(parseAgents("agent-01, agent-03@203.0.113.7,agent-04@vm.example.com:2222")).toEqual([
      { id: "agent-01", name: "Agent 01", vmId: "wsl:agent-01" },
      { id: "agent-03", name: "Agent 03", vmId: "ssh:203.0.113.7:22", remote: { host: "203.0.113.7", port: 22 } },
      { id: "agent-04", name: "Agent 04", vmId: "ssh:vm.example.com:2222", remote: { host: "vm.example.com", port: 2222 } },
    ]);
  });

  it("refuses anything ssh could read as an option or more", () => {
    for (const bad of [
      "agent-03@",
      "agent-03@-oProxyCommand=calc",
      "agent-03@host:0",
      "agent-03@host:70000",
      "agent-03@host:22:22",
      "agent-03@user@host",
      "agent-03@host name",
      "agent-03@[::1]",
      "Agent@host",
    ]) {
      expect(() => parseAgents(bad), bad).toThrow(/ORCH_AGENTS/);
    }
  });
});

describe("the backend's connection to a remote computer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks ssh for one forward to the worker's socket, no command and no prompt", () => {
    const args = tunnelArgs({ host: "203.0.113.7", port: 2222 }, { host: "172.20.0.1", port: 47621 }, "C:\\keys\\cloud.key");
    expect(args.slice(0, 2)).toEqual(["-N", "-T"]);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4)).toEqual(["-i", "C:\\keys\\cloud.key", "-o", "IdentitiesOnly=yes"]);
    expect(args.slice(-5)).toEqual(["-p", "2222", "-R", "/workspace/.vufh/backend.sock:172.20.0.1:47621", "agent@203.0.113.7"]);
    expect(tunnelArgs({ host: "h", port: 22 }, { host: "127.0.0.1", port: 1 })).not.toContain("-i");
  });

  it("opens it again when it drops, less and less often, and says why once", async () => {
    const children: (EventEmitter & { stderr: EventEmitter & { setEncoding(): unknown }; kill: ReturnType<typeof vi.fn> })[] = [];
    const spawn = vi.fn(() => {
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => stderr });
      const child = Object.assign(new EventEmitter(), { stderr, kill: vi.fn() });
      children.push(child);
      return child as never;
    });
    const log = vi.fn();
    const fail = (i: number) => {
      children[i]!.stderr.emit("data", "Warning: something\nagent@203.0.113.7: Permission denied (publickey).\n");
      children[i]!.emit("exit", 255);
    };
    const tunnel = keepTunnel("agent-03", { host: "203.0.113.7", port: 22 }, { host: "127.0.0.1", port: 47621 }, log, { spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(tunnel.up()).toBe(false);

    fail(0);
    await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS);
    expect(spawn).toHaveBeenCalledTimes(2);
    fail(1);
    await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS);
    expect(spawn).toHaveBeenCalledTimes(2); // the second wait is twice as long
    await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "connection to agent-03 (203.0.113.7) ended: agent@203.0.113.7: Permission denied (publickey).; trying again",
    );

    // It holds: up after a while, and a later drop is said again and retried soon.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tunnel.up()).toBe(true);
    children[2]!.emit("exit", 255);
    expect(tunnel.up()).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TUNNEL_RETRY_MS);
    expect(spawn).toHaveBeenCalledTimes(4);

    tunnel.stop();
    expect(children[3]!.kill).toHaveBeenCalled();
    children[3]!.emit("exit", null);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(4);
  });
});

describe("the worker's calls through a socket", () => {
  let server: Server;
  let dir: string;
  let path: string;
  const seen: { method?: string; url?: string; auth?: string; type?: string; body: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    dir = mkdtempSync(join(tmpdir(), "orch-sock-"));
    // Windows has no socket files for Node: a named pipe stands in for one.
    path = process.platform === "win32" ? `\\\\.\\pipe\\orch-sock-${process.pid}-${Date.now()}` : join(dir, "backend.sock");
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          type: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.url?.startsWith("/worker/v1/hello")) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, leaseMs: 15_000, retentionDays: 30 }));
        } else if (req.method === "GET") {
          res.end(Buffer.from([0, 1, 2, 255]));
        } else {
          res.statusCode = 409;
          res.end("no such job");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts, downloads and reports refusals as it does by address", async () => {
    const client = new BackendClient("http://backend", "tok", "agent-03", path);
    const hello = await client.hello({ agentId: "agent-03", version: "0.6.1", capabilities: [], journal: [] });
    expect(hello).toMatchObject({ leaseMs: 15_000, retentionDays: 30 });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/worker/v1/hello", auth: "Bearer tok", type: "application/json" });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ agentId: "agent-03" });

    expect([...(await client.download("job-1"))]).toEqual([0, 1, 2, 255]);
    expect(seen[1]).toMatchObject({ method: "GET", url: "/worker/v1/jobs/job-1/file?agentId=agent-03" });

    const refused = await client.complete("job-1", { status: "succeeded", result: "ok" }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(BackendError);
    expect((refused as BackendError).status).toBe(409);
  });
});

describe("tasks stay on the disk their agent lives on", () => {
  it("groups the WSL computers and leaves each remote one alone", () => {
    const store = new Store(":memory:");
    try {
      store.useComputers([
        { id: "agent-01", vmId: "wsl:agent-01" },
        { id: "agent-02", vmId: "wsl:agent-02" },
        { id: "agent-03", vmId: "ssh:203.0.113.7:22" },
        { id: "agent-04", vmId: "ssh:203.0.113.8:22" },
      ]);
      const ids = (id: string | null) => store.sameDisk(id).map((c) => c.id);
      expect(ids("agent-01")).toEqual(["agent-01", "agent-02"]);
      expect(ids("agent-02")).toEqual(["agent-01", "agent-02"]);
      expect(ids("agent-03")).toEqual(["agent-03"]);
      expect(ids("agent-04")).toEqual(["agent-04"]);
      expect(ids(null)).toHaveLength(4);
    } finally {
      store.close();
    }
  });
});
