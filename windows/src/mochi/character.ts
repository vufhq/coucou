// Which character Coucou draws: Mochi (the default, as shipped) or Tofu, a flat
// pebble with Mochi's motion (./tofu.ts). Picked in Settings → General and
// stored as `character`, Tofu's colour as `tofuColor`. Every window that draws
// a BotEngine applies the preferences here at boot and on settings-changed;
// the engine reads them on each frame, so a change shows at once.

import { TOFU_PALETTE, type TofuColor } from "./tofu-shape";

export const CHARACTERS = ["mochi", "tofu"] as const;
export type Character = (typeof CHARACTERS)[number];

export const DEFAULT_CHARACTER: Character = "mochi";
/** The colour grok-bot-avatar-engine's ID recipe gives "mochi". */
export const DEFAULT_TOFU_COLOR: TofuColor = "brown";

/** The colours offered, in the library's order. */
export const TOFU_COLORS = Object.keys(TOFU_PALETTE) as TofuColor[];

/** Anything unknown (a newer build's value, garbage) means Mochi. */
export function parseCharacter(raw: unknown): Character {
  return raw === "tofu" ? "tofu" : DEFAULT_CHARACTER;
}

export function parseTofuColor(raw: unknown): TofuColor {
  return typeof raw === "string" && Object.hasOwn(TOFU_PALETTE, raw) ? (raw as TofuColor) : DEFAULT_TOFU_COLOR;
}

let current: Character = DEFAULT_CHARACTER;
let color: TofuColor = DEFAULT_TOFU_COLOR;

/** Applies the two preferences to every engine in this window. */
export function applyCharacter(settings: { character?: unknown; tofuColor?: unknown } | null | undefined) {
  current = parseCharacter(settings?.character);
  color = parseTofuColor(settings?.tofuColor);
}

export const character = (): Character => current;

/** Tofu's body colour. Coucou is always dark, so the palette's dark ink. */
export const tofuInk = (): string => TOFU_PALETTE[color].dark;
