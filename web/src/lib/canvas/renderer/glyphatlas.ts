// Monospace glyph atlas, rasterised at runtime with Canvas2D. No font loader,
// no build step, no dependency.
//
// One atlas per size band rather than a single large one scaled down: a 96px
// atlas sampled at 11px is mush even with mipmaps, and readable text is the
// whole point of the innermost zoom level. MSDF would collapse this back to a
// single texture and is the obvious later upgrade; the interface here already
// hides which of the two is in use.

import { font } from '$lib/metrics';
import { BASELINE_RATIO, CELL_RATIO, baselineAt, exactSize, oneToOne } from './glyphsize';

/** First and last code point in the atlas. Printable ASCII covers essentially
 *  all of what code looks like at a glance; anything else renders as a box. */
const FIRST = 32;
const LAST = 126;
export const GLYPH_COUNT = LAST - FIRST + 1;
const GRID_COLS = 16;
const GRID_ROWS = Math.ceil(GLYPH_COUNT / GRID_COLS);

/**
 * Rasterisation sizes, in device pixels of em height.
 *
 * Close together, because the gap between them is blur. A glyph is drawn from
 * the smallest level at least as large as it needs, so a level 2.2 times too
 * big is a glyph minified by 2.2 and read through the mip chain. Measured at
 * dpr 2 with three levels: at 6 pixels per line, 80 percent of the ink was
 * half-tone, which is the softness you see. Each step here is about 1.4, so
 * nothing is ever minified by more than that.
 */
const SIZES = [14, 20, 28, 40, 56, 80, 112] as const;

interface Level {
  size: number;
  /** Horizontal subpixel positions each glyph is rasterised at; see
   *  `SUBPIXEL_PHASES`. One for the fixed levels, which are only ever drawn
   *  scaled while the camera moves. */
  phases: number;
  tex: WebGLTexture;
  cellW: number;
  cellH: number;
  texW: number;
  texH: number;
}

export { BASELINE_RATIO, CELL_RATIO };

/**
 * Horizontal positions within a pixel an exact atlas holds each glyph at.
 *
 * A glyph at rest is drawn 1:1 from its cell, so it has to start on a whole
 * pixel, and a character is rarely a whole number of pixels wide: at 13.3
 * pixels per line on a dpr 1 screen it is 6.65, and snapping each glyph on
 * its own made the gaps between letters alternate between 6 and 7 pixels.
 * Browsers solve this the same way: the glyph is rasterised a few times at
 * fractional offsets, and each one is drawn from the variant nearest to where
 * it really falls, so the spacing is even to a quarter of a pixel.
 */
const SUBPIXEL_PHASES = 4;

export class GlyphAtlas {
  private levels: Level[] = [];
  /** Glyph advance divided by em size, for the rasterised font. */
  advanceRatio = 0.6;
  /** How far a capital reaches above the baseline, and a descender below it,
   *  as multiples of the em size. Measured off the font rather than assumed,
   *  because what needs them is the chrome: a name centred in a title bar by
   *  guessed metrics is a name with its descenders clipped. */
  capRatio = 0.72;
  descenderRatio = 0.21;

  /** Largest texture side the context takes, for fitting the phases in. */
  private maxTexSize: number;

  constructor(private gl: WebGL2RenderingContext) {
    this.maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    for (const size of SIZES) this.levels.push(this.build(size, 1));
  }

  private build(size: number, wantPhases: number): Level {
    const { gl } = this;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    const advance = ctx.measureText('M').width;
    if (size === SIZES[SIZES.length - 1]) {
      this.advanceRatio = advance / size;
      const caps = ctx.measureText('M');
      const tails = ctx.measureText('gyjpq');
      this.capRatio = caps.actualBoundingBoxAscent / size;
      this.descenderRatio = tails.actualBoundingBoxDescent / size;
    }

    // Generous cell padding: descenders and the odd wide glyph must not bleed
    // into the neighbouring cell once the texture is filtered.
    const cellW = Math.ceil(advance) + 4;
    const cellH = Math.ceil(size * CELL_RATIO);
    // Each phase is a full grid of glyphs below the previous one. As many as
    // fit the context's largest texture: WebGL2 promises 2048, and at the
    // largest size four grids are 8064 pixels tall.
    const phases = Math.max(1, Math.min(wantPhases, Math.floor(this.maxTexSize / (cellH * GRID_ROWS))));
    canvas.width = cellW * GRID_COLS;
    canvas.height = cellH * GRID_ROWS * phases;

    ctx.font = `${size}px ${font.mono}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const baseline = GlyphAtlas.baselineAt(size);
    for (let p = 0; p < phases; p++) {
      const top = p * GRID_ROWS * cellH;
      for (let i = 0; i < GLYPH_COUNT; i++) {
        const gx = (i % GRID_COLS) * cellW;
        const gy = top + Math.floor(i / GRID_COLS) * cellH;
        ctx.fillText(String.fromCharCode(FIRST + i), gx + 2 + p / phases, gy + baseline);
      }
    }

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { size, phases, tex, cellW, cellH, texW: canvas.width, texH: canvas.height };
  }

  /**
   * The level to draw with.
   *
   * `exact` rasterises one at the size asked for, rounded to a whole pixel,
   * and keeps a few of them. That is what makes text sharp: a glyph drawn from
   * an atlas 1.4 times too large is read through bilinear filtering at every
   * edge, and the difference is measurable, half the ink at an intermediate
   * tone against a fifth of it.
   *
   * Without it, the smallest fixed level at least as large as the size asked
   * for, so glyphs are minified rather than magnified. That is what a moving
   * camera gets, since an atlas per zoom step is 95 glyphs rasterised per
   * frame.
   */
  pick(emPixels: number, exact = false): Level {
    const want = GlyphAtlas.exactSize(emPixels);
    if (exact) {
      const held = this.exact.get(want);
      if (held) {
        // Most recently used last, so `trim` can take from the front.
        this.exact.delete(want);
        this.exact.set(want, held);
        return held;
      }
      const built = this.build(want, SUBPIXEL_PHASES);
      this.exact.set(want, built);
      this.trim();
      return built;
    }
    for (const l of this.levels) if (l.size >= emPixels) return l;
    return this.levels[this.levels.length - 1];
  }

  /**
   * An exact level for the directory labels, which are drawn at a few fixed
   * screen sizes whatever the zoom. Kept apart from the code's, which would
   * otherwise evict each other every frame: four label sizes and the code's
   * own size are five, against a cache of four.
   */
  label(emPixels: number): Level {
    const want = GlyphAtlas.exactSize(emPixels);
    const held = this.labels.get(want);
    if (held) return held;
    const built = this.build(want, SUBPIXEL_PHASES);
    this.labels.set(want, built);
    // A change of screen changes every size; the old ones go.
    if (this.labels.size > GlyphAtlas.LABELS_KEEP) {
      const [size, level] = this.labels.entries().next().value as [number, Level];
      this.gl.deleteTexture(level.tex);
      this.labels.delete(size);
    }
    return built;
  }

  private labels = new Map<number, Level>();
  private static readonly LABELS_KEEP = 10;

  /** Atlases rasterised at an exact size, newest last. */
  private exact = new Map<number, Level>();

  /** How many of those to keep. Four covers a zoom that settles, comes back
   *  and settles again, at a megabyte or two each. */
  private static readonly EXACT_KEEP = 4;

  private trim(): void {
    while (this.exact.size > GlyphAtlas.EXACT_KEEP) {
      const [size, level] = this.exact.entries().next().value as [number, Level];
      this.gl.deleteTexture(level.tex);
      this.exact.delete(size);
    }
  }

  static readonly exactSize = exactSize;
  static readonly oneToOne = oneToOne;
  static readonly baselineAt = baselineAt;

  /** Index into the atlas for a code point, or -1 when it has no glyph. */
  static index(code: number): number {
    return code >= FIRST && code <= LAST ? code - FIRST : -1;
  }

  static readonly gridCols = GRID_COLS;
  static readonly gridRows = GRID_ROWS;
}

export type { Level as AtlasLevel };
