import { describe, expect, it } from "vitest";
import { redact, redactText } from "../../server/src/redact.ts";
import { decide, domainOf } from "../../server/src/policy.ts";

describe("redaction", () => {
  it.each([
    ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA end", "sk-ant-api03"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123 here", "ghp_abcdef"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["Cookie: session=deadbeef; theme=dark", "deadbeef"],
    ["password=hunter2&x=1", "hunter2"],
    ["https://bob:s3cret@example.com/x", "s3cret"],
    ["https://api.example.com/v1?access_token=XYZ123&page=2", "XYZ123"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["curl -H 'Authorization: Bearer 0a1b2c3d4e5f'", "0a1b2c3d4e5f"],
    ["use Token abcdef_ghijkl", "abcdef_ghijkl"],
  ])("removes the secret from %s", (text, secret) => {
    const out = redactText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("keeps ordinary text and nested structure", () => {
    expect(redactText("pip install requests")).toBe("pip install requests");
    // A heading from a real report, once wrongly cut to "Basic [redacted]".
    for (const prose of ["## Basic installation", "Bearer bonds.", "Token budget remaining", "basic authentication"]) {
      expect(redactText(prose)).toBe(prose);
    }
    expect(redact({ a: ["x", { b: "sk-proj-ZZZZZZZZZZZZZZZZZZZZ" }], n: 3 })).toEqual({ a: ["x", { b: "[redacted]" }], n: 3 });
  });
});

describe("policy", () => {
  const ctx = { approvedDomains: ["python.org"] };
  const nav = (url: string) => decide({ op: "browser.navigate", args: { url } }, ctx);

  it("asks before the first visit to a domain, then lets it through", () => {
    expect(nav("https://docs.python.org/3/")).toEqual({ verdict: "allow" });
    expect(nav("https://pypi.org/project/x")).toMatchObject({ verdict: "approve", reason: "first visit to pypi.org" });
  });

  it("never lets the browser reach the host, the LAN or credentials in a URL", () => {
    expect(nav("http://127.0.0.1:47621/worker/v1/hello").verdict).toBe("deny");
    expect(nav("http://192.168.1.10/").verdict).toBe("deny");
    expect(nav("https://user:pw@python.org/").verdict).toBe("deny");
  });

  it("runs read-only commands and asks for the rest", () => {
    const run = (...argv: string[]) => decide({ op: "terminal.run", args: { argv } }, ctx).verdict;
    expect(run("ls", "-la")).toBe("allow");
    expect(run("cat", "report.md")).toBe("allow");
    expect(run("rm", "-rf", "x")).toBe("approve");
    expect(run("pip", "install", "x")).toBe("approve");
    expect(run("/bin/ls")).toBe("approve");
  });

  it("never runs a download as a model's step", () => {
    expect(decide({ op: "fs.fetch", args: { path: "a.png" } }, ctx).verdict).toBe("deny");
  });

  it("runs shell commands on the computer without a click", () => {
    expect(decide({ op: "terminal.shell", args: { command: "pip install x && python3 main.py" } }, ctx).verdict).toBe("allow");
  });

  it("writes and overwrites files without a click", () => {
    expect(decide({ op: "fs.write_artifact", args: { path: "a.md", content: "" } }, ctx).verdict).toBe("allow");
    expect(decide({ op: "fs.write_artifact", args: { path: "a.md", content: "", overwrite: true } }, ctx).verdict).toBe("allow");
  });

  it("approves whole sites, not single hosts", () => {
    expect(domainOf("docs.python.org")).toBe("python.org");
    expect(domainOf("www.bbc.co.uk")).toBe("bbc.co.uk");
  });
});

describe("rule levels", () => {
  const at = (ruleLevel: 1 | 2 | 3 | 4) => ({ approvedDomains: ["python.org"], ruleLevel });
  const verdict = (op: string, args: Record<string, unknown>, level: 1 | 2 | 3 | 4) =>
    decide({ op, args } as Parameters<typeof decide>[0], at(level)).verdict;

  it("asks before every action at level 1, reading aside", () => {
    expect(verdict("terminal.shell", { command: "ls" }, 1)).toBe("approve");
    expect(verdict("fs.write_artifact", { path: "a.md", content: "" }, 1)).toBe("approve");
    expect(verdict("terminal.run", { argv: ["ls"] }, 1)).toBe("approve");
    expect(verdict("browser.navigate", { url: "https://docs.python.org/" }, 1)).toBe("approve");
    expect(verdict("fs.read", { path: "a.md" }, 1)).toBe("allow");
    expect(verdict("browser.extract_text", {}, 1)).toBe("allow");
  });

  it("keeps today's rules at level 2, the default", () => {
    expect(verdict("terminal.shell", { command: "ls" }, 2)).toBe("allow");
    expect(verdict("browser.navigate", { url: "https://pypi.org/" }, 2)).toBe("approve");
    expect(decide({ op: "browser.navigate", args: { url: "https://pypi.org/" } }, { approvedDomains: [] }).verdict).toBe("approve");
  });

  it("lets new sites and commands through at levels 3 and 4", () => {
    for (const level of [3, 4] as const) {
      expect(verdict("browser.navigate", { url: "https://pypi.org/" }, level)).toBe("allow");
      expect(verdict("terminal.run", { argv: ["rm", "-rf", "x"] }, level)).toBe("allow");
    }
  });

  it("denies the same things and asks before creating or retiring agents at every level", () => {
    for (const level of [1, 2, 3, 4] as const) {
      expect(verdict("browser.navigate", { url: "http://192.168.1.10/" }, level)).toBe("deny");
      expect(verdict("browser.navigate", { url: "https://u:p@python.org/" }, level)).toBe("deny");
      expect(verdict("fs.fetch", { path: "a.png" }, level)).toBe("deny");
      expect(verdict("team.retire", { agentId: "scout-2" }, level)).toBe("approve");
      expect(verdict("team.propose", { team: { name: "T" }, members: [] }, level)).toBe("approve");
    }
  });
});
