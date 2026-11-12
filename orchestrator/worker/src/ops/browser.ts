// The headless browser: Playwright with Chromium. One browser for the worker,
// one context (cookies, tabs) per task, so tasks never see each other's
// sessions. Every request is checked on its way out: the host machine, the
// LAN and non-web schemes are blocked even after a redirect or from a script,
// WebSockets included. That check looks a name up itself, and Chromium looks
// it up again: a name that answers differently the second time is caught by
// where the answer really came from (a private address closes the session),
// and, under all of it, by vufh-worker.service's IPAddressDeny. Chromium
// runs in its own sandbox whenever the computer allows one.

import { lookup } from "node:dns/promises";
import { access } from "node:fs/promises";
import { isIP } from "node:net";
import { isPrivateHost, type OpArgs } from "@vufh-orchestrator/protocol";
import { inside } from "../paths.ts";
import type { OpContext, OpResult } from "../worker.ts";

export interface BrowserPage {
  goto(url: string, timeoutMs: number): Promise<void>;
  url(): string;
  title(): Promise<string>;
  text(): Promise<string>;
  screenshot(path: string): Promise<void>;
}

/** What the operations need from a browser; Playwright in the VM, a fake in tests. */
export interface BrowserDriver {
  page(taskId: string): Promise<BrowserPage>;
  close(): Promise<void>;
  /** Replaces the DNS-based check, for tests that run without a network. */
  blocked?(host: string): Promise<boolean>;
  /** Whether a browser can be started at all (Chromium installed). */
  ready?(): Promise<boolean>;
}

export class BrowserError extends Error {}

/** A lookup is believed this long: a name's addresses can change. */
const RESOLVED_FOR_MS = 60_000;
const resolved = new Map<string, { blocked: boolean; at: number }>();

/** True when a host, or any address it resolves to, is off limits. */
export async function blockedHost(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return true;
  if (isIP(host)) return false;
  const cached = resolved.get(host);
  if (cached && Date.now() - cached.at < RESOLVED_FOR_MS) return cached.blocked;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // Blocked, but not remembered: a failed lookup may work next time.
    return true;
  }
  const blocked = addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address));
  if (resolved.size > 2_000) resolved.clear();
  resolved.set(host, { blocked, at: Date.now() });
  return blocked;
}

export async function navigate(ctx: OpContext, args: OpArgs<"browser.navigate">, browser: BrowserDriver): Promise<OpResult> {
  const url = new URL(args.url);
  if (await (browser.blocked ?? blockedHost)(url.hostname)) throw new BrowserError(`${url.hostname} is on a private network or could not be looked up`);
  const page = await browser.page(ctx.taskId);
  await page.goto(args.url, ctx.deadlineMs);
  const title = (await page.title()).slice(0, 200);
  ctx.report("browser.navigation", { url: page.url(), title });
  return { result: `Opened "${title}" at ${page.url()}` };
}

export async function extractText(ctx: OpContext, args: OpArgs<"browser.extract_text">, browser: BrowserDriver): Promise<OpResult> {
  const page = await browser.page(ctx.taskId);
  if (page.url() === "about:blank") throw new BrowserError("no page is open; navigate first");
  const max = args.maxChars ?? 20_000;
  const text = (await page.text()).replace(/\n{3,}/g, "\n\n").trim();
  return { result: text.length > max ? `${text.slice(0, max)}\n…(cut at ${max} characters)` : text };
}

export async function screenshot(ctx: OpContext, args: OpArgs<"browser.screenshot">, browser: BrowserDriver): Promise<OpResult> {
  const page = await browser.page(ctx.taskId);
  const path = await inside(ctx.dir, args.name);
  await page.screenshot(path);
  ctx.report("browser.screenshot_available", { path: args.name });
  return { result: `Saved a screenshot of ${page.url()} to ${args.name}.` };
}

/** The real thing. Loaded lazily, so the worker starts even before Chromium is installed. */
export function playwrightDriver(log: (line: string) => void = () => {}): BrowserDriver {
  type Pw = typeof import("playwright");
  let browser: Awaited<ReturnType<Pw["chromium"]["launch"]>> | null = null;
  /** `refused`: the host whose answer came from a private address; the session is closed. */
  const pages = new Map<string, { page: import("playwright").Page; used: number; refused: string | null }>();

  /**
   * Chromium in its own sandbox (Playwright leaves it off unless asked): a page
   * that breaks the renderer does not get the worker's user, its token and the
   * GitHub token of its jobs. A computer whose kernel allows no sandbox still
   * gets a browser, and says so in the worker's log.
   */
  const launch = async (pw: Pw) => {
    try {
      return await pw.chromium.launch({ headless: true, chromiumSandbox: true });
    } catch (err) {
      log(`Chromium could not start in its sandbox (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}); starting it without`);
      return pw.chromium.launch({ headless: true });
    }
  };

  const sweep = setInterval(() => {
    for (const [taskId, entry] of pages) {
      if (Date.now() - entry.used > 15 * 60_000) {
        void entry.page.context().close();
        pages.delete(taskId);
      }
    }
  }, 60_000);
  sweep.unref();

  return {
    async page(taskId) {
      let entry = pages.get(taskId);
      if (!entry) {
        const pw: Pw = await import("playwright");
        browser ??= await launch(pw);
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          const web = url.protocol === "http:" || url.protocol === "https:";
          if (!web && url.protocol !== "data:" && url.protocol !== "blob:") return route.abort("blockedbyclient");
          if (web && (await blockedHost(url.hostname))) return route.abort("blockedbyclient");
          return route.continue();
        });
        // context.route does not see WebSockets: the same rule, on their own route.
        await context.routeWebSocket(/.*/, async (ws) => {
          let host = "";
          try {
            host = new URL(ws.url()).hostname;
          } catch {
            // Not a URL: closed below.
          }
          if (!host || (await blockedHost(host))) {
            await ws.close({ code: 1008, reason: "blocked" });
            return;
          }
          ws.connectToServer();
        });
        const created = { page: await context.newPage(), used: Date.now(), refused: null as string | null };
        // Where each answer really came from. A public name that Chromium
        // resolved to a private address (after our own lookup said otherwise)
        // ends the session before its page can be read.
        context.on("response", (response) => {
          void response.serverAddr().then((addr) => {
            if (!addr || created.refused || !isPrivateHost(addr.ipAddress)) return;
            try {
              created.refused = new URL(response.url()).hostname;
            } catch {
              created.refused = addr.ipAddress;
            }
            if (pages.get(taskId) === created) pages.delete(taskId);
            void context.close().catch(() => {});
          }, () => {});
        });
        entry = created;
        pages.set(taskId, entry);
      }
      entry.used = Date.now();
      const held = entry;
      const page = held.page;
      const refusal = () => new BrowserError(`${held.refused} answered from a private network address; the page was closed`);
      /** Runs one call on the page; a session closed for a private answer says so, whatever Chromium threw. */
      const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
        if (held.refused) throw refusal();
        try {
          const out = await call();
          if (held.refused) throw refusal();
          return out;
        } catch (err) {
          throw held.refused ? refusal() : err;
        }
      };
      return {
        goto: (url, timeoutMs) =>
          guarded(async () => {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          }),
        url: () => page.url(),
        title: () => guarded(() => page.title()),
        text: () => guarded(() => page.innerText("body")),
        screenshot: (path) =>
          guarded(async () => {
            await page.screenshot({ path, fullPage: false });
          }),
      };
    },
    async ready() {
      try {
        const pw: Pw = await import("playwright");
        await access(pw.chromium.executablePath());
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      clearInterval(sweep);
      await browser?.close();
    },
  };
}
