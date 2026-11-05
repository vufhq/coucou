// The user's GitHub account, through their own GitHub App and the device
// flow: Coucou shows a code, the user enters it on github.com, and the tokens
// land in the Windows Credential Manager. No client secret exists (the client
// id is public), so refreshing needs none either. The tokens never reach a
// model, the database, an event or a log: a git.* job gets the access token
// at claim time, for that one job, and redaction knows its value.

import { addSecret } from "./redact.ts";

const SERVICE = "fr.louisraille.coucou";
export const GITHUB_KEY = "orchestrator-github";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** A token with less than this left is refreshed before use. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Where the tokens are kept: one Credential Manager entry, as JSON. */
export interface SecretSlot {
  read(): string | null;
  write(value: string): void;
  delete(): void;
}

export async function keyringSlot(key = GITHUB_KEY): Promise<SecretSlot> {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry(SERVICE, key);
  return {
    read: () => entry.getPassword() ?? null,
    write: (value) => entry.setPassword(value),
    delete: () => {
      entry.deletePassword();
    },
  };
}

/** A slot in memory, for tests and machines without a credential store. */
export function memorySlot(initial: string | null = null): SecretSlot {
  let value = initial;
  return {
    read: () => value,
    write: (v) => {
      value = v;
    },
    delete: () => {
      value = null;
    },
  };
}

interface Stored {
  access: string;
  /** Epoch ms; null when the app's tokens don't expire. */
  accessExpiresAt: number | null;
  refresh: string | null;
  refreshExpiresAt: number | null;
  login: string;
}

export interface GithubStatus {
  /** ORCH_GITHUB_CLIENT_ID is set. */
  configured: boolean;
  connected: boolean;
  login: string | null;
  /** A sign-in waiting for the user on github.com. */
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
  /** Why the last sign-in or refresh failed. */
  error: string | null;
}

export class GithubError extends Error {}

type Fetch = typeof fetch;

export interface GithubOptions {
  clientId?: string;
  slot: SecretSlot;
  fetch?: Fetch;
  now?: () => number;
  /** Waits between polls; real time by default. */
  sleep?: (ms: number) => Promise<void>;
}

export class Github {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stored: Stored | null;
  private pending: (GithubStatus["pending"] & { deviceCode: string; intervalMs: number; flow: number }) | null = null;
  private error: string | null = null;
  /** Bumped by every connect/disconnect: an older poll stops. */
  private flow = 0;
  private refreshing: Promise<string | null> | null = null;

  private readonly o: GithubOptions;

  constructor(o: GithubOptions) {
    this.o = o;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.stored = parseStored(safeRead(o.slot));
    if (this.stored) remember(this.stored);
  }

  status(): GithubStatus {
    const p = this.pending;
    return {
      configured: Boolean(this.o.clientId),
      connected: this.connected(),
      login: this.stored?.login ?? null,
      pending: p ? { userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt } : null,
      error: this.error,
    };
  }

  /** Signed in, with a token that works or can be refreshed. */
  connected(): boolean {
    const s = this.stored;
    if (!s) return false;
    const now = this.now();
    const accessOk = s.accessExpiresAt === null || s.accessExpiresAt > now;
    const refreshOk = s.refresh !== null && (s.refreshExpiresAt === null || s.refreshExpiresAt > now);
    return accessOk || refreshOk;
  }

  /** Starts a sign-in: the code to show, and a poll in the background until the user is done. */
  async connect(): Promise<NonNullable<GithubStatus["pending"]>> {
    const clientId = this.o.clientId;
    if (!clientId) throw new GithubError("ORCH_GITHUB_CLIENT_ID is not set");
    const body = await this.post(DEVICE_CODE_URL, { client_id: clientId });
    const deviceCode = str(body.device_code);
    const userCode = str(body.user_code);
    const verificationUri = str(body.verification_uri);
    if (!deviceCode || !userCode || !verificationUri.startsWith("https://github.com/")) {
      throw new GithubError(str(body.error_description) || str(body.error) || "GitHub did not start the sign-in");
    }
    const flow = ++this.flow;
    const expiresAt = new Date(this.now() + num(body.expires_in, 900) * 1000).toISOString();
    this.pending = { deviceCode, userCode, verificationUri, expiresAt, intervalMs: num(body.interval, 5) * 1000, flow };
    this.error = null;
    void this.poll(flow).catch((err: unknown) => {
      if (this.flow !== flow) return;
      this.pending = null;
      this.error = err instanceof Error ? err.message : String(err);
    });
    return { userCode, verificationUri, expiresAt };
  }

  /** Forgets the tokens. Revoking them is on github.com (the app's settings). */
  disconnect(): void {
    this.flow++;
    this.pending = null;
    this.error = null;
    this.stored = null;
    try {
      this.o.slot.delete();
    } catch {
      // Nothing stored.
    }
  }

  /** A working access token, refreshed if it is about to expire; null when not signed in. */
  async token(): Promise<string | null> {
    const s = this.stored;
    if (!s) return null;
    if (s.accessExpiresAt === null || s.accessExpiresAt - REFRESH_MARGIN_MS > this.now()) return s.access;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string | null> {
    const s = this.stored;
    const clientId = this.o.clientId;
    if (!s?.refresh || !clientId || (s.refreshExpiresAt !== null && s.refreshExpiresAt <= this.now())) {
      return s && (s.accessExpiresAt === null || s.accessExpiresAt > this.now()) ? s.access : null;
    }
    const body = await this.post(TOKEN_URL, { client_id: clientId, grant_type: "refresh_token", refresh_token: s.refresh });
    if (!str(body.access_token)) {
      this.error = `GitHub refused to refresh the sign-in (${str(body.error) || "unknown"}): sign in again`;
      if (str(body.error) === "bad_refresh_token") this.disconnectKeepingError();
      return null;
    }
    this.save(body, s.login);
    return this.stored!.access;
  }

  private disconnectKeepingError(): void {
    const error = this.error;
    this.disconnect();
    this.error = error;
  }

  private async poll(flow: number): Promise<void> {
    for (;;) {
      const p = this.pending;
      if (!p || p.flow !== flow || this.flow !== flow) return;
      if (Date.parse(p.expiresAt) <= this.now()) throw new GithubError("the sign-in code expired: try again");
      await this.sleep(p.intervalMs);
      if (this.flow !== flow) return;
      const body = await this.post(TOKEN_URL, { client_id: this.o.clientId!, device_code: p.deviceCode, grant_type: DEVICE_GRANT });
      if (this.flow !== flow) return;
      if (str(body.access_token)) {
        const login = await this.login(str(body.access_token));
        if (this.flow !== flow) return;
        this.save(body, login);
        this.pending = null;
        return;
      }
      switch (str(body.error)) {
        case "authorization_pending":
          continue;
        case "slow_down":
          p.intervalMs = Math.max(p.intervalMs + 5_000, num(body.interval, 0) * 1000);
          continue;
        case "expired_token":
          throw new GithubError("the sign-in code expired: try again");
        case "access_denied":
          throw new GithubError("the sign-in was cancelled on GitHub");
        default:
          throw new GithubError(str(body.error_description) || str(body.error) || "GitHub refused the sign-in");
      }
    }
  }

  private async login(access: string): Promise<string> {
    addSecret(access);
    const res = await this.fetch(USER_URL, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${access}`, "User-Agent": "coucou-orchestrator" },
    });
    if (!res.ok) throw new GithubError(`GitHub did not say who signed in (HTTP ${res.status})`);
    const login = str(((await res.json()) as Record<string, unknown>).login);
    if (!login) throw new GithubError("GitHub did not say who signed in");
    return login;
  }

  private save(body: Record<string, unknown>, login: string): void {
    const now = this.now();
    const expiresIn = num(body.expires_in, 0);
    const refreshIn = num(body.refresh_token_expires_in, 0);
    const stored: Stored = {
      access: str(body.access_token),
      accessExpiresAt: expiresIn > 0 ? now + expiresIn * 1000 : null,
      refresh: str(body.refresh_token) || null,
      refreshExpiresAt: refreshIn > 0 ? now + refreshIn * 1000 : null,
      login,
    };
    remember(stored);
    this.o.slot.write(JSON.stringify(stored));
    this.stored = stored;
    this.error = null;
  }

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "coucou-orchestrator" },
      body: new URLSearchParams(form).toString(),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: reported below.
    }
    if (!body || typeof body !== "object") throw new GithubError(`GitHub answered HTTP ${res.status}`);
    return body as Record<string, unknown>;
  }
}

/** Every form of a token a log could carry: itself, and inside git's Basic header. */
function remember(s: Stored): void {
  for (const value of [s.access, s.refresh]) {
    if (!value) continue;
    addSecret(value);
    addSecret(gitBasicAuth(value));
  }
}

/** The value git sends in `Authorization: basic …` for a GitHub token. */
export function gitBasicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

function safeRead(slot: SecretSlot): string | null {
  try {
    return slot.read();
  } catch {
    return null;
  }
}

function parseStored(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.access !== "string" || !v.access || typeof v.login !== "string") return null;
    return {
      access: v.access,
      accessExpiresAt: typeof v.accessExpiresAt === "number" ? v.accessExpiresAt : null,
      refresh: typeof v.refresh === "string" && v.refresh ? v.refresh : null,
      refreshExpiresAt: typeof v.refreshExpiresAt === "number" ? v.refreshExpiresAt : null,
      login: v.login,
    };
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
