// The access tokens: one Coucou presents, and one per agent that its worker
// presents. They live in the Windows Credential Manager under Coucou's own
// service name, so Coucou's Rust side (secrets.rs, same keyring entry format)
// reads the API one, and none ever touches the disk. Created on first use.
//
// Each agent has its own worker token, and the backend knows which agent is
// calling from the token alone: a worker can never act as another agent.
// agent-01 keeps the entry it had before there were several agents.
//
// ORCH_API_TOKEN / ORCH_WORKER_TOKEN (agent-01's) override them, for tests and
// for machines without a credential store.

import { randomBytes, timingSafeEqual } from "node:crypto";

const SERVICE = "fr.louisraille.coucou";
export const API_TOKEN_KEY = "orchestrator-token";
export const WORKER_TOKEN_KEY = "orchestrator-worker-token";

export interface Tokens {
  api: string;
  /** Agent id → that agent's worker token. */
  workers: Map<string, string>;
}

/** The Credential Manager entry holding an agent's worker token. */
export function workerTokenKey(agentId: string): string {
  return agentId === "agent-01" ? WORKER_TOKEN_KEY : `${WORKER_TOKEN_KEY}-${agentId}`;
}

function fresh(): string {
  return randomBytes(32).toString("base64url");
}

async function fromKeyring(key: string): Promise<string> {
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry(SERVICE, key);
  const existing = entry.getPassword();
  if (existing) return existing;
  const token = fresh();
  entry.setPassword(token);
  return token;
}

export async function workerToken(agentId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (agentId === "agent-01" && env.ORCH_WORKER_TOKEN) return env.ORCH_WORKER_TOKEN;
  return fromKeyring(workerTokenKey(agentId));
}

export async function loadTokens(agentIds: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Tokens> {
  const workers = new Map<string, string>();
  for (const id of agentIds) workers.set(id, await workerToken(id, env));
  return { api: env.ORCH_API_TOKEN ?? (await fromKeyring(API_TOKEN_KEY)), workers };
}

/** Constant-time check of an `Authorization: Bearer …` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The agent whose worker token this header carries, or null. Every token is checked, so timing says nothing. */
export function agentForBearer(header: string | undefined, workers: ReadonlyMap<string, string>): string | null {
  let found: string | null = null;
  for (const [id, token] of workers) if (bearerMatches(header, token)) found = id;
  return found;
}
