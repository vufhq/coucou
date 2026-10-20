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
  ])("removes the secret from %s", (text, secret) => {
    const out = redactText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("keeps ordinary text and nested structure", () => {
    expect(redactText("pip install requests")).toBe("pip install requests");
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

  it("asks before overwriting a file", () => {
    expect(decide({ op: "fs.write_artifact", args: { path: "a.md", content: "" } }, ctx).verdict).toBe("allow");
    expect(decide({ op: "fs.write_artifact", args: { path: "a.md", content: "", overwrite: true } }, ctx).verdict).toBe("approve");
  });

  it("approves whole sites, not single hosts", () => {
    expect(domainOf("docs.python.org")).toBe("python.org");
    expect(domainOf("www.bbc.co.uk")).toBe("bbc.co.uk");
  });
});
