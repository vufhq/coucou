// Tofu — a flat pebble that moves exactly like Mochi. BotEngine keeps every
// tween, spring, particle and outfit transition; when the character is Tofu
// (./character.ts) its draw() hands the body, eyes, hands and outfit to this
// file. The badge and the particles stay the engine's own.
//
// Tofu's look: grok-bot-avatar-engine's pebble and eye seat (./tofu-shape.ts),
// one flat colour, flat eyes with no highlight. Mochi's life on top: the eyes
// are projected on an ellipsoid the size of the pebble (his EYE_SP and EYE_P
// become angles derived from the seat), the state tint and the cheeks paint over
// the body, and the hands come out only to wave.
//
// Tofu's outfits are Mochi's twelve, redrawn as flat parts on anchors (crown,
// brim, side, eyes, neck, body…) projected on the head like outfits.ts does
// (view tilted −0.3, 40 % of the pitch). They enter and leave on the engine's
// presence tween with Mochi's four transitions: drop, slide, pop and fade.
//
// Coordinates here are Tofu units: origin at the centre of the pebble, y down,
// the pebble 1.8 wide. One unit is UNIT × the engine's R, so the pebble is
// exactly as tall as Mochi (2 × 0.88 R) and sits where he does.

import { Ease } from "../core/anim";
import type { BotStateName } from "../core/layout";
import type { EyeShape, RGB } from "./engine";
import { withLayer } from "./layer";
import { tofuInk } from "./character";
import { PEBBLE } from "./tofu-shape";
import type { Outfit } from "./wardrobe";

type Ctx = CanvasRenderingContext2D;
type XY = readonly [number, number];

/** The pebble's longest side, in Tofu units. */
const SPAN = 1.8;
const K = SPAN / Math.max(PEBBLE.box[2], PEBBLE.box[3]);
/** Engine R → Tofu units: the pebble is as tall as Mochi. */
export const UNIT = (2 * 0.88) / (PEBBLE.box[3] * K);

const EYE_INK = "#141414";
/** Mini Tofus (pills, HQ) get bigger eyes, like mini Mochis, but the pebble's seat is already wide. */
const MINI_EYES = 1.35;
const VIEW_TILT = -0.3;
const ACC_PITCH = 0.4;

const now = () => performance.now() / 1000;
const rgba = (c: RGB, a: number) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

// ── Geometry ──────────────────────────────────────────────────────────────────

interface Geometry {
  path: Path2D;
  halfW: number;
  halfH: number;
  top: number;
  eye: { w: number; h: number; gap: number; y: number };
  face: { rx: number; ry: number };
  /** Mochi's EYE_SP and EYE_P for the pebble. */
  eyeSp: number;
  eyeP: number;
  /** The head outfits are projected on: its crown lands on the top of the pebble. */
  head: { rx: number; ry: number };
  /** Hats scale with the head's width just below the top, so the brim covers it. */
  hatScale: number;
  /** Glasses: sized for an eye of 0.2 × 0.23 and eyes 0.71 apart. */
  lens: number;
}

let geometry: Geometry | null = null;

/** Built on first use: Path2D does not exist where the tests run. */
function geo(): Geometry {
  if (geometry) return geometry;
  const [bx, by, bw, bh] = PEBBLE.box;
  const path = new Path2D();
  path.addPath(new Path2D(PEBBLE.d), new DOMMatrix([K, 0, 0, K, -(bx + bw / 2) * K, -(by + bh / 2) * K]));
  const halfW = (bw * K) / 2;
  const halfH = (bh * K) / 2;
  const top = -halfH;
  const s = PEBBLE.seat;
  const eye = { w: s.width * SPAN, h: s.height * SPAN, gap: s.gap * SPAN, y: -s.shiftY * SPAN };
  const face = { rx: halfW * 0.96, ry: halfH * 0.96 };
  const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
  geometry = {
    path, halfW, halfH, top, eye, face,
    eyeSp: Math.asin(clamp(eye.gap / 2 / face.rx)),
    eyeP: Math.asin(clamp(-eye.y / face.ry)),
    head: { rx: Math.max(halfW, 0.5), ry: Math.max(0.3, -(top + 0.04) / (0.97 * Math.cos(0.3))) },
    hatScale: Math.max(0.6, Math.min(1.45, (PEBBLE.hatW * K) / 1.39)),
    lens: Math.min(Math.max(eye.w / 0.2, (eye.h / 0.23) * 0.8), eye.gap / 2 / 0.19),
  };
  return geometry;
}

// ── What the engine hands over ────────────────────────────────────────────────

/** The look of the head, which the anchors follow. */
interface Look {
  yaw: number;
  pitch: number;
  roll: number;
  /** Dressed, the whole character rolls: the eyes must not roll again. */
  rigidRoll: boolean;
}

export interface TofuPose extends Look {
  tilt: number;
  sx: number;
  sy: number;
  es: number;
  blush: number;
  tint: number;
  hands: number;
  morph: number;
  col: RGB;
  state: BotStateName;
  eye: EyeShape;
  outfit: Outfit;
  /** 0 = gone, 1 = fully on (the engine's outfitPresence). */
  presence: number;
  physDx: number;
  physDy: number;
  waveStart: number;
  waveUntil: number;
  isMini: boolean;
  /** The body colour. */
  fill: string;
}

export interface TofuHooks {
  /** The engine's drawEyeShape: Tofu's eyes are Mochi's thirteen shapes. */
  eye(x: Ctx, shape: EyeShape, w: number, h: number, sd: number, ink: string): void;
  /** The mailbox slot, `body` in the engine's pixels. */
  mouth?(x: Ctx, body: Path2D): void;
}

// ── Projection and anchors ────────────────────────────────────────────────────

/** A point on the face ellipsoid (Mochi's eye projection), with foreshortening. */
function facePoint(g: Geometry, l: Look, yawOff: number, pitchOff: number, withRoll: boolean) {
  const yw = yawOff + l.yaw;
  let pt = pitchOff + l.pitch + (withRoll && !l.rigidRoll ? l.roll : 0);
  pt = (((pt + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const cp = Math.cos(pt);
  return {
    visible: Math.cos(yw) * cp > 0.04,
    x: Math.sin(yw) * cp * g.face.rx,
    y: -Math.sin(pt) * g.face.ry,
    fx: Math.max(0.18, Math.cos(yw)),
    fy: Math.max(0.18, cp),
  };
}

/** Head-local point (x right, y up, z toward the viewer), as outfits.ts projects it. */
function headProj(g: Geometry, l: Look, x: number, y: number, z: number) {
  const cy = Math.cos(l.yaw);
  const sy = Math.sin(l.yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const pitch = VIEW_TILT + l.pitch * ACC_PITCH;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x: x1 * g.head.rx, y: -(y * cp + z1 * sp) * g.head.ry, z: -y * sp + z1 * cp };
}

type Anchor = "crown" | "brim" | "side" | "eyeL" | "eyeR" | "eyes" | "neck" | "body";

interface Frame { x: number; y: number; fx: number; fy: number; rot: number }

function anchorFrame(g: Geometry, l: Look, name: Anchor): Frame {
  switch (name) {
    case "crown":
    case "brim": {
      const p = headProj(g, l, 0, name === "crown" ? 0.97 : 0.7, 0);
      return { x: p.x + Math.sin(l.yaw) * 0.1, y: p.y, fx: 1, fy: 1, rot: l.yaw * 0.15 };
    }
    case "side": {
      const ring = Math.sqrt(1 - 0.86 * 0.86);
      const p = headProj(g, l, ring * Math.sin(0.55), 0.86, ring * Math.cos(0.55));
      return { x: p.x, y: p.y, fx: Math.max(0.45, Math.cos(0.55 + l.yaw)), fy: 1, rot: 0.35 + l.yaw * 0.3 };
    }
    case "eyeL":
    case "eyeR": {
      const f = facePoint(g, l, (name === "eyeL" ? -1 : 1) * g.eyeSp, g.eyeP, false);
      return { x: f.x, y: f.y, fx: f.fx * g.lens, fy: f.fy * Math.max(g.lens, (g.eye.h / 0.23) * 0.85), rot: 0 };
    }
    case "eyes": {
      const f = facePoint(g, l, 0, g.eyeP, false);
      return { x: f.x, y: f.y, fx: (f.fx * g.eye.gap) / 0.71, fy: g.lens, rot: 0 };
    }
    case "neck":
      return { x: Math.sin(l.yaw) * g.halfW * 0.3, y: g.halfH * 0.55, fx: g.halfW, fy: 1, rot: 0 };
    case "body":
      return { x: 0, y: 0, fx: g.halfW, fy: g.halfH / 0.82, rot: 0 };
  }
}

// ── Costumes: Mochi's twelve, as flat parts ───────────────────────────────────

/** A colour, or a linear gradient in the part's own space. */
type Paint = string | { from: XY; to: XY; stops: readonly (readonly [number, string])[] };

interface Part {
  shape: "ellipse" | "circle" | "rect" | "halfEllipse" | "poly" | "star" | "line" | "path";
  anchor?: Anchor;
  layer?: "behind" | "front";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  r?: number;
  rot?: number;
  points?: readonly XY[];
  d?: string;
  fill?: Paint;
  stroke?: Paint;
  lw?: number;
  /** Mochi's sheen across [left, right]: light, clear, then shade. */
  shine?: XY;
  /** halfEllipse: the arc alone, not closed. */
  open?: boolean;
  /** Follows the soft-part spring (true = 1). */
  spring?: boolean | number;
  clip?: "body";
  react?: { state: BotStateName; effect: "bob" | "glow"; color?: string };
}

interface Costume {
  enter: "drop" | "slide" | "pop" | "fade";
  /** Where a dropped hat rests on the head, for hat fitting (else 0.1 above its lowest point). */
  seat?: { anchor: "crown" | "brim"; y: number };
  /** Recolours the body, like Mochi's pumpkin. */
  body?: readonly [string, string];
  parts: readonly Part[];
}

const WHITE = "#FFFFFF";

const COSTUMES: Record<Exclude<Outfit, "none">, Costume> = {
  partyHat: { enter: "drop", parts: [
    { shape: "poly", points: [[-0.38, 0.06], [0.38, 0.06], [0.04, -0.95]], fill: { from: [-0.38, -0.95], to: [0.38, 0.06], stops: [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]] }, shine: [-0.38, 0.38] },
    { shape: "circle", x: -0.12, y: -0.14, r: 0.05, fill: WHITE },
    { shape: "circle", x: 0.12, y: -0.3, r: 0.045, fill: WHITE },
    { shape: "circle", x: -0.02, y: -0.55, r: 0.04, fill: WHITE },
    { shape: "line", points: [[-0.37, 0.06], [0.37, 0.06]], stroke: "#FFD84D", lw: 0.07 },
    { shape: "circle", x: 0.04, y: -0.99, r: 0.13, fill: "#FFE27A", stroke: "#F2B705", lw: 0.02, spring: true, react: { state: "finished", effect: "bob" } },
  ] },
  beanie: { enter: "drop", parts: [
    { shape: "halfEllipse", y: 0.22, w: 1.5, h: 0.46, fill: { from: [0.5, -0.46], to: [-0.6, 0], stops: [[0, "#7DB6FF"], [1, "#2F6FE0"]] }, shine: [-0.75, 0.75] },
    { shape: "line", points: [[-0.36, -0.12], [-0.42, 0.2]], stroke: "rgba(20,50,140,0.22)", lw: 0.045 },
    { shape: "line", points: [[0, -0.2], [0, 0.2]], stroke: "rgba(20,50,140,0.22)", lw: 0.045 },
    { shape: "line", points: [[0.36, -0.12], [0.42, 0.2]], stroke: "rgba(20,50,140,0.22)", lw: 0.045 },
    { shape: "rect", y: 0.22, w: 1.58, h: 0.22, r: 0.1, fill: { from: [0, -0.11], to: [0, 0.11], stops: [[0, "#3C7BEA"], [1, "#2257C4"]] } },
    { shape: "circle", y: -0.3, r: 0.15, fill: WHITE, stroke: "#D5D9E2", lw: 0.025, spring: true },
  ] },
  crown: { enter: "drop", parts: [
    { shape: "poly", layer: "behind", y: -0.06, points: [[-0.34, 0.04], [0.34, 0.04], [0.36, -0.34], [0.18, -0.16], [0, -0.4], [-0.18, -0.16], [-0.36, -0.34]], fill: "#A8730C" },
    { shape: "poly", points: [[-0.4, 0.08], [0.4, 0.08], [0.44, -0.3], [0.22, -0.1], [0, -0.36], [-0.22, -0.1], [-0.44, -0.3]], fill: { from: [0, -0.36], to: [0, 0.08], stops: [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]] }, shine: [-0.44, 0.44], stroke: "#D08A0B", lw: 0.025, react: { state: "finished", effect: "glow", color: "#FFE08A" } },
    { shape: "circle", x: -0.44, y: -0.33, r: 0.04, fill: "#FFF6CC" },
    { shape: "circle", x: 0, y: -0.39, r: 0.04, fill: "#FFF6CC" },
    { shape: "circle", x: 0.44, y: -0.33, r: 0.04, fill: "#FFF6CC" },
    { shape: "circle", y: -0.02, r: 0.065, fill: "#EF4444" },
    { shape: "circle", x: -0.25, y: 0, r: 0.05, fill: "#3B82F6" },
    { shape: "circle", x: 0.25, y: 0, r: 0.05, fill: "#22C55E" },
  ] },
  sunglasses: { enter: "slide", parts: [
    { shape: "rect", anchor: "eyeL", w: 0.36, h: 0.25, r: 0.09, fill: "#1B1F2A" },
    { shape: "rect", anchor: "eyeR", w: 0.36, h: 0.25, r: 0.09, fill: "#1B1F2A" },
    { shape: "line", anchor: "eyes", points: [[-0.16, -0.03], [0.16, -0.03]], stroke: "#1B1F2A", lw: 0.045 },
    { shape: "line", anchor: "eyeL", points: [[-0.11, -0.06], [-0.03, -0.09]], stroke: "rgba(255,255,255,0.55)", lw: 0.03 },
    { shape: "line", anchor: "eyeR", points: [[-0.11, -0.06], [-0.03, -0.09]], stroke: "rgba(255,255,255,0.55)", lw: 0.03 },
  ] },
  roundGlasses: { enter: "slide", parts: [
    { shape: "circle", anchor: "eyeL", r: 0.17, fill: "rgba(220,240,255,0.16)", stroke: "#8B5E34", lw: 0.035 },
    { shape: "circle", anchor: "eyeR", r: 0.17, fill: "rgba(220,240,255,0.16)", stroke: "#8B5E34", lw: 0.035 },
    { shape: "line", anchor: "eyes", points: [[-0.17, -0.04], [0.17, -0.04]], stroke: "#8B5E34", lw: 0.03 },
  ] },
  bow: { enter: "pop", parts: [
    { shape: "ellipse", anchor: "side", x: -0.13, w: 0.28, h: 0.19, rot: -0.3, fill: "#F472B6" },
    { shape: "ellipse", anchor: "side", x: 0.13, w: 0.28, h: 0.19, rot: 0.3, fill: "#EC4899" },
    { shape: "circle", anchor: "side", r: 0.065, fill: "#DB2777" },
  ] },
  scarf: { enter: "slide", parts: [
    { shape: "rect", anchor: "neck", w: 2.4, h: 0.22, r: 0.1, fill: "#EF4444", clip: "body" },
    { shape: "rect", anchor: "neck", x: -0.5, w: 0.09, h: 0.22, fill: "rgba(255,255,255,0.85)", clip: "body" },
    { shape: "rect", anchor: "neck", x: 0, w: 0.09, h: 0.22, fill: "rgba(255,255,255,0.85)", clip: "body" },
    { shape: "rect", anchor: "neck", x: 0.5, w: 0.09, h: 0.22, fill: "rgba(255,255,255,0.85)", clip: "body" },
    { shape: "poly", anchor: "neck", x: -0.36, points: [[-0.1, 0], [0.1, 0], [0.13, 0.42], [-0.1, 0.44]], fill: "#DC2626", spring: true },
    { shape: "circle", anchor: "neck", x: -0.36, r: 0.1, fill: "#F87171" },
  ] },
  witchHat: { enter: "drop", seat: { anchor: "brim", y: 0 }, parts: [
    { shape: "ellipse", anchor: "brim", layer: "behind", w: 2.5, h: 0.54, fill: { from: [0, -0.27], to: [0, 0.27], stops: [[0, "#2A0A4F"], [1, "#3B0F6B"]] } },
    { shape: "halfEllipse", anchor: "brim", w: 2.5, h: 0.27, rot: Math.PI, fill: { from: [0, 0.27], to: [0, 0], stops: [[0, "#5B21B6"], [1, "#3B0764"]] } },
    { shape: "halfEllipse", anchor: "brim", w: 2.5, h: 0.27, rot: Math.PI, open: true, stroke: "rgba(190,150,255,0.4)", lw: 0.035 },
    { shape: "path", anchor: "brim", spring: 0.5, d: "M -0.74 0 C -0.66 -0.48 -0.2 -0.86 0.1 -1.16 Q 0.36 -1.24 0.66 -1.0 Q 0.4 -1.04 0.3 -0.9 C 0.46 -0.52 0.7 -0.26 0.74 0 Q 0 0.15 -0.74 0 Z",
      fill: { from: [-0.74, -1.1], to: [0.74, 0], stops: [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]] }, shine: [-0.74, 0.74] },
    { shape: "path", anchor: "brim", spring: 0.5, d: "M 0.05 -1.06 Q 0.2 -0.99 0.34 -1.05", stroke: "rgba(20,0,40,0.35)", lw: 0.05 },
    { shape: "path", anchor: "brim", spring: 0.5, d: "M -0.72 -0.1 Q 0 0.05 0.72 -0.1", stroke: "#F97316", lw: 0.15 },
    { shape: "rect", anchor: "brim", spring: 0.5, y: -0.03, w: 0.22, h: 0.17, r: 0.04, fill: { from: [0, -0.09], to: [0, 0.09], stops: [[0, "#FDE68A"], [1, "#F59E0B"]] } },
    { shape: "rect", anchor: "brim", spring: 0.5, y: -0.03, w: 0.11, h: 0.07, r: 0.015, fill: "#C2410C" },
  ] },
  pumpkin: { enter: "fade", body: ["#FFA94D", "#E8590C"], parts: [
    { shape: "ellipse", anchor: "body", w: 0.66, h: 1.64, stroke: "rgba(150,50,0,0.25)", lw: 0.07, clip: "body" },
    { shape: "ellipse", anchor: "body", w: 1.4, h: 1.64, stroke: "rgba(150,50,0,0.2)", lw: 0.07, clip: "body" },
    { shape: "poly", points: [[-0.07, 0.06], [0.06, 0.06], [0.11, -0.2], [0.02, -0.24]], fill: "#4D7C0F" },
    { shape: "ellipse", x: -0.17, y: -0.06, w: 0.32, h: 0.12, rot: -0.5, fill: "#65A30D", spring: true },
  ] },
  santaHat: { enter: "drop", parts: [
    { shape: "poly", points: [[-0.46, 0.08], [0.46, 0.08], [0.3, -0.42], [0.64, -0.62], [0.1, -0.62]], fill: { from: [-0.46, -0.6], to: [0.46, 0.08], stops: [[0, "#F87171"], [1, "#B91C1C"]] }, shine: [-0.46, 0.64], spring: true },
    { shape: "rect", y: 0.09, w: 1.14, h: 0.22, r: 0.11, fill: WHITE, stroke: "#DADDE4", lw: 0.02 },
    { shape: "circle", x: 0.66, y: -0.62, r: 0.12, fill: WHITE, stroke: "#DADDE4", lw: 0.02, spring: true },
  ] },
  bunnyEars: { enter: "drop", parts: [
    { shape: "ellipse", layer: "behind", x: -0.32, y: -0.42, w: 0.26, h: 0.86, rot: -0.15, fill: "#F9F0F0", stroke: "rgba(0,0,0,0.06)", lw: 0.015, spring: true },
    { shape: "ellipse", layer: "behind", x: -0.32, y: -0.4, w: 0.12, h: 0.56, rot: -0.15, fill: "rgba(252,165,165,0.7)", spring: true },
    { shape: "ellipse", layer: "behind", x: 0.32, y: -0.42, w: 0.26, h: 0.86, rot: 0.15, fill: "#F9F0F0", stroke: "rgba(0,0,0,0.06)", lw: 0.015, spring: true },
    { shape: "ellipse", layer: "behind", x: 0.32, y: -0.4, w: 0.12, h: 0.56, rot: 0.15, fill: "rgba(252,165,165,0.7)", spring: true },
  ] },
};

// ── Costume renderer ──────────────────────────────────────────────────────────

const paths = new Map<string, Path2D>();
const pathOf = (d: string) => {
  let p = paths.get(d);
  if (!p) paths.set(d, (p = new Path2D(d)));
  return p;
};

function paint(c: Ctx, f: Paint): string | CanvasGradient {
  if (typeof f === "string") return f;
  const g = c.createLinearGradient(f.from[0], f.from[1], f.to[0], f.to[1]);
  for (const [o, col] of f.stops) g.addColorStop(o, col);
  return g;
}

function starPath(c: Ctx, ro: number, ri: number) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath();
}

const isHat = (p: Part) => (p.anchor ?? "crown") === "crown" || p.anchor === "brim" || p.anchor === "side";

function drawParts(c: Ctx, g: Geometry, p: TofuPose, costume: Costume, layer: "behind" | "front", R: number, only: (part: Part) => boolean) {
  const t = now();
  for (const part of costume.parts) {
    if ((part.layer ?? "front") !== layer || !only(part)) continue;
    const a = anchorFrame(g, p, part.anchor ?? "crown");
    c.save();
    if (part.clip === "body") c.clip(g.path);
    c.translate(a.x, a.y);
    c.rotate(a.rot);
    c.scale(a.fx, a.fy);
    c.translate(part.x ?? 0, part.y ?? 0);
    const sk = part.spring === true ? 1 : part.spring || 0;
    if (sk) {
      c.translate(p.physDx * 0.1 * sk, p.physDy * 0.06 * sk);
      c.rotate(p.physDx * 0.22 * sk);
    }
    if (part.react?.state === p.state) {
      if (part.react.effect === "bob") c.translate(0, Math.sin(t * 6) * 0.05);
      if (part.react.effect === "glow") {
        c.shadowColor = part.react.color ?? "#FFF6A0";
        c.shadowBlur = (8 + 14 * (0.5 + 0.5 * Math.sin(t * 4))) * (R / 170);
      }
    }
    c.rotate(part.rot ?? 0);
    c.beginPath();
    const w = part.w ?? 0;
    const h = part.h ?? 0;
    const path = part.shape === "path" && part.d ? pathOf(part.d) : null;
    switch (part.shape) {
      case "ellipse": c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
      case "circle": c.arc(0, 0, part.r ?? 0, 0, Math.PI * 2); break;
      case "rect": c.roundRect(-w / 2, -h / 2, w, h, part.r ?? 0); break;
      case "halfEllipse":
        c.ellipse(0, 0, w / 2, h, 0, Math.PI, Math.PI * 2);
        if (!part.open) c.closePath();
        break;
      case "poly":
        part.points?.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.closePath();
        break;
      case "star": starPath(c, part.r ?? 0, (part.r ?? 0) * 0.45); break;
      case "line":
        if (part.points) {
          c.moveTo(part.points[0][0], part.points[0][1]);
          c.lineTo(part.points[1][0], part.points[1][1]);
        }
        break;
      case "path": break;
    }
    if (part.fill && part.shape !== "line" && !part.open) {
      c.fillStyle = paint(c, part.fill);
      if (path) c.fill(path);
      else c.fill();
      if (part.shine) {
        c.save();
        if (path) c.clip(path);
        else c.clip();
        c.shadowBlur = 0;
        c.fillStyle = paint(c, {
          from: [part.shine[0], 0], to: [part.shine[1], 0],
          stops: [[0, "rgba(255,255,255,0.28)"], [0.4, "rgba(255,255,255,0)"], [1, "rgba(0,0,0,0.16)"]],
        });
        c.fillRect(-4, -4, 8, 8);
        c.restore();
      }
    }
    if (part.stroke) {
      c.strokeStyle = paint(c, part.stroke);
      c.lineWidth = part.lw ?? 0.03;
      c.lineCap = "round";
      if (path) c.stroke(path);
      else c.stroke();
    }
    c.restore();
  }
}

/** The y values of a part's outline, relative to its anchor (y down). */
function partYs(part: Part): number[] {
  const y = part.y ?? 0;
  const w = part.w ?? 0;
  const h = part.h ?? 0;
  const r = part.r ?? 0;
  switch (part.shape) {
    case "circle":
    case "star": return [y - r, y + r];
    case "ellipse": {
      const half = (Math.abs(Math.sin(part.rot ?? 0)) > 0.3 ? Math.max(w, h) : h) / 2;
      return [y - half, y + half];
    }
    case "rect": return [y - h / 2, y + h / 2];
    case "halfEllipse": return Math.abs(part.rot ?? 0) > 1.5 ? [y, y + h] : [y - h, y];
    case "poly":
    case "line": return (part.points ?? []).map((q) => y + q[1]);
    case "path": {
      const n = (part.d ?? "").match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
      return n.filter((_, i) => i % 2 === 1).map((v) => y + v);
    }
  }
}

interface Fit { s: number; fy: number; lift: number }

const REST: Look = { yaw: 0, pitch: 0, roll: 0, rigidRoll: false };
const fits = new Map<Outfit, Fit>();

/**
 * Hats never cover the eyes. A hat that reaches below the top of the eyes is
 * lifted; if lifting would take it off the head, it is flattened instead, so it
 * still sits on the head. Worked out once per hat, at rest.
 */
function hatFit(g: Geometry, outfit: Outfit, costume: Costume): Fit {
  const cached = fits.get(outfit);
  if (cached) return cached;
  const C = anchorFrame(g, REST, "crown").y;
  const B = anchorFrame(g, REST, "brim").y;
  const rel = (anchor: Anchor | undefined) => (anchor === "brim" ? B - C : 0);
  let low = -Infinity;
  for (const part of costume.parts) {
    const anchor = part.anchor ?? "crown";
    if ((anchor !== "crown" && anchor !== "brim") || (part.layer ?? "front") !== "front") continue;
    low = Math.max(low, rel(anchor) + Math.max(...partYs(part)));
  }
  const s = g.hatScale;
  let fit: Fit = { s, fy: 1, lift: 0 };
  if (low > -Infinity) {
    const seat = costume.seat ? rel(costume.seat.anchor) + costume.seat.y : low - 0.1;
    const eyeTop = g.eye.y - g.eye.h / 2;
    const gap = 0.03;
    const onHead = 0.02;
    let fy = 1;
    let lift = Math.max(0, C + low * s - (eyeTop - gap));
    const maxLift = Math.max(0, C + seat * s - (g.top + onHead));
    if (lift > maxLift) {
      fy = Math.max(0.3, Math.min(1, (eyeTop - gap - g.top - onHead) / (s * (low - seat))));
      lift = Math.max(0, C + low * s * fy - (eyeTop - gap));
    }
    fit = { s, fy, lift };
  }
  fits.set(outfit, fit);
  return fit;
}

/** Mochi's layerAlpha: the outfit fades with its presence and away into the mailbox. */
function layerAlpha(p: TofuPose): number {
  const morphFade = 1 - Math.min(1, Math.max(0, (p.morph - 0.3) / 0.2));
  return morphFade * Math.min(1, p.presence * 2.5);
}

function drawOutfit(c: Ctx, g: Geometry, p: TofuPose, layer: "behind" | "front", R: number) {
  if (p.outfit === "none") return;
  const costume = COSTUMES[p.outfit];
  if (!costume.parts.some((part) => (part.layer ?? "front") === layer)) return;
  const alpha = layerAlpha(p);
  if (alpha <= 0.005) return;
  const posP = Ease.back(p.presence);
  const all = () => true;

  if (costume.enter === "drop") {
    // Only the hat drops (Mochi's 0.88 R), scales and fits the head.
    const fit = hatFit(g, p.outfit, costume);
    const s = (0.85 + 0.15 * posP) * fit.s;
    c.save();
    c.translate(0, -(1 - posP) * (0.88 / UNIT) - fit.lift);
    const a = anchorFrame(g, p, "crown");
    c.translate(a.x, a.y);
    c.scale(s, s * fit.fy);
    c.translate(-a.x, -a.y);
    withLayer(c, alpha, (l) => drawParts(l, g, p, costume, layer, R, isHat));
    c.restore();
    if (costume.parts.some((part) => !isHat(part) && (part.layer ?? "front") === layer)) {
      withLayer(c, alpha, (l) => drawParts(l, g, p, costume, layer, R, (part) => !isHat(part)));
    }
    return;
  }
  c.save();
  if (costume.enter === "slide") {
    // Mochi's slides: glasses come down 0.25 ry, the scarf 0.3 ry.
    c.translate(0, ((1 - p.presence) * (p.outfit === "scarf" ? 0.3 : 0.25) * 0.88) / UNIT);
  } else if (costume.enter === "pop") {
    const a = anchorFrame(g, p, costume.parts[0].anchor ?? "crown");
    const s = Math.max(0.001, posP);
    c.translate(a.x, a.y);
    c.scale(s, s);
    c.translate(-a.x, -a.y);
  }
  withLayer(c, alpha, (l) => drawParts(l, g, p, costume, layer, R, all));
  c.restore();
}

// ── Body ──────────────────────────────────────────────────────────────────────

/** Hands come out only to wave, in the body's colour (BotEngine.drawHandsBehind). */
function drawHands(c: Ctx, g: Geometry, p: TofuPose) {
  const n = now();
  const waving = n >= p.waveStart && p.waveStart > 0 && n < p.waveUntil;
  const hwB = g.halfW * p.sx;
  const hhB = g.halfH * p.sy;
  const bodyH = 2 * g.halfH;
  for (const sd of [-1, 1]) {
    let lx = sd * hwB * 1.08;
    let ly = hhB * 0.7;
    let rot = 0;
    if (sd > 0 && waving) {
      const wt = n - p.waveStart;
      const rise = Math.min(1, wt / 0.18);
      const re = 1 - Math.pow(1 - rise, 3);
      const wx = hwB * 1.1 + Math.cos(13 * wt) * 0.06 * bodyH;
      const wy = -hhB * 0.15 - Math.sin(13 * wt) * 0.14 * bodyH;
      lx += (wx - lx) * re;
      ly += (wy - ly) * re;
      rot = (-0.5 + Math.sin(13 * wt) * 0.35) * re;
    } else if (sd < 0 && waving) {
      ly += Math.sin(6 * (n - p.waveStart)) * 0.04 * bodyH;
    }
    c.save();
    c.translate(lx, ly);
    c.rotate(rot);
    c.beginPath();
    c.ellipse(0, 0, 0.3 * g.halfH * p.hands, 0.26 * g.halfH * p.hands, 0, 0, Math.PI * 2);
    c.fillStyle = p.fill;
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.08)";
    c.lineWidth = 0.015;
    c.stroke();
    c.restore();
  }
}

/**
 * Draws Tofu with its centre at (`cx`, `cy`) for an engine radius `R`. The
 * engine has already turned the canvas for a dressed roll.
 */
export function drawTofu(x: Ctx, p: TofuPose, R: number, cx: number, cy: number, hooks: TofuHooks) {
  const g = geo();
  const u = R * UNIT;
  x.save();
  x.translate(cx, cy);
  if (p.tilt !== 0) x.rotate(p.tilt);
  x.scale(u, u);
  if (p.hands > 0.01 && !p.isMini && R > 14) drawHands(x, g, p);
  x.scale(p.sx, p.sy);

  drawOutfit(x, g, p, "behind", R);

  x.fillStyle = p.fill;
  x.fill(g.path);
  x.save();
  x.clip(g.path);
  const costume = p.outfit === "none" ? null : COSTUMES[p.outfit];
  const recolour = costume?.body ? Math.min(1, p.presence * 2.5) * (1 - p.morph) : 0;
  if (costume?.body && recolour > 0.001) {
    const pg = x.createLinearGradient(g.halfW * 0.7, -g.halfH, -g.halfW * 0.8, g.halfH);
    pg.addColorStop(0, costume.body[0]);
    pg.addColorStop(1, costume.body[1]);
    x.globalAlpha = recolour;
    x.fillStyle = pg;
    x.fillRect(-2, -2, 4, 4);
    x.globalAlpha = 1;
  }
  const tint = p.tint * (1 - p.morph);
  if (tint > 0.01) {
    const tg = x.createLinearGradient(0, g.halfH, 0, -g.halfH);
    tg.addColorStop(0, rgba(p.col, 0.72 * tint));
    tg.addColorStop(1, rgba(p.col, 0));
    x.fillStyle = tg;
    x.fillRect(-2, -2, 4, 4);
  }
  // Mochi's cheeks: only while blushing or tinted.
  const blush = Math.max(p.blush, p.tint * 0.5) * (1 - p.morph);
  if (blush > 0.01) {
    x.fillStyle = `rgba(255,120,150,${0.5 * blush})`;
    const cw = g.eye.w * 0.7;
    const chy = g.eye.y + g.eye.h * 0.62;
    for (const sd of [-1, 1]) {
      x.beginPath();
      x.ellipse(sd * (g.eye.gap / 2 + g.eye.w * 0.55) + Math.sin(p.yaw) * g.halfW * 0.8, chy, cw, cw * 0.6, 0, 0, Math.PI * 2);
      x.fill();
    }
  }
  // Eyes on the face ellipsoid, clipped by the outline: they roll out over the top and back from below.
  x.fillStyle = EYE_INK;
  x.strokeStyle = EYE_INK;
  const scale = p.es * (p.isMini ? MINI_EYES : 1);
  for (const sd of [-1, 1]) {
    const f = facePoint(g, p, sd * g.eyeSp, g.eyeP, true);
    if (!f.visible) continue;
    x.save();
    x.translate(f.x, f.y + (p.morph > 0 ? g.face.ry * 0.14 * p.morph : 0));
    x.scale(f.fx + (1 - f.fx) * p.morph * 0.7, f.fy + (1 - f.fy) * p.morph * 0.7);
    hooks.eye(x, p.eye, g.eye.w * scale, g.eye.h * scale, sd, EYE_INK);
    x.restore();
  }
  x.restore();

  if (p.morph > 0.05 && hooks.mouth) {
    const body = new Path2D();
    body.addPath(g.path, new DOMMatrix([u, 0, 0, u, 0, 0]));
    x.save();
    x.scale(1 / u, 1 / u);
    hooks.mouth(x, body);
    x.restore();
  }

  drawOutfit(x, g, p, "front", R);
  x.restore();
}

// ── Wardrobe icon ─────────────────────────────────────────────────────────────

function pillEye(x: Ctx, _shape: EyeShape, w: number, h: number) {
  x.beginPath();
  x.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2);
  x.fill();
}

/** A little Tofu wearing `outfit`, placed like the wardrobe's little Mochi. */
export function drawTofuStill(x: Ctx, size: number, outfit: Outfit) {
  const R = 10;
  const pose: TofuPose = {
    ...REST, tilt: 0, sx: 1, sy: 1, es: 1, blush: 0, tint: 0, hands: 0, morph: 0,
    col: [0, 0, 0], state: "idle", eye: "pill", outfit, presence: 1, physDx: 0, physDy: 0,
    waveStart: 0, waveUntil: 0, isMini: false, fill: tofuInk(),
  };
  drawTofu(x, pose, R, size / 2, size / 2 + R * 0.62, { eye: pillEye });
}
