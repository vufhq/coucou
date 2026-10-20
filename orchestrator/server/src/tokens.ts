// The two access tokens: one Coucou presents, one the worker presents. They
// live in the Windows Credential Manager under Coucou's own service name, so
// Coucou's Rust side (secrets.rs, same keyring entry format) reads the same
// one, and neither ever touches the disk. Created on first start.
//
// ORCH_API_TOKEN / ORCH_WORKER_TOKEN override them, for tests and for
// machines without a credential store.

import { randomBytes, timingSafeEqual } from "node:crypto";

const SERVICE = "fr.louisraille.coucou";
export const API_TOKEN_KEY = "orchestrator-token";
export const WORKER_TOKEN_KEY = "orchestrator-worker-token";

export interface Tokens {
  api: string;
  worker: string;
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

export async function loadTokens(env: NodeJS.ProcessEnv = process.env): Promise<Tokens> {
  return {
    api: env.ORCH_API_TOKEN ?? (await fromKeyring(API_TOKEN_KEY)),
    worker: env.ORCH_WORKER_TOKEN ?? (await fromKeyring(WORKER_TOKEN_KEY)),
  };
}

/** Constant-time check of an `Authorization: Bearer …` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
