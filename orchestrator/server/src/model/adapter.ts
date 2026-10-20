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

/** Pulls a JSON object out of a model's text: bare, or inside a ``` fence. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelError("malformed_output", "no JSON object in the answer");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ModelError("malformed_output", "the answer is not valid JSON");
  }
}
