// The worker's half of the worker protocol: plain fetch, a bearer token,
// every answer validated before it is believed.

import {
  ClaimResponse,
  HeartbeatResponse,
  HelloResponse,
  type Hello,
  type JobOutcome,
  type WorkerEvent,
  type WorkerHealth,
} from "@coucou-orchestrator/protocol";

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

  constructor(base: string, token: string, agentId: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
    this.agentId = agentId;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const binary = body instanceof Uint8Array;
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": binary ? "application/octet-stream" : "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: binary ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new BackendError(res.status, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
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
    const res = await fetch(`${this.base}/worker/v1/jobs/${encodeURIComponent(jobId)}/file?agentId=${this.agentId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new BackendError(res.status, `file: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
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
