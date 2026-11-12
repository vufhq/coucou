// Liquid chrome, for Tofu's chrome finish (./tofu.ts), as on vufh.dev: Paper
// Design's "liquid metal" fragment shader (@paper-design/shaders, Apache-2.0)
// in its image mode. Changes made: only the shader's image branch is used; the
// edge is read from a blurred mask texture instead of the image's red channel;
// the uniforms are fixed to one look (LOOK below).
//
// The shader wants an image whose shape gives the opacity and whose blurred
// edge bends the stripes. Here that image is Tofu himself: each frame his
// silhouettes (body, and hands while they're out) are filled into a small mask
// in screen space, a blurred copy gives the edge, WebGL runs the shader over
// it, and the result is drawn back onto the 2D canvas where he stands. This is
// the one place a character is not plain Canvas 2D; without WebGL2 he is a
// plain silver gradient.
//
// Use: metalBegin(); metalAdd(…) for each part; metalEnd(ctx).

type Ctx = CanvasRenderingContext2D;
/** A colour as the engine keeps it: red, green, blue, 0–1. */
type RGB = readonly [number, number, number];

const LOOK = {
  repetition: 2.2,
  softness: 0.14,
  shiftRed: 0.35,
  shiftBlue: 0.35,
  distortion: 0.09,
  contour: 0.6,
  angle: 70,
};

/** The mask's longest side, in pixels: plenty for the shader's soft stripes. */
const MAX_RES = 900;

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0., 1.);
  // y = 0 at the top, as the shader's image UV is.
  v_uv = vec2(a_pos.x * .5 + .5, .5 - a_pos.y * .5);
}`;

// Paper's fragment shader, image branch only. The edge comes from the blurred
// mask instead of the image's red channel; the rest is unchanged.
const FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_mask;
uniform sampler2D u_soft;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec4 u_colorTint;
uniform float u_softness;
uniform float u_repetition;
uniform float u_shiftRed;
uniform float u_shiftBlue;
uniform float u_distortion;
uniform float u_contour;
uniform float u_angle;

in vec2 v_uv;
out vec4 fragColor;

#define PI 3.14159265358979323846

vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float getColorChanges(float c1, float c2, float stripe_p, vec3 w, float blur, float bump, float tint) {
  float ch = mix(c2, c1, smoothstep(.0, 2. * blur, stripe_p));
  float border = w[0];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));
  bump = smoothstep(.2, .8, bump);
  border = w[0] + .4 * (1. - bump) * w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));
  border = w[0] + .5 * (1. - bump) * w[1];
  ch = mix(ch, c2, smoothstep(border, border + 2. * blur, stripe_p));
  border = w[0] + w[1];
  ch = mix(ch, c1, smoothstep(border, border + 2. * blur, stripe_p));
  float gradient_t = (stripe_p - w[0] - w[1]) / w[2];
  float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));
  ch = mix(ch, gradient, smoothstep(border, border + .5 * blur, stripe_p));
  // Tint: colour burn.
  ch = mix(ch, 1. - min(1., (1. - ch) / max(tint, 0.0001)), u_colorTint.a);
  return ch;
}

void main() {
  const float firstFrameOffset = 2.8;
  float t = .3 * (u_time + firstFrameOffset);

  vec2 uv = v_uv;
  float opacity = texture(u_mask, uv).a;
  if (opacity <= 0.) { fragColor = vec4(0.); return; }

  float cycleWidth = u_repetition;

  vec2 rotatedUV = uv - vec2(.5);
  float angle = (-u_angle + 70.) * PI / 180.;
  float cosA = cos(angle);
  float sinA = sin(angle);
  rotatedUV = vec2(rotatedUV.x * cosA - rotatedUV.y * sinA, rotatedUV.x * sinA + rotatedUV.y * cosA) + vec2(.5);

  float edge = 1. - texture(u_soft, uv).a;
  edge = pow(clamp(edge, 0., 1.), 1.6);
  edge *= smoothstep(0.0, 0.4, u_contour);

  float diagBLtoTR = rotatedUV.x - rotatedUV.y;
  float diagTLtoBR = rotatedUV.x + rotatedUV.y;

  vec3 color1 = vec3(.98, 0.98, 1.);
  vec3 color2 = vec3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));

  vec2 grad_uv = uv - .5;
  float dist = length(grad_uv + vec2(0., .2 * diagBLtoTR));
  grad_uv = rotate(grad_uv, (.25 - .2 * diagBLtoTR) * PI);
  float direction = grad_uv.x;

  float bump = pow(1.8 * dist, 1.2);
  bump = 1. - bump;
  bump *= pow(uv.y, .3);

  float thin_strip_1_ratio = .12 / cycleWidth * (1. - .4 * bump);
  float thin_strip_2_ratio = .07 / cycleWidth * (1. + .4 * bump);
  float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);
  float thin_strip_1_width = cycleWidth * thin_strip_1_ratio;
  float thin_strip_2_width = cycleWidth * thin_strip_2_ratio;

  float noise = snoise(uv - t);
  edge += (1. - edge) * u_distortion * noise;

  direction += diagBLtoTR;
  float contour = 0.;
  direction -= 2. * noise * diagBLtoTR * (smoothstep(0., 1., edge) * (1.0 - smoothstep(0., 1., edge)));
  direction *= mix(1., 1. - edge, smoothstep(.5, 1., u_contour));
  direction -= 1.7 * edge * smoothstep(.5, 1., u_contour);
  direction += .2 * pow(u_contour, 4.) * (1.0 - smoothstep(0., 1., edge));

  bump *= clamp(pow(uv.y, .1), .3, 1.);
  direction *= (.1 + (1.1 - edge) * bump);
  direction *= (.4 + .6 * (1.0 - smoothstep(.5, 1., edge)));
  direction += .18 * (smoothstep(.1, .2, uv.y) * (1.0 - smoothstep(.2, .4, uv.y)));
  direction += .03 * (smoothstep(.1, .2, 1. - uv.y) * (1.0 - smoothstep(.2, .4, 1. - uv.y)));
  direction *= (.5 + .5 * pow(uv.y, 2.));
  direction *= cycleWidth;
  direction -= t;

  float colorDispersion = clamp(1. - bump, 0., 1.);
  float dispersionRed = colorDispersion;
  dispersionRed += .03 * bump * noise;
  dispersionRed += 5. * (smoothstep(-.1, .2, uv.y) * (1.0 - smoothstep(.1, .5, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, 1., bump)));
  dispersionRed -= diagBLtoTR;

  float dispersionBlue = colorDispersion;
  dispersionBlue *= 1.3;
  dispersionBlue += (smoothstep(0., .4, uv.y) * (1.0 - smoothstep(.1, .8, uv.y))) * (smoothstep(.4, .6, bump) * (1.0 - smoothstep(.4, .8, bump)));
  dispersionBlue -= .2 * edge;

  dispersionRed *= (u_shiftRed / 20.);
  dispersionBlue *= (u_shiftBlue / 20.);

  float softness = 0.05 * u_softness;
  float blur = softness + .5 * smoothstep(1., 10., u_repetition) * smoothstep(.0, 1., edge);
  float smallCanvasT = 1.0 - smoothstep(100., 500., min(u_resolution.x, u_resolution.y));
  blur += smallCanvasT * smoothstep(.0, 1., edge);
  float rExtraBlur = softness * (0.05 + .1 * (u_shiftRed / 20.) * bump);
  float gExtraBlur = softness * 0.05 / max(0.001, abs(1. - diagBLtoTR));

  vec3 w = vec3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
  w[1] -= .02 * smoothstep(.0, 1., edge + bump);
  float stripe_r = fract(direction + dispersionRed);
  float r = getColorChanges(color1.r, color2.r, stripe_r, w, blur + fwidth(stripe_r) + rExtraBlur, bump, u_colorTint.r);
  float stripe_g = fract(direction);
  float g = getColorChanges(color1.g, color2.g, stripe_g, w, blur + fwidth(stripe_g) + gExtraBlur, bump, u_colorTint.g);
  float stripe_b = fract(direction - dispersionBlue);
  float b = getColorChanges(color1.b, color2.b, stripe_b, w, blur + fwidth(stripe_b), bump, u_colorTint.b);

  vec3 color = vec3(r, g, b);
  color += 1. / 256. * (fract(sin(dot(.014 * gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453123) - .5);
  fragColor = vec4(color * opacity, opacity);
}`;

// ── WebGL ─────────────────────────────────────────────────────────────────────

interface GL {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
  mask: WebGLTexture;
  soft: WebGLTexture;
}

let glState: GL | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** The shader, set up once; null where WebGL2 isn't available. */
function setup(): GL | null {
  if (glState !== undefined) return glState;
  glState = null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const names = ["u_mask", "u_soft", "u_resolution", "u_time", "u_colorTint", ...Object.keys(LOOK).map((k) => `u_${k}`)];
    const u: GL["u"] = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(u.u_mask, 0);
    gl.uniform1i(u.u_soft, 1);
    for (const [k, v] of Object.entries(LOOK)) gl.uniform1f(u[`u_${k}`], v);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // A lost context (a GPU reset, the driver updating) draws nothing:
    // plain silver until it is back, then the shader is set up afresh.
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      glState = null;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      glState = undefined;
    });
    glState = { canvas, gl, u, mask: texture(gl), soft: texture(gl) };
  } catch (e) {
    console.warn("liquid chrome:", e);
    glState = null;
  }
  return glState;
}

// ── The batch ─────────────────────────────────────────────────────────────────

/**
 * The mask and its blurred copy. The big Tofu and the mini ones keep their own
 * pair, so drawing both in one frame doesn't resize the same canvases back and
 * forth.
 */
interface Surface {
  mask: HTMLCanvasElement;
  maskCtx: Ctx;
  soft: HTMLCanvasElement;
  softCtx: Ctx;
}

const surfaces = new Map<string, Surface>();

function surface(key: string): Surface {
  let f = surfaces.get(key);
  if (!f) {
    const mask = document.createElement("canvas");
    const soft = document.createElement("canvas");
    f = { mask, maskCtx: mask.getContext("2d")!, soft, softCtx: soft.getContext("2d")! };
    surfaces.set(key, f);
  }
  return f;
}

let parts: Path2D[] = [];
let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
const startedAt = performance.now();

export function metalBegin() {
  parts = [];
  box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

/**
 * Adds `path` (in the current units) to the chrome; (`cx`, `cy`) ± (`hw`, `hh`)
 * bounds it. Nothing is drawn until metalEnd.
 */
export function metalAdd(c: Ctx, path: Path2D, cx: number, cy: number, hw: number, hh: number) {
  const m = c.getTransform();
  const p = new Path2D();
  p.addPath(path, m);
  parts.push(p);
  for (const [x, y] of [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx - hw, cy + hh], [cx + hw, cy + hh]]) {
    const X = m.a * x + m.c * y + m.e;
    const Y = m.b * x + m.d * y + m.f;
    box.x0 = Math.min(box.x0, X);
    box.y0 = Math.min(box.y0, Y);
    box.x1 = Math.max(box.x1, X);
    box.y1 = Math.max(box.y1, Y);
  }
}

/** A plain silver, where WebGL2 is missing. */
function fallback(c: Ctx) {
  const g = c.createLinearGradient(box.x0, box.y0, box.x1, box.y1);
  g.addColorStop(0, "#f4f4f6");
  g.addColorStop(0.45, "#8a8a92");
  g.addColorStop(0.55, "#2a2a2e");
  g.addColorStop(1, "#d8d8de");
  c.fillStyle = g;
  for (const p of parts) c.fill(p);
}

/**
 * Renders the chrome for everything added since metalBegin onto `c`. `tint`
 * colours it (colour burn, as the shader's tint, `strength` 0–1), or null for
 * bare chrome. `key` names who is drawing (see Surface).
 */
export function metalEnd(c: Ctx, tint: RGB | null, key: string, strength = 0.55) {
  if (!parts.length || !(box.x1 > box.x0)) return;
  // A little room around the shape, so the blur and the antialiasing fit.
  const pad = 0.04 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
  const x0 = Math.floor(box.x0 - pad);
  const y0 = Math.floor(box.y0 - pad);
  const bw = Math.ceil(box.x1 + pad) - x0;
  const bh = Math.ceil(box.y1 + pad) - y0;

  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  let s = setup();
  if (s?.gl.isContextLost()) s = glState = null;
  // The edge needs a blurred copy of the mask: canvas `filter`, which WebView2 has.
  if (!s || !("filter" in c)) {
    fallback(c);
    c.restore();
    return;
  }

  const k = Math.min(1, MAX_RES / Math.max(bw, bh));
  const W = Math.max(2, Math.round(bw * k));
  const H = Math.max(2, Math.round(bh * k));

  // The shape, sharp…
  const { mask: maskCanvas, maskCtx, soft: softCanvas, softCtx } = surface(key);
  if (maskCanvas.width !== W || maskCanvas.height !== H) {
    maskCanvas.width = softCanvas.width = W;
    maskCanvas.height = softCanvas.height = H;
  }
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.clearRect(0, 0, W, H);
  maskCtx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  maskCtx.fillStyle = "#fff";
  for (const p of parts) maskCtx.fill(p);
  // …and blurred: one minus it is the edge that bends the stripes.
  softCtx.clearRect(0, 0, W, H);
  const blur = 0.035 * Math.min(W, H);
  softCtx.filter = `blur(${blur.toFixed(1)}px)`;
  softCtx.drawImage(maskCanvas, 0, 0);
  softCtx.filter = "none";

  const { gl, u } = s;
  // The GL canvas only grows; each draw uses its bottom-left W × H corner.
  if (s.canvas.width < W || s.canvas.height < H) {
    s.canvas.width = Math.max(s.canvas.width, W);
    s.canvas.height = Math.max(s.canvas.height, H);
  }
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.mask);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.soft);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, softCanvas);
  gl.uniform2f(u.u_resolution, W, H);
  gl.uniform1f(u.u_time, (performance.now() - startedAt) / 1000);
  const [tr, tg, tb] = tint ?? [1, 1, 1];
  gl.uniform4f(u.u_colorTint, tr, tg, tb, tint ? strength : 1);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  c.drawImage(s.canvas, 0, s.canvas.height - H, W, H, x0, y0, bw, bh);
  c.restore();
}
