// Monospace glyph atlas, rasterised at runtime with Canvas2D. No font loader,
// no build step, no dependency.
//
// One atlas per size band rather than a single large one scaled down: a 96px
// atlas sampled at 11px is mush even with mipmaps, and readable text is the
// whole point of the innermost zoom level. MSDF would collapse this back to a
// single texture and is the obvious later upgrade; the interface here already
// hides which of the two is in use.

import { font } from '../tokens';

/** First and last code point in the atlas. Printable ASCII covers essentially
 *  all of what code looks like at a glance; anything else renders as a box. */
const FIRST = 32;
const LAST = 126;
export const GLYPH_COUNT = LAST - FIRST + 1;
const GRID_COLS = 16;
const GRID_ROWS = Math.ceil(GLYPH_COUNT / GRID_COLS);

/** Rasterisation sizes, in device pixels of em height. */
const SIZES = [20, 44, 96] as const;

interface Level {
  size: number;
  tex: WebGLTexture;
  cellW: number;
  cellH: number;
  texW: number;
  texH: number;
}

export class GlyphAtlas {
  private levels: Level[] = [];
  /** Glyph advance divided by em size, for the rasterised font. */
  advanceRatio = 0.6;

  constructor(private gl: WebGL2RenderingContext) {
    for (const size of SIZES) this.levels.push(this.build(size));
  }

  private build(size: number): Level {
    const { gl } = this;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `${size}px ${font.mono}`;
    const advance = ctx.measureText('M').width;
    if (size === SIZES[SIZES.length - 1]) this.advanceRatio = advance / size;

    // Generous cell padding: descenders and the odd wide glyph must not bleed
    // into the neighbouring cell once the texture is filtered.
    const cellW = Math.ceil(advance) + 4;
    const cellH = Math.ceil(size * 1.4);
    canvas.width = cellW * GRID_COLS;
    canvas.height = cellH * GRID_ROWS;

    ctx.font = `${size}px ${font.mono}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const baseline = Math.round(size * 1.05);
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { size, tex, cellW, cellH, texW: canvas.width, texH: canvas.height };
  }

  /** Pick the smallest level at least as large as the on-screen em size, so
   *  glyphs are minified rather than magnified wherever possible. */
  pick(emPixels: number): Level {
    for (const l of this.levels) if (l.size >= emPixels) return l;
    return this.levels[this.levels.length - 1];
  }

  /** Index into the atlas for a code point, or -1 when it has no glyph. */
  static index(code: number): number {
    return code >= FIRST && code <= LAST ? code - FIRST : -1;
  }

  static readonly gridCols = GRID_COLS;
  static readonly gridRows = GRID_ROWS;
}

export type { Level as AtlasLevel };
