// Monospace glyph atlas, rasterised at runtime with Canvas2D. No font loader,
// no build step, no dependency.
//
// One atlas per size band rather than a single large one scaled down: a 96px
// atlas sampled at 11px is mush even with mipmaps, and readable text is the
// whole point of the innermost zoom level. MSDF would collapse this back to a
// single texture and is the obvious later upgrade; the interface here already
// hides which of the two is in use.

import { font } from '$lib/metrics';
import { BASELINE_RATIO, CELL_RATIO, MAX_SIZE, baselineAt, exactSize, oneToOne } from './glyphsize';

/**
 * The code points in the atlas, in cell order.
 *
 * Printable ASCII first, so its cells are where they always were. Then what
 * comments, strings and documentation hold once they are written in anything
 * but English: the Latin-1 and Latin Extended-A letters (German, French,
 * Spanish, the Nordic and Central European languages, Turkish), the four
 * Romanian ones from Extended-B, and Greek, which scientific code names its
 * variables in. Last the punctuation, arrows, mathematical signs and box
 * drawing that Markdown and doc comments use.
 *
 * With only ASCII in it, an `ä` or an em dash was skipped, and German prose
 * came out with holes in its words. Anything still missing is skipped the same
 * way and keeps its column.
 */
const RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x100, 0x17f],
  [0x218, 0x21b],
  [0x391, 0x3a1],
  [0x3a3, 0x3a9],
  [0x3b1, 0x3c9],
];
const SYMBOLS =
  '‐–—‘’‚“”„†‡•…‰′″‹›€™' +
  '←↑→↓↔↕⇐⇒⇔' +
  '∀∂∃∅∇∈∉∑−√∞∧∨∩∪∫≈≠≡≤≥⋅' +
  '─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰' +
  '█░▒▓■□▲▶▼◀●○★☆✓✔✗✘';

const CODES: readonly number[] = [
  ...RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)),
  ...Array.from(SYMBOLS, (c) => c.codePointAt(0)!),
];
export const GLYPH_COUNT = CODES.length;
/** How many cells the printable ASCII takes, at the front. */
const ASCII = 0x7e - 0x20 + 1;
/** Wide enough that the grid is about square at the cell's proportions, so
 *  the largest atlas is bounded on both sides rather than tall and thin. */
const GRID_COLS = 32;
const GRID_ROWS = Math.ceil(GLYPH_COUNT / GRID_COLS);

/** Cell index by code point, -1 for none. A table rather than a map, since
 *  it is read once per character drawn. */
const CELL = new Int16Array(Math.max(...CODES) + 1).fill(-1);
CODES.forEach((c, i) => (CELL[c] = i));

/**
 * The tallest or widest texture an atlas is built as, below what the context
 * allows. At the largest size one grid is about 4800 by 5100 pixels, a
 * hundred megabytes with its mips; letting the subpixel phases stack on top
 * of that up to a 16384 limit would be three times as much for a size where
 * a quarter of a pixel is invisible anyway.
 */
const TEX_ROOM = 8192;

/**
 * Empty texels between neighbouring cells. The ASCII glyphs keep well clear
 * of their cell's edges, but box drawing and the shade blocks are drawn to
 * the full height of the line, and sampled at a cell's edge they picked up
 * the edge of the glyph in the next row: a bar under `≤` from the `▓` below
 * it, dots under `≠` from the `░`. The quad still covers only the cell.
 */
const GAP = 2;

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
  /** Cell plus `GAP`: how far apart the cells sit in the texture. */
  pitchW: number;
  pitchH: number;
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

  /**
   * Each glyph's own width as a multiple of the advance, and the scale that
   * keeps its ink inside the cell's height. One for everything the monospace
   * font has; a character it lacks is drawn from whatever font the browser
   * falls back to, which is rarely the same width and, for the mathematical
   * signs, often taller than the line. Either way it would reach into a
   * neighbouring cell and show up as a stray mark under or beside another
   * glyph, so a wider one is squeezed into the cell, a taller one scaled
   * down to it, and a narrower one centred in it. ASCII is left as it always
   * was drawn.
   */
  private widths = new Float32Array(GLYPH_COUNT).fill(1);
  private heights = new Float32Array(GLYPH_COUNT).fill(1);

  /** Largest texture side an atlas is built as; see `TEX_ROOM`. */
  private room: number;

  /**
   * The largest exact size whose grid fits a texture. `MAX_SIZE` wherever
   * textures go to 8192, which is everywhere this is meant to run; on a
   * context limited to 4096 it is about 190, and text larger than that is
   * scaled from it rather than drawn from an atlas that cannot be built.
   */
  readonly maxExact: number;

  constructor(private gl: WebGL2RenderingContext) {
    this.room = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, TEX_ROOM);
    this.measure(SIZES[SIZES.length - 1]);
    let max = MAX_SIZE;
    while (max > SIZES[0] && !this.fits(max)) max--;
    this.maxExact = max;
    for (const size of SIZES) if (size <= max || size === SIZES[0]) this.levels.push(this.build(size, 1));
  }

  /** The font's metrics, and every glyph's width against them. */
  private measure(size: number): void {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    const advance = ctx.measureText('M').width;
    this.advanceRatio = advance / size;
    this.capRatio = ctx.measureText('M').actualBoundingBoxAscent / size;
    this.descenderRatio = ctx.measureText('gyjpq').actualBoundingBoxDescent / size;
    // A pixel of the reference size to spare on either side, for the
    // rounding of the baseline at smaller ones.
    const above = BASELINE_RATIO - 1 / size;
    const below = CELL_RATIO - BASELINE_RATIO - 1 / size;
    for (let i = ASCII; i < GLYPH_COUNT; i++) {
      const m = ctx.measureText(String.fromCodePoint(CODES[i]));
      if (m.width > 0) this.widths[i] = m.width / advance;
      this.heights[i] = Math.min(
        1,
        above / Math.max(1e-6, m.actualBoundingBoxAscent / size),
        below / Math.max(1e-6, m.actualBoundingBoxDescent / size),
      );
    }
  }

  /** Whether one grid at `size` fits a texture, with a pixel to spare on the
   *  advance for the difference between measuring at this size and at the
   *  reference one. */
  private fits(size: number): boolean {
    const pitchW = Math.ceil(this.advanceRatio * size + 1) + 4 + GAP;
    const pitchH = Math.ceil(size * CELL_RATIO) + GAP;
    return pitchW * GRID_COLS <= this.room && pitchH * GRID_ROWS <= this.room;
  }

  private build(size: number, wantPhases: number): Level {
    const { gl } = this;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    const advance = ctx.measureText('M').width;

    // Generous cell padding: descenders and the odd wide glyph must not bleed
    // into the neighbouring cell once the texture is filtered.
    const cellW = Math.ceil(advance) + 4;
    const cellH = Math.ceil(size * CELL_RATIO);
    const pitchW = cellW + GAP;
    const pitchH = cellH + GAP;
    // Each phase is a full grid of glyphs below the previous one, as many as
    // fit the texture.
    const phases = Math.max(1, Math.min(wantPhases, Math.floor(this.room / (pitchH * GRID_ROWS))));
    canvas.width = pitchW * GRID_COLS;
    canvas.height = pitchH * GRID_ROWS * phases;

    ctx.font = `${size}px ${font.mono}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const baseline = GlyphAtlas.baselineAt(size);
    for (let p = 0; p < phases; p++) {
      const top = p * GRID_ROWS * pitchH;
      for (let i = 0; i < GLYPH_COUNT; i++) {
        const gx = (i % GRID_COLS) * pitchW + 2 + p / phases;
        const gy = top + Math.floor(i / GRID_COLS) * pitchH + baseline;
        const ch = String.fromCodePoint(CODES[i]);
        const w = this.widths[i];
        const h = this.heights[i];
        if (w === 1 && h === 1) {
          ctx.fillText(ch, gx, gy);
        } else {
          // Scaled about the glyph's own origin on the baseline, so a glyph
          // made smaller stays on the line.
          const sx = Math.min(h, 1 / w);
          ctx.setTransform(sx, 0, 0, h, gx + (advance * (1 - w * sx)) / 2, gy * (1 - h));
          ctx.fillText(ch, 0, gy);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
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

    return { size, phases, tex, cellW, cellH, pitchW, pitchH, texW: canvas.width, texH: canvas.height };
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
   * camera gets, since an atlas per zoom step is every glyph in it rasterised
   * per frame.
   */
  pick(emPixels: number, exact = false): Level {
    const want = this.exactSize(emPixels);
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
    const want = this.exactSize(emPixels);
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

  /** `exactSize` and `oneToOne` from glyphsize.ts, held to the largest atlas
   *  this context can build. */
  exactSize(emPixels: number): number {
    return exactSize(emPixels, this.maxExact);
  }
  oneToOne(emPixels: number): boolean {
    return oneToOne(emPixels, this.maxExact);
  }

  static readonly baselineAt = baselineAt;

  /** Index into the atlas for a code point, or -1 when it has no glyph. */
  static index(code: number): number {
    return code < CELL.length ? CELL[code] : -1;
  }

  static readonly gridCols = GRID_COLS;
  static readonly gridRows = GRID_ROWS;
}

export type { Level as AtlasLevel };
