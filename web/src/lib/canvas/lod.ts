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
  // Text starts at four pixels per line and is fully up by six.
  //
  // Walked down from twelve-to-seventeen in three steps, because every guess
  // was too cautious in the same direction. Two things were wrong in the
  // reasoning. The first: the question is not when glyphs look good but when
  // they beat bars, and a soft word beats a sharp bar almost immediately,
  // since the bar is only ever a stand-in for the word. The second: a wide
  // band is not a gentle transition, it is a long stretch where neither
  // representation is fully there, so the band is now two pixels rather than
  // five.
  //
  // Four is the floor. Below it the em box is under three and a half pixels
  // and glyphs stop being distinguishable from noise, which is the one case
  // where bars really are the better picture.
  textFrom: 4,
  textTo: 6,
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

/**
 * How much of a file's colour comes from its language rather than its tokens.
 *
 * Measured on a 988 file project, 40 panels sampled at three zooms: with a
 * file a few pixels tall the luminance varies by 0.106 to 0.167 *within* a
 * panel and by 0.024 to 0.041 *between* panels, so three to four times as much
 * of it is the shape of the code as is the identity of the file. The shape is
 * worth keeping and the identity is worth adding. At this distance the useful
 * questions are what language, how big, and has it moved: area answers the
 * second and the treemap already gives it.
 */
export function languageTint(pxPerLine: number): number {
  // Tied to the texture rather than to a pair of numbers of its own: the tint
  // is a property of the overview texture, so it is there for as long as the
  // texture is and gone when the token bars take over. It used to fade out at
  // 1.6 pixels per line while the texture ran to 3.2, which put the colour
  // only at the zoom where a whole project is on screen and took it away
  // again as soon as anyone looked closer.
  return 1 - smoothstep(lodBands.tokensFrom, lodBands.tokensTo, pxPerLine);
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
 * Full while the overview texture is still underneath it. The texture fills a
 * line completely, one texel row per screen row, so a shorter bar is a
 * different picture of the same code: through the crossfade the two only
 * partly cover each other and the panel loses ink in the middle. Measured
 * across the hand-over at 0.68: mean luminance fell from 58 to 51 and stayed
 * there, which is the step you see as "the bars coming in".
 *
 * Past the hand-over there is no texture left to match, and thinning starts:
 * first a little, then properly as glyphs arrive, because a solid bar behind
 * half-drawn letters is denser than either representation on its own.
 */
export function spanBarHeight(pxPerLine: number): number {
  const toText = smoothstep(lodBands.textFrom, lodBands.textTo, pxPerLine);
  return SPAN_BAR_FILL - 0.34 * toText;
}

/**
 * How much of a line's height a token bar covers before glyphs arrive.
 *
 * Measured, not chosen. Three values were tried against the ink the panel
 * carries from 1.4 to 4.4 pixels per line, which is the whole hand-over:
 *
 *   0.68   mean luminance 58.7 down to 49.5, a spread of 9.2, and it stays
 *          low: the bars are visibly thinner than the texture they replace
 *   1.00   58.3 to 61.4, a spread of 9.4, overshooting in the other direction
 *          once the texture is gone
 *   0.78   58.7 to 51.9, a spread of 6.8, the flattest of the three
 *
 * A flat line is not reachable: a bar covers its token's width exactly and the
 * texture spreads it over 128 texels per panel, so the two never carry the
 * same ink. The number that matters is how much the picture changes while the
 * zoom is being turned, and that is what is minimised here.
 */
const SPAN_BAR_FILL = 0.78;
