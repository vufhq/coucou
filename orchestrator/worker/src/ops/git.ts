// git.clone and git.push, through the user's GitHub account. The token comes
// with the job and goes to git through the environment of that one process
// (the runner, another user, can't read it). The agent's repo is untrusted:
// the runner can rewrite its .git/config and hooks (core.fsmonitor,
// url.*.insteadOf, credential helpers, hooks…). So an authenticated git never
// runs in the agent's folder:
// - a clone happens in a private folder, then is copied into the task folder;
// - a push first copies the agent's branch with `clone --bare --no-local`
//   (which git documents as safe on an untrusted repo: no config or hooks
//   come along) without the token, then pushes from that clean copy to the
//   explicit github.com URL.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpArgs } from "@coucou-orchestrator/protocol";
import { PathError, inside } from "../paths.ts";
import type { OpContext, OpResult } from "../worker.ts";

const MAX_OUTPUT = 16 * 1024;

export class GitError extends Error {}

export interface GitOptions {
  /** Where private clones are made; the runner can't reach it. */
  privateDir: string;
  /** The remote for `owner/name`; github.com over https unless a test says otherwise. */
  remoteUrl?: (repo: string) => string;
  /** Protocols git may use; https only, unless a test adds file. */
  protocols?: string[];
}

const githubUrl = (repo: string) => `https://github.com/${repo}.git`;

/** The `-c` settings every git here runs with, as GIT_CONFIG_* entries. */
export function gitEnv(home: string, token: string | null, protocols: readonly string[]): NodeJS.ProcessEnv {
  const config: [string, string][] = [
    // A folder that doesn't exist: no hook ever runs.
    ["core.hooksPath", join(home, "no-hooks")],
    ["core.fsmonitor", "false"],
    ["credential.helper", ""],
    ["protocol.allow", "never"],
    ...protocols.map((p): [string, string] => [`protocol.${p}.allow`, "always"]),
    // The agent's files belong to the runner: read them anyway, for the bare copy only.
    ["safe.directory", "*"],
    ["advice.detachedHead", "false"],
  ];
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    // Never written: no global config.
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The output, with every form of the token gone. */
function scrub(text: string, token: string | null): string {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[redacted]").split(basic).join("[redacted]");
}

function git(
  ctx: OpContext,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; token: string | null },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], signal: ctx.signal });
    let output = "";
    const take = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => reject(err.name === "AbortError" ? err : new GitError(`could not run git: ${err.message}`)));
    child.on("close", (code) => resolve({ code, output: scrub(output, opts.token).trim() }));
  });
}

async function privateTemp(o: GitOptions): Promise<{ dir: string; home: string }> {
  await mkdir(o.privateDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(o.privateDir, `${randomUUID().slice(0, 8)}-`));
  const home = join(dir, "home");
  await mkdir(home, { mode: 0o700 });
  return { dir, home };
}

async function absent(path: string): Promise<boolean> {
  return stat(path).then(() => false, () => true);
}

export async function gitClone(ctx: OpContext, args: OpArgs<"git.clone">, token: string | null, o: GitOptions): Promise<OpResult> {
  if (!token) throw new GitError("no GitHub token came with this job");
  const target = await inside(ctx.dir, args.dir);
  if (!(await absent(target))) throw new PathError(`${args.dir} already exists in the task folder`);
  const protocols = o.protocols ?? ["https"];
  const { dir, home } = await privateTemp(o);
  try {
    const clone = join(dir, "repo");
    const url = (o.remoteUrl ?? githubUrl)(args.repo);
    const cloned = await git(ctx, ["clone", "--no-recurse-submodules", "--", url, clone], { cwd: dir, env: gitEnv(home, token, protocols), token });
    if (cloned.code !== 0) return { result: `git clone failed\n${cloned.output}`, failed: true };
    // From our own clone, without the token: the default branch is what HEAD names.
    const env = gitEnv(home, null, protocols);
    const head = await git(ctx, ["symbolic-ref", "--short", "HEAD"], { cwd: clone, env, token: null });
    const defaultBranch = head.code === 0 ? head.output.split("\n")[0]!.trim() : "";
    // The plain URL: what the copy keeps never had the token in it anyway.
    await git(ctx, ["remote", "set-url", "origin", githubUrl(args.repo)], { cwd: clone, env, token: null });
    await cp(clone, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return { result: JSON.stringify({ repo: args.repo, dir: args.dir, defaultBranch }) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function gitPush(ctx: OpContext, args: OpArgs<"git.push">, token: string | null, o: GitOptions): Promise<OpResult> {
  if (!token) throw new GitError("no GitHub token came with this job");
  const source = await inside(ctx.dir, args.dir);
  if (await absent(source)) throw new PathError(`${args.dir} is not in the task folder`);
  const protocols = o.protocols ?? ["https"];
  const { dir, home } = await privateTemp(o);
  try {
    const bare = join(dir, "push.git");
    const ref = `refs/heads/${args.branch}`;
    // 1. No token: a clean copy of the agent's branch. `--no-local` reads it the
    //    way a remote would, so none of its config, hooks or links comes along.
    const local = gitEnv(home, null, [...new Set([...protocols, "file"])]);
    const copied = await git(
      ctx,
      ["clone", "--bare", "--no-local", "--single-branch", "--branch", args.branch, "--", pathToFileURL(source).href, bare],
      { cwd: dir, env: local, token: null },
    );
    if (copied.code !== 0) return { result: `could not read the branch ${args.branch} in ${args.dir}\n${copied.output}`, failed: true };
    const commit = await git(ctx, ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: bare, env: local, token: null });
    if (commit.code !== 0) return { result: `${args.dir} has no branch ${args.branch}`, failed: true };
    // 2. With the token, from the clean copy, to the explicit URL. Never forced.
    const url = (o.remoteUrl ?? githubUrl)(args.repo);
    const pushed = await git(ctx, ["push", "--porcelain", "--", url, `${ref}:${ref}`], {
      cwd: bare,
      env: gitEnv(home, token, protocols),
      token,
    });
    const head = commit.output.slice(0, 12);
    if (pushed.code !== 0) return { result: `git push failed\n${pushed.output}`, failed: true };
    return { result: `Pushed ${args.branch} (${head}) to ${args.repo}.\n${pushed.output}`.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
