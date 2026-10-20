import { describe, expect, it } from "vitest";
import { CreateTaskRequest, DECISION_JSON_SCHEMA, isPrivateHost, parseDecision, parseOperation } from "@coucou-orchestrator/protocol";

describe("operations", () => {
  it("accepts a well-formed operation and drops nothing it needs", () => {
    const op = parseOperation("fs.write_artifact", { path: "out/report.md", content: "# hi" });
    expect(op).toEqual({ ok: true, op: { op: "fs.write_artifact", args: { path: "out/report.md", content: "# hi" } } });
  });

  it.each([
    ["../etc/passwd"],
    ["/etc/passwd"],
    ["a/../../b"],
    [".ssh/id_rsa"],
    ["a\\b"],
    ["a//b"],
  ])("refuses the path %s", (path) => {
    expect(parseOperation("fs.read", { path }).ok).toBe(false);
  });

  it("refuses unknown operations and unknown arguments", () => {
    expect(parseOperation("shell.exec", { cmd: "rm -rf /" }).ok).toBe(false);
    expect(parseOperation("fs.list", { recursive: true }).ok).toBe(false);
  });

  it("only lets the browser open http and https", () => {
    expect(parseOperation("browser.navigate", { url: "https://docs.python.org/3/" }).ok).toBe(true);
    expect(parseOperation("browser.navigate", { url: "file:///etc/passwd" }).ok).toBe(false);
    expect(parseOperation("browser.navigate", { url: "javascript:alert(1)" }).ok).toBe(false);
  });
});

describe("decisions", () => {
  it("parses an action and a final answer", () => {
    expect(parseDecision({ kind: "action", note: "open docs", op: "fs.list", args: {} })).toMatchObject({
      ok: true,
      decision: { kind: "action", op: { op: "fs.list" } },
    });
    expect(parseDecision({ kind: "done", summary: "All set" })).toEqual({ ok: true, decision: { kind: "done", summary: "All set" } });
  });

  it("explains what is wrong, so the model can try again", () => {
    const bad = parseDecision({ kind: "action", op: "fs.read", args: { path: "../x" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/fs\.read/);
    expect(parseDecision({ kind: "done" }).ok).toBe(false);
    expect(parseDecision("yes").ok).toBe(false);
  });

  it("keeps backend-only operations out of the model's reach", () => {
    expect(parseDecision({ kind: "action", op: "fs.fetch", args: { path: "a.png" } })).toEqual({
      ok: false,
      error: "unknown operation fs.fetch",
    });
    expect(DECISION_JSON_SCHEMA.properties.op.enum).not.toContain("fs.fetch");
    expect(parseOperation("fs.fetch", { path: "a.png" }).ok).toBe(true);
  });
});

describe("task requests", () => {
  it("defaults to agent-01 and requires an idempotency key", () => {
    expect(CreateTaskRequest.parse({ prompt: "hi", idempotencyKey: "abcdefgh12" }).agentId).toBe("agent-01");
    expect(CreateTaskRequest.safeParse({ prompt: "hi" }).success).toBe(false);
    expect(CreateTaskRequest.safeParse({ prompt: "hi", idempotencyKey: "abcdefgh12", agentId: "claude" }).success).toBe(false);
  });
});

describe("private hosts", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "fd00::1", "printer.local"])(
    "blocks %s",
    (host) => expect(isPrivateHost(host)).toBe(true),
  );

  it.each(["docs.python.org", "8.8.8.8", "172.32.0.1", "2606:4700::1"])("allows %s", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
