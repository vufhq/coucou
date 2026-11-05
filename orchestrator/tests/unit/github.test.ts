import { describe, expect, it } from "vitest";
import { Github, gitBasicAuth, memorySlot } from "../../server/src/github.ts";
import { decide, type GithubContext } from "../../server/src/policy.ts";
import { redactText } from "../../server/src/redact.ts";
import { gitEnv } from "../../worker/src/ops/git.ts";

/** A fake github.com: answers in order, records what was asked. */
function fakeFetch(answers: Record<string, unknown[]>) {
  const asked: { url: string; body: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    asked.push({ url, body: String(init?.body ?? ""), auth: headers.get("authorization") });
    const queue = answers[url];
    const next = queue?.shift();
    if (next === undefined) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const DEVICE = "https://github.com/login/device/code";
const TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";

describe("GitHub sign-in", () => {
  it("runs the device flow: pending, slow down, then tokens in the slot", async () => {
    let now = 1_000_000;
    const slept: number[] = [];
    const slot = memorySlot();
    const { fetch, asked } = fakeFetch({
      [DEVICE]: [{ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }],
      [TOKEN]: [
        { error: "authorization_pending" },
        { error: "slow_down", interval: 10 },
        { access_token: "ghu_accessAAAAAAAAAAAAAAAA", expires_in: 28_800, refresh_token: "ghr_refreshBBBBBBBBBBBBBBBB", refresh_token_expires_in: 15_811_200 },
      ],
      [USER]: [{ login: "octo" }],
    });
    const gh = new Github({
      clientId: "Iv23test",
      slot,
      fetch,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    expect(gh.status()).toMatchObject({ configured: true, connected: false });
    const pending = await gh.connect();
    expect(pending).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    for (let i = 0; i < 50 && !gh.connected(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(gh.status()).toMatchObject({ connected: true, login: "octo", pending: null, error: null });
    expect(slept).toEqual([5_000, 5_000, 10_000]);
    expect(asked.find((a) => a.url === USER)?.auth).toBe("Bearer ghu_accessAAAAAAAAAAAAAAAA");
    // No client secret is ever sent.
    expect(asked.every((a) => !a.body.includes("client_secret"))).toBe(true);
    expect(JSON.parse(slot.read()!)).toMatchObject({ access: "ghu_accessAAAAAAAAAAAAAAAA", login: "octo" });
    expect(await gh.token()).toBe("ghu_accessAAAAAAAAAAAAAAAA");
    // Its value is redacted wherever it shows up, raw or inside git's Basic header.
    expect(redactText("x ghu_accessAAAAAAAAAAAAAAAA y")).not.toContain("ghu_access");
    expect(redactText(gitBasicAuth("ghu_accessAAAAAAAAAAAAAAAA"))).toBe("[redacted]");
  });

  it("refreshes a token about to expire, without a client secret", async () => {
    let now = 0;
    const slot = memorySlot(
      JSON.stringify({ access: "old-access-1234", accessExpiresAt: 60_000, refresh: "old-refresh-1234", refreshExpiresAt: 10_000_000, login: "octo" }),
    );
    const { fetch, asked } = fakeFetch({ [TOKEN]: [{ access_token: "new-access-1234", expires_in: 28_800, refresh_token: "new-refresh-1234" }] });
    const gh = new Github({ clientId: "Iv23test", slot, fetch, now: () => now });
    expect(await gh.token()).toBe("new-access-1234");
    expect(asked[0]!.body).toContain("grant_type=refresh_token");
    expect(asked[0]!.body).not.toContain("client_secret");
    now = 1_000;
    expect(await gh.token()).toBe("new-access-1234");
    expect(asked).toHaveLength(1);
  });

  it("signs out when GitHub rejects the refresh token, and says why", async () => {
    const slot = memorySlot(JSON.stringify({ access: "a-123456789", accessExpiresAt: 1, refresh: "r-123456789", refreshExpiresAt: null, login: "octo" }));
    const { fetch } = fakeFetch({ [TOKEN]: [{ error: "bad_refresh_token" }] });
    const gh = new Github({ clientId: "Iv23test", slot, fetch, now: () => 10 });
    expect(await gh.token()).toBeNull();
    expect(gh.status()).toMatchObject({ connected: false });
    expect(gh.status().error).toContain("sign in again");
    expect(slot.read()).toBeNull();
  });

  it("reports a cancelled sign-in", async () => {
    const { fetch } = fakeFetch({
      [DEVICE]: [{ device_code: "d", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }],
      [TOKEN]: [{ error: "access_denied" }],
    });
    const gh = new Github({ clientId: "Iv23test", slot: memorySlot(), fetch, sleep: async () => {} });
    await gh.connect();
    for (let i = 0; i < 50 && !gh.status().error; i++) await new Promise((r) => setTimeout(r, 1));
    expect(gh.status()).toMatchObject({ connected: false, pending: null, error: "the sign-in was cancelled on GitHub" });
  });

  it("can't start without a client id", async () => {
    await expect(new Github({ slot: memorySlot() }).connect()).rejects.toThrow("ORCH_GITHUB_CLIENT_ID");
  });
});

describe("the GitHub policy", () => {
  const gh = (over: Partial<GithubContext> = {}): GithubContext => ({
    allowed: true,
    connected: true,
    repos: { "octo/demo": "trunk" },
    pushesToday: 0,
    pushBudget: 10,
    ...over,
  });
  const verdict = (op: "git.clone" | "git.push", args: Record<string, unknown>, ruleLevel: 1 | 2 | 3 | 4, github = gh()) =>
    decide({ op, args }, { approvedDomains: [], ruleLevel, github });
  const push = (branch: string) => ({ repo: "octo/demo", dir: "demo", branch });

  it("refuses without the sign-in or the agent's switch, at every level", () => {
    for (const level of [1, 2, 3, 4] as const) {
      expect(verdict("git.clone", { repo: "octo/new", dir: "x" }, level, gh({ connected: false })).verdict).toBe("deny");
      expect(verdict("git.push", push("f"), level, gh({ allowed: false })).verdict).toBe("deny");
      expect(decide({ op: "git.push", args: push("f") }, { approvedDomains: [], ruleLevel: level }).verdict).toBe("deny");
    }
  });

  it("asks before the first clone of a repo at levels 1–2, not at 3–4", () => {
    expect(verdict("git.clone", { repo: "octo/new", dir: "x" }, 1).verdict).toBe("approve");
    expect(verdict("git.clone", { repo: "octo/new", dir: "x" }, 2).verdict).toBe("approve");
    expect(verdict("git.clone", { repo: "octo/demo", dir: "x" }, 2).verdict).toBe("allow");
    expect(verdict("git.clone", { repo: "octo/demo", dir: "x" }, 1).verdict).toBe("approve");
    expect(verdict("git.clone", { repo: "octo/new", dir: "x" }, 3).verdict).toBe("allow");
    expect(verdict("git.clone", { repo: "octo/new", dir: "x" }, 4).verdict).toBe("allow");
  });

  it("asks before a push at 1–2, at 3 only past the budget, never at 4", () => {
    expect(verdict("git.push", push("f"), 1).verdict).toBe("approve");
    expect(verdict("git.push", push("f"), 2).verdict).toBe("approve");
    expect(verdict("git.push", push("f"), 3).verdict).toBe("allow");
    expect(verdict("git.push", push("f"), 3, gh({ pushesToday: 10 })).verdict).toBe("approve");
    expect(verdict("git.push", push("f"), 4, gh({ pushesToday: 99 })).verdict).toBe("allow");
  });

  it("always asks before a push to the default branch, main or master", () => {
    for (const level of [1, 2, 3, 4] as const) {
      for (const branch of ["trunk", "main", "master"]) expect(verdict("git.push", push(branch), level).verdict).toBe("approve");
    }
  });

  it("only pushes a repo the agent cloned", () => {
    expect(verdict("git.push", { repo: "octo/other", dir: "demo", branch: "f" }, 4).verdict).toBe("deny");
  });
});

describe("git's environment", () => {
  it("carries the token in git's own header for github.com only, with config, hooks and helpers off", () => {
    const env = gitEnv("/tmp/h", "ghu_canary123456", ["https"]);
    const pairs = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
    );
    expect(pairs["http.https://github.com/.extraheader"]).toBe(`AUTHORIZATION: basic ${gitBasicAuth("ghu_canary123456")}`);
    expect(pairs).toMatchObject({ "credential.helper": "", "protocol.allow": "never", "protocol.https.allow": "always", "core.fsmonitor": "false" });
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(Object.values(gitEnv("/tmp/h", null, ["https"])).join(" ")).not.toContain("extraheader");
  });
});
