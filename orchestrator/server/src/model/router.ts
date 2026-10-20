// Picks the adapter for a task's model profile, with an explicit fallback
// order. Only failures that another model could fix move to the next one:
// a malformed answer or a cancellation never does.

import { ModelError, type ModelAdapter, type ModelInput, type ModelOutput, type ModelProfile } from "./adapter.ts";

export interface RoutedProfile {
  profile: ModelProfile;
  adapter: ModelAdapter;
}

const FALLS_THROUGH: ReadonlySet<string> = new Set(["rate_limited", "unavailable"]);

export class ModelRouter {
  private readonly profiles = new Map<string, RoutedProfile>();
  private readonly fallbacks = new Map<string, string[]>();

  register(profile: ModelProfile, adapter: ModelAdapter, fallbacks: string[] = []): void {
    this.profiles.set(profile.id, { profile, adapter });
    this.fallbacks.set(profile.id, fallbacks);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  list(): (ModelProfile & { fallbacks: string[] })[] {
    return [...this.profiles.values()].map((p) => ({ ...p.profile, fallbacks: this.fallbacks.get(p.profile.id) ?? [] }));
  }

  async generate(profileId: string, input: ModelInput): Promise<ModelOutput & { profileId: string }> {
    const order = [profileId, ...(this.fallbacks.get(profileId) ?? [])];
    let last: unknown = new ModelError("unavailable", `unknown model profile ${profileId}`);
    for (const id of order) {
      const routed = this.profiles.get(id);
      if (!routed) continue;
      try {
        return { ...(await routed.adapter.generate(input)), profileId: id };
      } catch (err) {
        last = err;
        if (!(err instanceof ModelError) || !FALLS_THROUGH.has(err.code)) throw err;
      }
    }
    throw last;
  }
}

export const CLAUDE_CLI_PROFILE: ModelProfile = {
  id: "claude-cli",
  provider: "claude-code-cli",
  model: "default",
  capabilities: { streaming: false, toolCalling: false, structuredOutput: true },
};

/** No schema flag: the schema travels in the prompt and the answer is parsed from text. */
export const CURSOR_CLI_PROFILE: ModelProfile = {
  id: "cursor-cli",
  provider: "cursor-agent-cli",
  model: "default",
  capabilities: { streaming: false, toolCalling: false, structuredOutput: false },
};
