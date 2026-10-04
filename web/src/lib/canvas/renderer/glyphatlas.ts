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

/** Printable ASCII, which every atlas holds from the start and always in the
 *  same cells: essentially all of what code looks like at a glance. */
const ASCII_FIRST = 32;
const ASCII_LAST = 126;
const GRID_COLS = 16;

/**
 * The tallest an atlas texture is built, below what the context allows.
 *
 * Anything beyond ASCII gets a cell the first time it is drawn, so an atlas
 * holds what the repository actually uses: nothing more for one written in
 * English, a dozen umlauts and quotes for one in German, a few dozen letters
 * for one in Greek. Rasterising every character a document might hold up
 * front was five times the work at every settle of the camera, for glyphs
 * most scenes never show.
 *
 * The grid grows a row at a time, and what bounds it is this: as many rows as
 * one grid at the largest exact size fits, 24 or 384 cells, which takes any
 * alphabetic script with room to spare. Past them a character is skipped and
 * keeps its column. The subpixel phases stack only as far as this too, so no
 * atlas is larger than the ASCII one at its largest size always was, about
 * 2200 by 8100 pixels. A larger grid trades phases away first, which at the
 * sizes it happens is a quarter of a pixel at a 160 pixel em.
 */
const TEX_ROOM = 8192;

/** In the cell table: a code unit not asked for yet, and one without a glyph. */
const UNSEEN = -2;
const NONE = -1;

/** What gets no cell: control and format characters and lone surrogates,
 *  combining marks, which have nothing to sit on in a cell of their own, and
 *  spaces, which draw nothing anyway. */
const BLANK = /[\p{C}\p{M}\p{Z}]/u;

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
  /** The phases asked for, which `phases` is as many of as fit. */
  wantPhases: number;
  tex: WebGLTexture;
  cellW: number;
  cellH: number;
  texW: number;
  texH: number;
  /** The rows the texture is laid out for, and how many cells are drawn in
   *  it. Behind the atlas after a character first seen; see `fresh`. */
  rows: number;
  drawn: number;
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

  /** Tallest texture an atlas is built as; see `TEX_ROOM`. */
  private room: number;

  /** The code unit in each cell, in cell order. */
  private codes: number[] = [];
  /** Cell by UTF-16 code unit. A table rather than a map, since it is read
   *  once per character drawn. */
  private cellOf = new Int16Array(0x10000).fill(UNSEEN);
  /** Rows the grid may grow to: as many as one grid at the largest exact
   *  size fits in a texture. */
  private maxRows: number;

  constructor(private gl: WebGL2RenderingContext) {
    this.room = Math.min(TEX_ROOM, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.maxRows = Math.floor(this.room / Math.ceil(MAX_SIZE * CELL_RATIO));
    for (let c = ASCII_FIRST; c <= ASCII_LAST; c++) this.cellOf[c] = this.codes.push(c) - 1;

    const size = SIZES[SIZES.length - 1];
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    const caps = ctx.measureText('M');
    this.advanceRatio = caps.width / size;
    this.capRatio = caps.actualBoundingBoxAscent / size;
    this.descenderRatio = ctx.measureText('gyjpq').actualBoundingBoxDescent / size;

    for (const s of SIZES) this.levels.push(this.build(s, 1));
  }

  /**
   * The cell for a UTF-16 code unit, or -1 when it has none.
   *
   * A character not seen before is given the next free cell here, and each
   * level draws it the next time it is picked. Cells are never reassigned, so
   * an index handed out stays valid for the life of the atlas.
   */
  index(code: number): number {
    const cell = this.cellOf[code];
    if (cell !== UNSEEN) return cell;
    const room = this.codes.length < this.maxRows * GRID_COLS;
    const next = room && !BLANK.test(String.fromCharCode(code)) ? this.codes.push(code) - 1 : NONE;
    this.cellOf[code] = next;
    return next;
  }

  /** Rows of the grid, for the cells handed out so far. */
  private get rows(): number {
    return Math.ceil(this.codes.length / GRID_COLS);
  }

  private build(size: number, wantPhases: number): Level {
    const { gl } = this;
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    // Generous cell padding: descenders and the odd wide glyph must not bleed
    // into the neighbouring cell once the texture is filtered.
    const cellW = Math.ceil(ctx.measureText('M').width) + 4;
    const cellH = Math.ceil(size * CELL_RATIO);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return this.fresh({ size, phases: 0, wantPhases, tex, cellW, cellH, texW: 0, texH: 0, rows: 0, drawn: 0 });
  }

  /**
   * A level brought up to the cells handed out so far.
   *
   * Laid out again when the grid has grown a row, since every phase after the
   * first moves with it, and otherwise drawn only where cells were added.
   * Both are rare: a row is sixteen new characters, and a character is new
   * once.
   */
  private fresh(l: Level): Level {
    const rows = this.rows;
    if (l.rows !== rows) {
      // Each phase is a full grid of glyphs below the previous one, as many
      // as fit: at the largest size four grids of ASCII are 8064 pixels tall.
      const { gl } = this;
      l.phases = Math.max(1, Math.min(l.wantPhases, Math.floor(this.room / (l.cellH * rows))));
      l.texW = l.cellW * GRID_COLS;
      l.texH = l.cellH * rows * l.phases;
      l.rows = rows;
      l.drawn = 0;
      gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, l.texW, l.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    if (l.drawn < this.codes.length) this.paint(l);
    return l;
  }

  /** Rasterise the rows holding cells the level has not drawn yet, in every
   *  phase, and upload them in place. */
  private paint(l: Level): void {
    const { gl } = this;
    const first = Math.floor(l.drawn / GRID_COLS);
    const from = first * GRID_COLS;
    const canvas = document.createElement('canvas');
    canvas.width = l.texW;
    canvas.height = (l.rows - first) * l.cellH;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${l.size}px ${font.mono}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const advance = ctx.measureText('M').width;
    const baseline = GlyphAtlas.baselineAt(l.size);

    // A character the monospace font lacks comes from whatever font the
    // browser falls back to, which is rarely the same width and often taller
    // than the line. A wider one is squeezed into the advance, a taller one
    // scaled down about its origin on the baseline, a narrower one centred,
    // all measured at this size rather than once: the fallback is not one
    // outline scaled, and Consolas draws `░` 1.57 em tall at 14 pixels and
    // 0.92 em at 240. The clip to the cell is what holds whatever the font
    // reports. ASCII is drawn as it always was.
    const fit = this.codes.slice(from).map((code) => {
      if (code <= ASCII_LAST) return null;
      const m = ctx.measureText(String.fromCharCode(code));
      const sy = Math.min(
        1,
        (baseline - 1) / Math.max(1e-6, m.actualBoundingBoxAscent),
        (l.cellH - baseline - 1) / Math.max(1e-6, m.actualBoundingBoxDescent),
      );
      const sx = Math.min(sy, m.width > 0 ? advance / m.width : 1);
      return { sx, sy, dx: (advance - m.width * sx) / 2 };
    });

    gl.bindTexture(gl.TEXTURE_2D, l.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (let p = 0; p < l.phases; p++) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = from; i < this.codes.length; i++) {
        const cx = (i % GRID_COLS) * l.cellW;
        const cy = (Math.floor(i / GRID_COLS) - first) * l.cellH;
        const x = cx + 2 + p / l.phases;
        const ch = String.fromCharCode(this.codes[i]);
        const f = fit[i - from];
        if (!f) {
          ctx.fillText(ch, x, cy + baseline);
          continue;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx + 1, cy + 1, l.cellW - 2, l.cellH - 2);
        ctx.clip();
        ctx.translate(x + f.dx, cy + baseline);
        ctx.scale(f.sx, f.sy);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, (p * l.rows + first) * l.cellH, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    l.drawn = this.codes.length;
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
   * camera gets, since an atlas per zoom step is a hundred glyphs or more
   * rasterised per frame.
   */
  pick(emPixels: number, exact = false): Level {
    const want = GlyphAtlas.exactSize(emPixels);
    if (exact) {
      const held = this.exact.get(want);
      if (held) {
        // Most recently used last, so `trim` can take from the front.
        this.exact.delete(want);
        this.exact.set(want, held);
        return this.fresh(held);
      }
      const built = this.build(want, SUBPIXEL_PHASES);
      this.exact.set(want, built);
      this.trim();
      return built;
    }
    const fixed = this.levels.find((l) => l.size >= emPixels) ?? this.levels[this.levels.length - 1];
    return this.fresh(fixed);
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
    if (held) return this.fresh(held);
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

  static readonly gridCols = GRID_COLS;
}

export type { Level as AtlasLevel };
