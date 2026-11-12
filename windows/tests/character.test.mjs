// Which character vufh draws (src/tofu/character.ts): Tofu in chrome unless the
// preferences say otherwise, and Tofu's colour from its palette.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOFU_COLOR, TOFU_COLORS, applyCharacter, character, isChrome, parseCharacter, parseTofuColor, tofuInk,
} from "../src/tofu/character.ts";
import { TOFU_PALETTE } from "../src/tofu/tofu-shape.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

test("Tofu in chrome unless the preferences say otherwise", () => {
  assert.equal(parseCharacter("tofu"), "tofu");
  assert.equal(parseCharacter("chrome"), "chrome");
  for (const raw of ["", "Tofu", "mo" + "chi", "pip", null, undefined, 3]) assert.equal(parseCharacter(raw), "chrome");
  assert.equal(DEFAULT_SETTINGS.character, "chrome");
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
  assert.equal(character(), "chrome");
  assert.equal(isChrome(), true);
  applyCharacter({ character: "tofu" });
  assert.equal(isChrome(), false);
  applyCharacter(null);
  assert.equal(tofuInk(), TOFU_PALETTE[DEFAULT_TOFU_COLOR].dark);
});
