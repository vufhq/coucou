// What may run without a human, what needs a click, and what never runs.
// The model only proposes; this is where its proposal becomes a decision.

import { isPrivateHost, type Operation } from "@coucou-orchestrator/protocol";

export type Verdict =
  | { verdict: "allow" }
  | { verdict: "approve"; reason: string }
  | { verdict: "deny"; reason: string };

/** Commands that only read, run without asking. Anything else needs a click. */
export const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "pwd", "date", "echo", "sort", "uniq", "diff", "stat", "file",
]);

/** Package managers and anything that installs or escalates: always a click. */
const INSTALLERS = /^(?:apt|apt-get|dpkg|snap|pip|pip3|npm|npx|pnpm|yarn|curl|wget|sudo|su)$/;

export interface PolicyContext {
  /** Domains a human already approved for this agent. */
  approvedDomains: readonly string[];
}

/** The registrable-ish part a human approves: `docs.python.org` → `python.org`. */
export function domainOf(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tail2 = parts.slice(-2).join(".");
  // Two-part public suffixes common enough to matter (co.uk, com.au…).
  if (/^(?:co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(tail2)) return parts.slice(-3).join(".");
  return tail2;
}

/** What the approval card shows: the op and the exact thing it touches. */
export function describeTarget(op: Operation): string {
  const a = op.args;
  switch (op.op) {
    case "browser.navigate":
      return String(a.url);
    case "terminal.run":
      return (a.argv as string[]).join(" ");
    case "terminal.shell":
      return String(a.command);
    case "fs.write_artifact":
    case "fs.read":
    case "fs.fetch":
      return String(a.path);
    case "browser.screenshot":
      return String(a.name);
    case "team.propose": {
      const team = a.team as { name?: string; id?: string };
      const members = a.members as { name: string; role: string }[];
      return `Create team ${team.name ?? team.id}: ${members.map((member) => `${member.name} (${member.role})`).join(", ")}`;
    }
    case "team.retire":
      return `Retire agent ${String(a.agentId)}`;
    case "team.organize":
    case "agent.delegate":
    case "agent.answer":
    case "agent.wait":
      return "";
    default:
      return "";
  }
}

export function decide(op: Operation, ctx: PolicyContext): Verdict {
  const a = op.args;
  switch (op.op) {
    case "browser.navigate": {
      const url = new URL(String(a.url));
      if (url.username || url.password) return { verdict: "deny", reason: "URLs with credentials are not allowed" };
      if (isPrivateHost(url.hostname)) return { verdict: "deny", reason: "the host machine and private networks are off limits" };
      const domain = domainOf(url.hostname);
      if (ctx.approvedDomains.includes(domain)) return { verdict: "allow" };
      return { verdict: "approve", reason: `first visit to ${domain}` };
    }
    case "terminal.run": {
      const argv = a.argv as string[];
      const bin = argv[0] ?? "";
      if (bin.includes("/")) return { verdict: "approve", reason: "runs a program by path" };
      if (INSTALLERS.test(bin)) return { verdict: "approve", reason: "installs software or reaches the network" };
      if (!SAFE_COMMANDS.has(bin)) return { verdict: "approve", reason: `${bin} is not on the read-only list` };
      return { verdict: "allow" };
    }
    // The shell runs as the computer's `runner` user, which cannot reach the
    // worker, its token, Windows or the local network: the computer is the
    // boundary, as in rakazo, so code runs without a click. The same shell can
    // rewrite any file, so an overwrite asks no more either.
    case "terminal.shell":
    case "fs.write_artifact":
    case "browser.extract_text":
    case "browser.screenshot":
    case "fs.list":
    case "fs.read":
      return { verdict: "allow" };
    case "fs.fetch":
      // A download for the user, asked by the backend; never a model's step.
      return { verdict: "deny", reason: "not an operation the model can use" };
    case "team.propose":
      return { verdict: "approve", reason: "creating agents always needs the user's approval" };
    case "team.retire":
      return { verdict: "approve", reason: "retiring an agent always needs the user's approval" };
    case "team.organize":
    case "agent.delegate":
    case "agent.answer":
    case "agent.wait":
      return { verdict: "allow" };
  }
}
