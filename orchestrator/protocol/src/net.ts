// Hosts an agent must never reach: the machine it runs on, the local
// network, cloud metadata services. Shared by the backend's policy (before an
// approval is even asked for) and the worker's browser (on every request,
// redirects included).

import { isIP } from "node:net";

/** Host names the browser must never reach: the host machine, the LAN, metadata services. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (kind === 6) {
    return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  }
  return false;
}
