// Writes Tofu's 29 sounds into sounds/. No dependencies and no samples: each
// sound is a few notes described below, synthesised here (sine with a little
// second harmonic, a soft attack, an exponential decay) and saved as 48 kHz
// stereo 16-bit WAV. Change a recipe, run it again, commit the files.
//
//   node scripts/gen-sounds.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");
const RATE = 48000;
const TAU = Math.PI * 2;

// Note names → Hz (A4 = 440).
const SEMI = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
function hz(note) {
  if (typeof note === "number") return note;
  const m = /^([A-G])(#|b)?(\d)$/.exec(note);
  const semis = SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * Math.pow(2, semis / 12);
}

/** A seeded noise source, so the files are the same on every run. */
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/**
 * One voice. `at` and `len` in seconds; `f` a note or [from, to] for a glide;
 * `amp` 0–1; `decay` how fast it dies (higher = shorter ring); `vib` a vibrato
 * [rate Hz, depth as a fraction of the pitch]; `pan` −1…1; `kind` "tone",
 * "soft" (pure sine), "buzz" (odd harmonics) or "noise" (filtered, `f` is the
 * filter's pitch).
 */
function voice(buf, v) {
  const { at = 0, len, amp = 0.5, decay = 5, vib = null, pan = 0, kind = "tone", attack = 0.006 } = v;
  const [f0, f1] = Array.isArray(v.f) ? v.f.map(hz) : [hz(v.f), hz(v.f)];
  const start = Math.round(at * RATE);
  const n = Math.round(len * RATE);
  const rnd = noise(start * 31 + n);
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  let phase = 0;
  let low = 0;
  for (let i = 0; i < n && start + i < buf.length / 2; i++) {
    const t = i / RATE;
    const k = i / n;
    // Glides are exponential: equal musical steps in equal time.
    let f = f0 * Math.pow(f1 / f0, k);
    if (vib) f *= 1 + Math.sin(TAU * vib[0] * t) * vib[1];
    phase += (TAU * f) / RATE;
    let s;
    if (kind === "noise") {
      // One-pole low-pass on white noise, its cutoff following the pitch.
      const a = Math.min(1, (TAU * f) / RATE);
      low += a * (rnd() - low);
      s = low * 2.2;
    } else if (kind === "buzz") {
      s = Math.sin(phase) + Math.sin(3 * phase) / 3 + Math.sin(5 * phase) / 5;
    } else if (kind === "soft") {
      s = Math.sin(phase);
    } else {
      s = Math.sin(phase) + 0.22 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase);
    }
    const env = Math.min(1, t / attack) * Math.exp(-decay * t) * Math.min(1, (len - t) / 0.012);
    const out = s * env * amp;
    buf[(start + i) * 2] += out * gl;
    buf[(start + i) * 2 + 1] += out * gr;
  }
}

// ── The sounds ────────────────────────────────────────────────────────────────
// [name, length in seconds, voices]

const SOUNDS = [
  ["hover", 0.07, [{ len: 0.06, f: "E6", amp: 0.25, decay: 60, kind: "soft" }]],
  ["tick", 0.06, [{ len: 0.05, f: "A6", amp: 0.3, decay: 90, kind: "soft" }]],
  ["blip", 0.1, [{ len: 0.09, f: "A5", amp: 0.4, decay: 40 }]],
  ["peek", 0.4, [{ len: 0.36, f: ["E5", "A5"], amp: 0.4, decay: 11 }]],
  ["open", 0.5, [
    { len: 0.3, f: "D5", amp: 0.4, decay: 12 },
    { at: 0.09, len: 0.4, f: "A5", amp: 0.4, decay: 9 },
  ]],
  ["close", 0.42, [
    { len: 0.25, f: "A5", amp: 0.38, decay: 14 },
    { at: 0.08, len: 0.32, f: "D5", amp: 0.38, decay: 11 },
  ]],
  ["pop", 0.3, [{ len: 0.16, f: [280, 1150], amp: 0.5, decay: 22, kind: "soft" }]],
  ["wink", 0.22, [
    { len: 0.1, f: "E6", amp: 0.32, decay: 30 },
    { at: 0.07, len: 0.14, f: "B6", amp: 0.32, decay: 24 },
  ]],
  ["send", 0.48, [
    { len: 0.3, f: [380, 1500], amp: 0.3, decay: 8, kind: "soft" },
    { len: 0.3, f: [900, 5000], amp: 0.16, decay: 9, kind: "noise" },
  ]],
  ["search", 0.46, [
    { len: 0.1, f: "G5", amp: 0.3, decay: 26 },
    { at: 0.08, len: 0.1, f: "B5", amp: 0.3, decay: 26 },
    { at: 0.16, len: 0.1, f: "D6", amp: 0.3, decay: 26 },
    { at: 0.24, len: 0.2, f: "G6", amp: 0.3, decay: 14 },
  ]],
  ["think", 0.44, [
    { len: 0.2, f: "F5", amp: 0.3, decay: 14, kind: "soft" },
    { at: 0.16, len: 0.26, f: "Ab5", amp: 0.3, decay: 11, kind: "soft" },
  ]],
  ["work", 0.36, [
    { len: 0.12, f: "C5", amp: 0.38, decay: 28 },
    { at: 0.11, len: 0.22, f: "G5", amp: 0.38, decay: 16 },
  ]],
  ["attach", 0.6, [
    { len: 0.04, f: 2400, amp: 0.3, decay: 80, kind: "noise" },
    { at: 0.05, len: 0.5, f: ["G5", "C6"], amp: 0.36, decay: 8 },
  ]],
  ["gulp", 0.6, [
    { len: 0.22, f: [420, 150], amp: 0.5, decay: 9, kind: "soft" },
    { at: 0.26, len: 0.2, f: [220, 520], amp: 0.4, decay: 14, kind: "soft" },
  ]],
  ["greet", 0.75, [
    { len: 0.3, f: "C5", amp: 0.36, decay: 10 },
    { at: 0.11, len: 0.3, f: "E5", amp: 0.36, decay: 10 },
    { at: 0.22, len: 0.5, f: "G5", amp: 0.4, decay: 7 },
  ]],
  ["approval", 0.88, [
    { len: 0.22, f: "A5", amp: 0.4, decay: 12, pan: -0.3 },
    { at: 0.2, len: 0.22, f: "A5", amp: 0.4, decay: 12, pan: 0.3 },
    { at: 0.4, len: 0.46, f: "E6", amp: 0.42, decay: 7 },
  ]],
  ["question", 0.7, [
    { len: 0.24, f: "D5", amp: 0.38, decay: 12 },
    { at: 0.2, len: 0.46, f: ["F#5", "B5"], amp: 0.4, decay: 7 },
  ]],
  ["approve", 0.6, [
    { len: 0.16, f: "G5", amp: 0.4, decay: 20 },
    { at: 0.12, len: 0.44, f: "C6", amp: 0.42, decay: 8 },
  ]],
  ["finish", 1.16, [
    { len: 0.4, f: "C5", amp: 0.32, decay: 8 },
    { at: 0.1, len: 0.4, f: "E5", amp: 0.32, decay: 8 },
    { at: 0.2, len: 0.4, f: "G5", amp: 0.32, decay: 8 },
    { at: 0.3, len: 0.84, f: "C6", amp: 0.4, decay: 4.5 },
    { at: 0.3, len: 0.84, f: "E6", amp: 0.16, decay: 5 },
  ]],
  ["proud", 0.86, [
    { len: 0.18, f: "G5", amp: 0.36, decay: 16 },
    { at: 0.14, len: 0.18, f: "C6", amp: 0.36, decay: 16 },
    { at: 0.28, len: 0.56, f: "E6", amp: 0.4, decay: 6 },
    { at: 0.28, len: 0.56, f: "G6", amp: 0.16, decay: 7 },
  ]],
  ["love", 0.8, [
    { len: 0.4, f: "E5", amp: 0.36, decay: 7, vib: [6, 0.008], kind: "soft" },
    { at: 0.2, len: 0.58, f: "G#5", amp: 0.38, decay: 5.5, vib: [6, 0.008], kind: "soft" },
  ]],
  ["error", 0.84, [
    { len: 0.34, f: "Eb4", amp: 0.42, decay: 8, kind: "buzz" },
    { at: 0.26, len: 0.56, f: "A3", amp: 0.42, decay: 6, kind: "buzz" },
  ]],
  ["annoyed", 0.58, [
    { len: 0.2, f: ["F4", "E4"], amp: 0.36, decay: 12, kind: "buzz" },
    { at: 0.2, len: 0.36, f: ["E4", "C4"], amp: 0.36, decay: 9, kind: "buzz" },
  ]],
  ["rate", 0.68, [
    { len: 0.2, f: "G4", amp: 0.36, decay: 12 },
    { at: 0.18, len: 0.2, f: "E4", amp: 0.36, decay: 12 },
    { at: 0.36, len: 0.3, f: "C4", amp: 0.38, decay: 9 },
  ]],
  ["slap", 0.4, [
    { len: 0.09, f: [5000, 900], amp: 0.6, decay: 45, kind: "noise", attack: 0.001 },
    { len: 0.22, f: [190, 70], amp: 0.6, decay: 20, kind: "soft", attack: 0.002 },
  ]],
  ["dizzy", 0.98, [
    { len: 0.94, f: ["A5", "D5"], amp: 0.36, decay: 2.6, vib: [9, 0.05], kind: "soft" },
  ]],
  ["yawn", 0.74, [
    { len: 0.3, f: [300, 470], amp: 0.34, decay: 2, kind: "soft" },
    { at: 0.28, len: 0.44, f: [470, 230], amp: 0.34, decay: 5, kind: "soft" },
  ]],
  ["sleep", 0.46, [{ len: 0.44, f: ["G4", "C4"], amp: 0.32, decay: 6, kind: "soft" }]],
  // The launch hello (src/tofu/greeting.ts): Tofu falls in and lands at 0.45 s,
  // bounces, pops a hand out at 1.3 s and waves, tucks it at 2.45 s and
  // settles in the island around 3 s.
  ["greeting", 4.1, [
    { len: 0.45, f: [6000, 500], amp: 0.2, decay: 1.5, kind: "noise", attack: 0.12 },
    { len: 0.45, f: [900, 180], amp: 0.22, decay: 1.2, kind: "soft", attack: 0.1 },
    { at: 0.45, len: 0.3, f: [150, 60], amp: 0.6, decay: 16, kind: "soft", attack: 0.002 },
    { at: 0.45, len: 0.06, f: 1800, amp: 0.25, decay: 60, kind: "noise", attack: 0.001 },
    { at: 0.78, len: 0.16, f: [130, 80], amp: 0.26, decay: 24, kind: "soft", attack: 0.002 },
    { at: 1.3, len: 0.16, f: [300, 1100], amp: 0.36, decay: 20, kind: "soft" },
    { at: 1.48, len: 0.4, f: "G5", amp: 0.32, decay: 9, pan: -0.25 },
    { at: 1.68, len: 0.4, f: "C6", amp: 0.32, decay: 9, pan: 0.25 },
    { at: 1.88, len: 0.4, f: "G5", amp: 0.3, decay: 9, pan: -0.25 },
    { at: 2.08, len: 0.5, f: "E6", amp: 0.32, decay: 7, pan: 0.25 },
    { at: 2.5, len: 0.2, f: [900, 300], amp: 0.22, decay: 14, kind: "soft" },
    { at: 2.9, len: 1.2, f: "C5", amp: 0.3, decay: 3.2 },
    { at: 2.98, len: 1.1, f: "G5", amp: 0.26, decay: 3.4 },
    { at: 3.06, len: 1.0, f: "E6", amp: 0.2, decay: 3.6 },
  ]],
];

// ── WAV ───────────────────────────────────────────────────────────────────────

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(2, 22); // stereo
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, seconds, voices] of SOUNDS) {
  const buf = new Float64Array(Math.round(seconds * RATE) * 2);
  for (const v of voices) voice(buf, v);
  // The same loudness for all (the ticks half of it), and the last 10 ms
  // faded so no file ends on a click.
  let peak = 0;
  for (const s of buf) peak = Math.max(peak, Math.abs(s));
  const gain = (seconds < 0.12 ? 0.25 : 0.5) / peak;
  const tail = Math.round(0.01 * RATE);
  const frames = buf.length / 2;
  for (let i = 0; i < frames; i++) {
    const fade = Math.min(1, (frames - i) / tail);
    buf[i * 2] *= gain * fade;
    buf[i * 2 + 1] *= gain * fade;
  }
  writeFileSync(join(OUT, `${name}.wav`), wav(buf));
}
console.log(`${SOUNDS.length} sounds written to ${OUT}`);
