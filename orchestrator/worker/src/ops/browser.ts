// The headless browser: Playwright with Chromium. One browser for the worker,
// one context (cookies, tabs) per task, so tasks never see each other's
// sessions. Every request is checked on its way out: the host machine, the
// LAN and non-web schemes are blocked even after a redirect or from a script.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateHost, type OpArgs } from "@coucou-orchestrator/protocol";
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
}

export class BrowserError extends Error {}

const resolved = new Map<string, boolean>();

/** True when a host, or any address it resolves to, is off limits. */
export async function blockedHost(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return true;
  if (isIP(host)) return false;
  const cached = resolved.get(host);
  if (cached !== undefined) return cached;
  let blocked = true;
  try {
    const addrs = await lookup(host, { all: true });
    blocked = addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address));
  } catch {
    blocked = true;
  }
  resolved.set(host, blocked);
  return blocked;
}

export async function navigate(ctx: OpContext, args: OpArgs<"browser.navigate">, browser: BrowserDriver): Promise<OpResult> {
  const url = new URL(args.url);
  if (await (browser.blocked ?? blockedHost)(url.hostname)) throw new BrowserError(`${url.hostname} is on a private network`);
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
export function playwrightDriver(): BrowserDriver {
  type Pw = typeof import("playwright");
  let browser: Awaited<ReturnType<Pw["chromium"]["launch"]>> | null = null;
  const pages = new Map<string, { page: import("playwright").Page; used: number }>();

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
        browser ??= await pw.chromium.launch({ headless: true });
        const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          const web = url.protocol === "http:" || url.protocol === "https:";
          if (!web && url.protocol !== "data:" && url.protocol !== "blob:") return route.abort("blockedbyclient");
          if (web && (await blockedHost(url.hostname))) return route.abort("blockedbyclient");
          return route.continue();
        });
        entry = { page: await context.newPage(), used: Date.now() };
        pages.set(taskId, entry);
      }
      entry.used = Date.now();
      const page = entry.page;
      return {
        goto: async (url, timeoutMs) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        },
        url: () => page.url(),
        title: () => page.title(),
        text: () => page.innerText("body"),
        screenshot: async (path) => {
          await page.screenshot({ path, fullPage: false });
        },
      };
    },
    async close() {
      clearInterval(sweep);
      await browser?.close();
    },
  };
}
