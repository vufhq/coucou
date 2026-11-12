// The orchestrator's agents, as the island names and paints them before the
// backend has said who they are.

/** An agent id as the backend writes it: lowercase, digits and hyphens, ≤ 24 chars. */
export function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24) return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

/** A stable colour for an agent the backend gave none. */
export function agentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}
