// Level-of-detail weights: how much of each representation to draw at a given
// zoom, as one pure function.
//
// Extracted from the renderer because it had a bug that arithmetic makes
// obvious and a screenshot does not. The weights used to be:
//
//   spans    = smoothstep(3, 4.5, ppl) * (1 - smoothstep(10, 13, ppl))
//   glyphs   = smoothstep(10, 13, ppl)
//   overview = 1 - max(spans, glyphs)
//
// At 11.5 pixels per line spans and glyphs are both 0.5, so `max` is 0.5 and
// the overview texture comes back to 0.5 as well. All three representations
// then draw at half strength on top of each other, which is what the mush
// during the tokens-to-text transition was.
//
// Now the three weights are a partition: each hands over to the next and they
// sum to one at every zoom, which the tests assert across the whole range.

/** Pixels per line at which each hand-over happens.
 *
 *  The bands are wide because a narrow one reads as a switch rather than a
 *  transition, and they start later than they used to: token bars stay crisp
 *  down to about two pixels per line, so giving them up at three threw away
 *  the sharpest thing on screen, and text at ten pixels is small enough that
 *  losing the bars for it felt premature. */
export interface LodBands {
  /** Overview texture gives way to token geometry over this range. */
  tokensFrom: number;
  tokensTo: number;
  /** Token geometry gives way to glyphs over this range. */
  textFrom: number;
  textTo: number;
}

const DEFAULT_BANDS: LodBands = {
  tokensFrom: 1.8,
  tokensTo: 3.2,
  // Text is fully up at twelve pixels per line, which is where the em box is
  // about ten pixels and the code plainly readable. The band used to run from
  // twelve to seventeen, so at zoom 1 the glyphs were only forty percent in
  // and the bars still dominated text you could already read. The question is
  // not when glyphs become legible but when they become more useful than
  // bars, and that is as soon as they are legible at all.
  textFrom: 8,
  textTo: 12,
};

/**
 * Live bands, overridable with `?lod=tokensFrom,tokensTo,textFrom,textTo`.
 *
 * Adjustable because where a hand-over belongs is a judgement about how the
 * two representations look side by side, and that is settled by moving the
 * numbers while watching, not by reasoning about pixel counts. The status bar
 * reports the active values.
 */
export const lodBands: LodBands = { ...DEFAULT_BANDS };

export function setBands(next: Partial<LodBands>): void {
  Object.assign(lodBands, next);
}

/** Read an override from the query string. Ignores anything malformed or
 *  out of order, so a typo falls back to the defaults rather than to a
 *  layout where the bands cross. */
export function bandsFromQuery(search: string): Partial<LodBands> | null {
  const raw = new URLSearchParams(search).get('lod');
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  const [tokensFrom, tokensTo, textFrom, textTo] = parts;
  if (!(tokensFrom < tokensTo && tokensTo <= textFrom && textFrom < textTo)) return null;
  return { tokensFrom, tokensTo, textFrom, textTo };
}

export interface LodWeights {
  /** Overview texture. */
  overview: number;
  /** One quad per token span. */
  spans: number;
  /** Real text. */
  glyphs: number;
}

export type LodName = 'structure' | 'overview' | 'tokens' | 'text';

const smoothstep = (a: number, b: number, x: number): number => {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Weights for a zoom level, as a partition of one.
 *
 * Two independent hand-overs: the first fades the texture out as token
 * geometry comes in, the second fades that geometry out as glyphs come in.
 * Each representation's weight is the product of having arrived and not yet
 * left, so nothing that has handed over can come back.
 */
export function lodWeights(pxPerLine: number): LodWeights {
  const toTokens = smoothstep(lodBands.tokensFrom, lodBands.tokensTo, pxPerLine);
  const toText = smoothstep(lodBands.textFrom, lodBands.textTo, pxPerLine);
  return {
    overview: 1 - toTokens,
    spans: toTokens * (1 - toText),
    glyphs: toText,
  };
}

/** Which representation dominates, for the status bar. */
export function lodName(pxPerLine: number): LodName {
  const w = lodWeights(pxPerLine);
  if (w.glyphs >= 0.5) return 'text';
  if (w.spans >= 0.5) return 'tokens';
  // Below the point where a line is even a pixel tall, the texture is showing
  // structure rather than an overview of content.
  return pxPerLine >= 1 ? 'overview' : 'structure';
}

/**
 * How tall a token bar should be, as a fraction of the line height.
 *
 * Shrinks as glyphs arrive. Without this the crossfade puts solid bars behind
 * partly drawn letters at the same weight, and since a bar covers far more of
 * its line than the glyphs do, the middle of the transition is visibly denser
 * than either end. Thinning the bars keeps the ink roughly constant.
 */
export function spanBarHeight(pxPerLine: number): number {
  const toText = smoothstep(lodBands.textFrom, lodBands.textTo, pxPerLine);
  return 0.68 - 0.34 * toText;
}
