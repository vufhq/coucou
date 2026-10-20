import { ModelError, extractJson, type ModelAdapter, type ModelInput, type ModelOutput } from "./adapter.ts";

export interface OpenAICompatibleOptions {
  endpoint: string;
  model: string;
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("");
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = { "Content-Type": "application/json" };
      const response = await fetch(`${this.options.endpoint.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
          temperature: 0,
          ...(input.jsonSchema
            ? { response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: input.jsonSchema } } }
            : {}),
        }),
        signal: controller.signal,
      });
      if (response.status === 429) throw new ModelError("rate_limited", "the local model server is rate limited");
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        throw new ModelError(response.status >= 500 ? "unavailable" : "malformed_output", `local model HTTP ${response.status}${text ? `: ${text}` : ""}`);
      }
      const body = (await response.json()) as ChatResponse;
      const text = content(body.choices?.[0]?.message?.content);
      if (!text) throw new ModelError("malformed_output", "the local model returned no answer");
      return { text, json: extractJson(text) };
    } catch (err) {
      if (err instanceof ModelError) throw err;
      if (input.signal?.aborted) throw new ModelError("cancelled", "cancelled");
      if (controller.signal.aborted) throw new ModelError("timeout", `no answer within ${Math.round(input.timeoutMs / 1000)} s`);
      if (err instanceof TypeError) throw new ModelError("unavailable", `could not reach local model: ${err.message}`);
      throw new ModelError("unavailable", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
