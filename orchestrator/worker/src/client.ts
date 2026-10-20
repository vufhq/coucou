// The worker's half of the worker protocol: plain fetch, a bearer token,
// every answer validated before it is believed.

import {
  ClaimResponse,
  HeartbeatResponse,
  type Hello,
  type JobOutcome,
  type WorkerEvent,
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
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new BackendError(res.status, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  hello(hello: Hello): Promise<unknown> {
    return this.post("/worker/v1/hello", hello, 10_000);
  }

  async claim(waitMs: number): Promise<ClaimResponse> {
    return ClaimResponse.parse(await this.post("/worker/v1/jobs/claim", { agentId: this.agentId }, waitMs + 10_000));
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
