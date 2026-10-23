// Which character Coucou draws (src/mochi/character.ts): Mochi unless the
// preferences say Tofu, and Tofu's colour from its palette.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOFU_COLOR, TOFU_COLORS, applyCharacter, character, parseCharacter, parseTofuColor, tofuInk,
} from "../src/mochi/character.ts";
import { TOFU_PALETTE } from "../src/mochi/tofu-shape.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

test("Mochi unless the preferences say Tofu", () => {
  assert.equal(parseCharacter("tofu"), "tofu");
  for (const raw of ["mochi", "", "Tofu", "pip", null, undefined, 3]) assert.equal(parseCharacter(raw), "mochi");
  assert.equal(DEFAULT_SETTINGS.character, "mochi");
});

test("Tofu's colour is a palette name, anything else the default", () => {
  assert.equal(parseTofuColor("blue"), "blue");
  for (const raw of ["", "Blue", "#FF0000", "toString", null]) assert.equal(parseTofuColor(raw), DEFAULT_TOFU_COLOR);
  assert.equal(DEFAULT_SETTINGS.tofuColor, DEFAULT_TOFU_COLOR);
  assert.equal(TOFU_COLORS.length, 10);
});

test("applying the preferences switches every engine of the window", () => {
  applyCharacter({ character: "tofu", tofuColor: "violet" });
  assert.equal(character(), "tofu");
  assert.equal(tofuInk(), TOFU_PALETTE.violet.dark);
  applyCharacter(null);
  assert.equal(character(), "mochi");
  assert.equal(tofuInk(), TOFU_PALETTE[DEFAULT_TOFU_COLOR].dark);
});
