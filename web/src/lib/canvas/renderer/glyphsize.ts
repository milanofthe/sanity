// Sizes a glyph is rasterised and drawn at. Apart from the atlas, which needs
// a canvas and the font, so the arithmetic can be tested on its own.

/** Cell height as a multiple of the em size, and where the baseline sits in
 *  the cell. Anything that places a glyph box has to use the same two
 *  numbers the cells were rasterised with. */
export const CELL_RATIO = 1.4;
export const BASELINE_RATIO = 1.05;

/**
 * Smallest and largest size an exact atlas is built at, in device pixels.
 *
 * Four rather than the eight this started at, because text takes over from
 * the token bars at four pixels per line, where the em is about three pixels
 * at dpr 1. With a floor of eight everything under 7.5 pixels an em was
 * scaled from an atlas too large for it: at 8 pixels per line on a dpr 1
 * screen, 18.9 percent of edge pixels mid-ramp against 18.0 drawn 1:1.
 */
const MIN_SIZE = 4;
const MAX_SIZE = 240;

/** The size an exact atlas for this em is built at, in device pixels. */
export function exactSize(emPixels: number): number {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(emPixels)));
}

/**
 * Whether an exact atlas for this em is built at the em's own rounded size,
 * so it can be drawn 1:1. Not outside the sizes built, where the atlas is
 * clamped and has to be scaled to the em again: drawn 1:1 there, text at
 * three pixels an em would come out at four.
 */
export function oneToOne(emPixels: number): boolean {
  return exactSize(emPixels) === Math.round(emPixels);
}

/** Where the baseline sits in a cell rasterised at `size`, in its pixels. */
export function baselineAt(size: number): number {
  return Math.round(size * BASELINE_RATIO);
}
