// Drawing a group of parts as one layer — shared by Mochi's outfits (./outfits.ts)
// and Tofu's (./tofu.ts).

type Ctx = CanvasRenderingContext2D;

let scratch: HTMLCanvasElement | null = null;

/**
 * Draws `fn` at `alpha` as one layer, so overlapping parts don't show through
 * each other while an outfit fades (SwiftUI's drawLayer on macOS).
 */
export function withLayer(ctx: Ctx, alpha: number, fn: (c: Ctx) => void) {
  if (alpha >= 0.999) {
    ctx.save();
    fn(ctx);
    ctx.restore();
    return;
  }
  const W = ctx.canvas.width;
  const Hh = ctx.canvas.height;
  scratch ??= document.createElement("canvas");
  if (scratch.width < W || scratch.height < Hh) {
    scratch.width = Math.max(scratch.width, W);
    scratch.height = Math.max(scratch.height, Hh);
  }
  const s = scratch.getContext("2d");
  if (!s) return;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, W, Hh);
  s.setTransform(ctx.getTransform());
  s.save();
  fn(s);
  s.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(scratch, 0, 0, W, Hh, 0, 0, W, Hh);
  ctx.restore();
}
