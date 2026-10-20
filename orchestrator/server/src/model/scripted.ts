// A model that answers from a script, for tests and for trying the pipeline
// without spending a subscription. Each call takes the next answer; a
// function answer sees the prompt, so a test can react to what the runner
// told the model.

import { ModelError, type ModelAdapter, type ModelInput, type ModelOutput } from "./adapter.ts";

export type ScriptedAnswer =
  | ((input: ModelInput) => unknown)
  | ModelError
  | Record<string, unknown>
  | string;

export class ScriptedModel implements ModelAdapter {
  readonly calls: ModelInput[] = [];
  private readonly answers: ScriptedAnswer[];

  constructor(answers: ScriptedAnswer[]) {
    this.answers = [...answers];
  }

  async generate(input: ModelInput): Promise<ModelOutput> {
    this.calls.push(input);
    const next = this.answers.shift();
    if (next === undefined) throw new ModelError("unavailable", "script exhausted");
    if (next instanceof ModelError) throw next;
    const value = typeof next === "function" ? await (next as (i: ModelInput) => unknown)(input) : next;
    if (value instanceof ModelError) throw value;
    return { text: JSON.stringify(value), json: value };
  }
}
