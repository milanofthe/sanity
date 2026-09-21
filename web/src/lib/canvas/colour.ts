// Colour arithmetic for the renderer, as pure functions.
//
// Here rather than inline because it is the kind of thing that looks right and
// is not. `mixToward` sets the target to the base's own luminance before
// mixing, which is exactly what a directory tint wants, a hue at the
// background's brightness. Used for a changed-line band it produces a band
// with no contrast at all: the sanity theme's added colour is near white, and
// matching it to a charcoal panel turned it into charcoal. The band was being
// drawn, in the right place, and was invisible.

/** Unpack 0xRRGGBB into normalised channels. */
export const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
];

/** Pack normalised channels back, clamped. */
export const pack = (r: number, g: number, b: number): number => {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
};

/** Relative luminance, Rec. 709 weights, on the raw channels. */
export const luminance = (hex: number): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * The same colour at a different luminance, keeping its hue.
 *
 * Two directions, because neither one works on its own. Scaling the channels
 * down darkens correctly but cannot brighten past white; lifting towards white
 * brightens correctly but desaturates. So darkening scales and brightening
 * lifts, which is what keeps a hue recognisable at both ends.
 */
export function atLuminance(hex: number, want: number): number {
  const [r, g, b] = rgb(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const target = Math.max(0, Math.min(1, want));
  if (lum <= 0) return pack(target, target, target);
  if (target <= lum) {
    const k = target / lum;
    return pack(r * k, g * k, b * k);
  }
  // Lift towards white by the fraction of the remaining headroom needed.
  const k = Math.min(1, (target - lum) / Math.max(1e-6, 1 - lum));
  return pack(r + (1 - r) * k, g + (1 - g) * k, b + (1 - b) * k);
}

/**
 * A colour used at the base's own luminance, then mixed in.
 *
 * For tints that must not change how light something is: a directory frame
 * takes a hue from the palette without becoming brighter or darker than the
 * background it sits on.
 */
export function mixToward(base: number, target: number, amount: number): number {
  if (amount <= 0) return base;
  const lum = luminance(base);
  if (luminance(target) <= 0) return base;
  const matched = rgb(atLuminance(target, lum));
  const [br, bg, bb] = rgb(base);
  return pack(
    br * (1 - amount) + matched[0] * amount,
    bg * (1 - amount) + matched[1] * amount,
    bb * (1 - amount) + matched[2] * amount,
  );
}

/**
 * Bounds on how far a band's brightness may sit from the panel's, as a
 * fraction of `strength`.
 *
 * Both ends are needed and both were found the hard way. Without the floor, a
 * change colour close to the panel's own brightness produces a band nobody can
 * see: the sanity theme's added colour is near white, and a plain mix towards
 * it barely moved a charcoal panel. Without the ceiling, a saturated one
 * blows out: `--deleted` is pure red, and setting its luminance without
 * bounding it gave a band of fluorescent red with unreadable code on top.
 */
const MIN_STEP = 0.12;
const MAX_STEP = 0.35;

/**
 * A background band for a changed line.
 *
 * Two things at once, and neither works alone. The panel is mixed towards the
 * change colour, which is what carries the hue and, just as importantly,
 * desaturates it: a band of pure red behind code is overwhelming at any
 * brightness, because luminance and saturation are different things. Then the
 * result's brightness is pushed to a bounded distance from the panel's, which
 * is what keeps a low-contrast palette visible and a high-contrast one
 * readable.
 *
 * The step goes away from whatever the panel is, so a light theme needs no
 * second rule.
 */
export function bandColour(panel: number, change: number, strength: number): number {
  if (strength <= 0) return panel;
  const [pr, pg, pb] = rgb(panel);
  const [cr, cg, cb] = rgb(change);
  const mixed = pack(
    pr + (cr - pr) * strength,
    pg + (cg - pg) * strength,
    pb + (cb - pb) * strength,
  );

  const lp = luminance(panel);
  const away = lp < 0.5 ? 1 : -1;
  const natural = Math.abs(luminance(mixed) - lp);
  const step = Math.min(MAX_STEP * strength, Math.max(MIN_STEP * strength, natural));
  return atLuminance(mixed, lp + away * step);
}
