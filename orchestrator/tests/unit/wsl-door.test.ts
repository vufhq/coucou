import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepWslDoor, type WslDoor } from "../../server/src/wsl-door.ts";

/** A port nothing listens on, on loopback. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function answers(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return await res.text();
  } catch {
    return null;
  }
}

const until = (check: () => boolean | Promise<boolean>) => vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 3000, interval: 20 });

describe("keepWslDoor", () => {
  let door: WslDoor | null = null;
  afterEach(async () => {
    await door?.close();
    door = null;
  });

  it("opens when the adapter appears, and closes when it goes", async () => {
    const port = await freePort();
    let address: string | null = null;
    const log = vi.fn();
    door = keepWslDoor({
      port,
      handler: (_req, res) => res.end("gateway"),
      addressOf: () => address,
      log,
      pollMs: 20,
    });
    // The backend started before WSL: nothing to listen on yet.
    expect(door.address()).toBeNull();
    expect(await answers(port)).toBeNull();

    address = "127.0.0.1";
    await until(() => door?.address() === "127.0.0.1");
    expect(await answers(port)).toBe("gateway");
    expect(log).toHaveBeenCalledWith(`workers also on http://127.0.0.1:${port}`);

    address = null;
    await until(async () => (await answers(port)) === null);
    expect(door.address()).toBeNull();
    expect(log).toHaveBeenCalledWith(`workers no longer on http://127.0.0.1:${port}`);
  });

  it("keeps trying an address it cannot listen on, and says so once", async () => {
    const taken = createServer((_req, res) => res.end("someone else"));
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as AddressInfo;
    const log = vi.fn();
    door = keepWslDoor({ port, handler: (_req, res) => res.end("gateway"), addressOf: () => "127.0.0.1", log, pollMs: 20 });

    await until(() => log.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/cannot listen for workers/);
    expect(door.address()).toBeNull();

    // The port frees up: the door opens by itself.
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    await until(() => door?.address() === "127.0.0.1");
    expect(await answers(port)).toBe("gateway");
  });
});
