// Monospace glyph atlas, rasterised at runtime with Canvas2D. No font loader,
// no build step, no dependency.
//
// One atlas per size band rather than a single large one scaled down: a 96px
// atlas sampled at 11px is mush even with mipmaps, and readable text is the
// whole point of the innermost zoom level. MSDF would collapse this back to a
// single texture and is the obvious later upgrade; the interface here already
// hides which of the two is in use.

import { font } from '$lib/metrics';

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
  tex: WebGLTexture;
  cellW: number;
  cellH: number;
  texW: number;
  texH: number;
}

/** Cell height as a multiple of the em size, and where the baseline sits in
 *  the cell. Anything that places a glyph box has to use the same two
 *  numbers the cells were rasterised with. */
export const CELL_RATIO = 1.4;
export const BASELINE_RATIO = 1.05;

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

  constructor(private gl: WebGL2RenderingContext) {
    for (const size of SIZES) this.levels.push(this.build(size));
  }

  private build(size: number): Level {
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
    canvas.width = cellW * GRID_COLS;
    canvas.height = cellH * GRID_ROWS;

    ctx.font = `${size}px ${font.mono}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const baseline = Math.round(size * BASELINE_RATIO);
    for (let i = 0; i < GLYPH_COUNT; i++) {
      const gx = (i % GRID_COLS) * cellW;
      const gy = Math.floor(i / GRID_COLS) * cellH;
      ctx.fillText(String.fromCharCode(FIRST + i), gx + 2, gy + baseline);
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

    return { size, tex, cellW, cellH, texW: canvas.width, texH: canvas.height };
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
    const want = Math.max(8, Math.min(240, Math.round(emPixels)));
    if (exact) {
      const held = this.exact.get(want);
      if (held) {
        // Most recently used last, so `trim` can take from the front.
        this.exact.delete(want);
        this.exact.set(want, held);
        return held;
      }
      const built = this.build(want);
      this.exact.set(want, built);
      this.trim();
      return built;
    }
    for (const l of this.levels) if (l.size >= emPixels) return l;
    return this.levels[this.levels.length - 1];
  }

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

  /** Index into the atlas for a code point, or -1 when it has no glyph. */
  static index(code: number): number {
    return code >= FIRST && code <= LAST ? code - FIRST : -1;
  }

  static readonly gridCols = GRID_COLS;
  static readonly gridRows = GRID_ROWS;
}

export type { Level as AtlasLevel };
