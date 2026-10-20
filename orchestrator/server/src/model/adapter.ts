// The provider-neutral model interface. The runner only ever talks to this;
// which vendor, CLI or local server answers is the router's business.

export interface ModelInput {
  system: string;
  prompt: string;
  /** JSON Schema for the answer, for providers that can enforce one. */
  jsonSchema?: object;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelOutput {
  /** The answer as text, always set. */
  text: string;
  /** The answer already parsed, when the provider returned structured output. */
  json?: unknown;
}

export interface ModelChunk {
  text: string;
}

export interface ModelAdapter {
  generate(input: ModelInput): Promise<ModelOutput>;
  stream?(input: ModelInput, onChunk: (chunk: ModelChunk) => void): Promise<ModelOutput>;
}

export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  endpoint?: string;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
  };
}

export type ModelErrorCode = "rate_limited" | "unavailable" | "malformed_output" | "timeout" | "cancelled";

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

/**
 * Pulls a JSON object out of a model's text: the whole answer, a ``` fence
 * around it, or the outermost braces in some prose. The whole answer is tried
 * first: a fence inside the JSON (a Markdown report with a code block in its
 * `content`) must not be mistaken for a fence around it.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) if (m[1]) candidates.push(m[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the next reading.
    }
  }
  throw new ModelError("malformed_output", start < 0 ? "no JSON object in the answer" : "the answer is not valid JSON");
}
