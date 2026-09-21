// The settle animation as pure arithmetic, separate from the renderer.
//
// Same reason lod.ts exists: this is a similarity transform with a translation
// folded into it, and getting it wrong produces something that still moves and
// still ends in the right place, so it looks plausible while being off by a
// factor. The first version scaled the translation by (1 - scale), which meant
// a panel started a fraction of the way from its old position rather than at
// it. Nothing about the picture said so.
//
// The transform is applied as `X = x * scale + bx`, which is one multiply and
// one add per coordinate. That matters: it runs once per instance, and a frame
// can push sixty thousand of them.

// Relative rather than through the `$lib` alias, because node's test runner
// resolves imports itself and knows nothing about Vite's aliases. Every module
// that reaches for `$lib` is unreachable from a unit test, and this one has
// arithmetic worth testing.
import { timing } from '../metrics.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A panel's settle animation.
 *
 * Only the starting values are stored. The current ones are interpolated from
 * `t`, so the animation is a pure function of how far along it is and cannot
 * accumulate error over the frames it runs for.
 */
export interface PanelAnim {
  /** Scale at t = 0. */
  s0: number;
  /** World translation at t = 0, applied after the scale. */
  dx0: number;
  dy0: number;
  /** Alpha at t = 0. */
  a0: number;
  /** Seconds before it starts, for the stagger on first appearance. */
  delay: number;
  /** Seconds it runs for. */
  dur: number;
  /** Elapsed seconds, including the delay. */
  t: number;
}

/** What the renderer applies while pushing a panel's geometry. */
export interface Transform {
  scale: number;
  bx: number;
  by: number;
  alpha: number;
}

export const IDENTITY: Transform = { scale: 1, bx: 0, by: 0, alpha: 1 };

/** Ease-out cubic: fast away from the old state, slow into the new one. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Progress of an animation, 0 through the delay and 1 once it is done. */
export function progress(a: PanelAnim): number {
  if (a.t <= a.delay) return 0;
  return Math.min(1, (a.t - a.delay) / a.dur);
}

export function finished(a: PanelAnim): boolean {
  return a.t >= a.delay + a.dur;
}

/**
 * The transform for a panel at its target rect, part way through `anim`.
 *
 * `X = x * scale + bx` where the scale is taken about the panel's own origin
 * and the translation is applied after it, so at e = 0 the panel is drawn at
 * `scale = s0` with its origin at `target.x + dx0`.
 */
export function transformFor(target: Rect, anim: PanelAnim): Transform {
  const e = easeOut(progress(anim));
  const scale = anim.s0 + (1 - anim.s0) * e;
  const shift = 1 - e;
  return {
    scale,
    bx: target.x * (1 - scale) + anim.dx0 * shift,
    by: target.y * (1 - scale) + anim.dy0 * shift,
    alpha: anim.a0 + (1 - anim.a0) * e,
  };
}

/** Apply a transform to a rect, which is what ends up on screen. */
export function applyTo(tf: Transform, r: Rect): Rect {
  return {
    x: r.x * tf.scale + tf.bx,
    y: r.y * tf.scale + tf.by,
    w: r.w * tf.scale,
    h: r.h * tf.scale,
  };
}

/**
 * Animate a panel from where it used to be.
 *
 * A similarity rather than a plain offset because a relayout resizes panels as
 * well as moving them: measured on a real project, an edit that rearranges
 * anything resizes 841 of 989 panels. Sliding the frame while the text inside
 * stayed at its final size would come apart. A uniform scale takes the
 * contents with it, and it approximates a change of aspect ratio, which over a
 * third of a second is not something anyone can see.
 */
export function slideFrom(was: Rect, target: Rect): PanelAnim {
  // Area-matched uniform scale, clamped: a panel that changed size by a factor
  // of ten should move rather than explode.
  const ratio = Math.sqrt((was.w * was.h) / Math.max(1, target.w * target.h));
  const s0 = Math.min(4, Math.max(0.25, ratio));
  return {
    s0,
    // Puts the panel's centre where the old centre was.
    dx0: was.x + was.w / 2 - target.x - (s0 * target.w) / 2,
    dy0: was.y + was.h / 2 - target.y - (s0 * target.h) / 2,
    a0: 1,
    delay: 0,
    dur: timing.reflow,
    t: 0,
  };
}

/**
 * Settle a panel in that was not there before.
 *
 * Scaled about its own centre, so it grows into its slot rather than sliding
 * in from a corner, and delayed by `delay` seconds so a project can bloom
 * outward instead of arriving as one block.
 */
export function settleIn(target: Rect, delay: number): PanelAnim {
  const s0 = timing.appearScale;
  const grow = (1 - s0) / 2;
  return {
    s0,
    dx0: target.w * grow,
    dy0: target.h * grow,
    a0: 0,
    delay,
    dur: timing.appear,
    t: 0,
  };
}

/** Whether two rects are the same, so an unmoved panel animates not at all. */
export function same(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
