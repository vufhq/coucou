// The worker's half of the worker protocol: plain HTTP, a bearer token,
// every answer validated before it is believed. On the PC's own computers the
// backend is at an address (fetch); on a remote one it is behind a socket the
// backend's SSH connection opens (ORCH_BACKEND_SOCKET), which fetch cannot
// use, so those calls go through node:http.

import { request } from "node:http";

import {
  ClaimResponse,
  HeartbeatResponse,
  HelloResponse,
  type Hello,
  type JobOutcome,
  type WorkerEvent,
  type WorkerHealth,
} from "@vufh-orchestrator/protocol";

export class BackendError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BackendClient {
  private readonly base: string;
  private readonly token: string;
  readonly agentId: string;
  private readonly socketPath: string | undefined;

  /** `socketPath`: the backend is behind this socket, and `base` is not used. */
  constructor(base: string, token: string, agentId: string, socketPath?: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
    this.agentId = agentId;
    this.socketPath = socketPath;
  }

  /** One call, by address or through the socket. */
  private async send(
    method: "GET" | "POST",
    path: string,
    body: { type: string; bytes: Uint8Array } | null,
    timeoutMs: number,
  ): Promise<{ status: number; bytes: Buffer }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body) headers["Content-Type"] = body.type;
    const signal = AbortSignal.timeout(timeoutMs);
    if (!this.socketPath) {
      const res = await fetch(`${this.base}${path}`, { method, headers, body: body?.bytes, signal });
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    }
    if (body) headers["Content-Length"] = String(body.bytes.byteLength);
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method, headers, signal }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end(body?.bytes);
    });
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const binary = body instanceof Uint8Array;
    const res = await this.send(
      "POST",
      path,
      binary
        ? { type: "application/octet-stream", bytes: body }
        : { type: "application/json", bytes: Buffer.from(JSON.stringify(body)) },
      timeoutMs,
    );
    const text = res.bytes.toString("utf8");
    if (res.status < 200 || res.status > 299) throw new BackendError(res.status, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async hello(hello: Hello): Promise<{ leaseMs: number; retentionDays: number }> {
    return HelloResponse.parse(await this.post("/worker/v1/hello", hello, 10_000));
  }

  async claim(waitMs: number, health?: WorkerHealth): Promise<ClaimResponse> {
    const body = health ? { agentId: this.agentId, health } : { agentId: this.agentId };
    return ClaimResponse.parse(await this.post("/worker/v1/jobs/claim", body, waitMs + 10_000));
  }

  /** The bytes of a file download job, sent before the job is completed. */
  async upload(jobId: string, bytes: Uint8Array): Promise<void> {
    await this.post(`/worker/v1/jobs/${encodeURIComponent(jobId)}/file?agentId=${this.agentId}`, bytes, 60_000);
  }

  /** The bytes of a file the user attached, for an fs.receive job. */
  async download(jobId: string): Promise<Buffer> {
    const res = await this.send("GET", `/worker/v1/jobs/${encodeURIComponent(jobId)}/file?agentId=${this.agentId}`, null, 120_000);
    if (res.status < 200 || res.status > 299) {
      throw new BackendError(res.status, `file: HTTP ${res.status} ${res.bytes.toString("utf8").slice(0, 200)}`);
    }
    return res.bytes;
  }

  async heartbeat(running: string[]): Promise<string[]> {
    const out = HeartbeatResponse.parse(await this.post("/worker/v1/heartbeat", { agentId: this.agentId, running }, 10_000));
    return out.cancel;
  }

  async events(jobId: string, events: WorkerEvent[]): Promise<void> {
    await this.post(`/worker/v1/jobs/${encodeURIComponent(jobId)}/events?agentId=${this.agentId}`, { events }, 10_000);
  }

  async complete(jobId: string, outcome: JobOutcome): Promise<void> {
    await this.post(`/worker/v1/jobs/${encodeURIComponent(jobId)}/complete?agentId=${this.agentId}`, outcome, 10_000);
  }
}
