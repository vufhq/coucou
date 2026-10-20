// Redaction runs once, on the way into the event log, so nothing below it —
// the database, the SSE stream, Coucou's timeline, the model's next prompt —
// can carry a secret it picked up from a page or a command.

const REPLACEMENT = "[redacted]";

const PATTERNS: RegExp[] = [
  // Provider keys and tokens with a recognisable prefix.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // PEM private keys.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `Authorization: …`, `Cookie: …`, `password=…` and friends keep their name, lose their value. */
const KEY_VALUE =
  /\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;

/** `https://user:pass@host` and token-like query parameters. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const URL_SECRET_PARAM =
  /([?&](?:access_token|token|key|api_key|apikey|sig|signature|secret|password|code|auth)=)[^&#\s]+/gi;

/** `Bearer <token>` / `Basic <token>`: the scheme stays, the credential goes. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

export function redactText(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REPLACEMENT);
  out = out.replace(AUTH_SCHEME, `$1 ${REPLACEMENT}`);
  out = out.replace(KEY_VALUE, `$1${REPLACEMENT}`);
  out = out.replace(URL_CREDENTIALS, `$1${REPLACEMENT}@`);
  out = out.replace(URL_SECRET_PARAM, `$1${REPLACEMENT}`);
  return out;
}

/** Every string in a JSON-like value, redacted. Object keys are left alone. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out as T;
  }
  return value;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
