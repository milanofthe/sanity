// Rasterising a file's overview: its token spans onto a grid of texels, and
// the mip chain reduced from it. Pure arithmetic on the file's arrays, apart
// from the GL that uploads the result, so it runs on the main thread for a
// single file and in workers for a project being opened; see rasterpool.ts.

import { overview } from '$lib/metrics';
import { spanCol, spanKind, spanLen } from '$lib/canvas/data/wire';

/**
 * Weight a fully desaturated texel keeps when a mip level is reduced.
 *
 * At 1 the reduction is a plain average and colour washes out; at 0 a single
 * saturated texel would take over its whole block and the overview would
 * crawl while zooming. A quarter keeps comments and strings legible several
 * levels out without either happening.
 */
const SAT_FLOOR = 0.25;

/** Largest height class, which sizes the scratch buffers. */
const MAX_ROWS = 4096;

/** What one file's overview is rasterised from. */
export interface RasterInput {
  lineCount: number;
  spans: Uint32Array;
  spanStart: Uint32Array;
  /** Screen row each source line starts on, at the panel's column width. */
  rows: Uint32Array;
  /** The panel's column width, so the texture lines up with the text. */
  panelCols: number;
  /** Texel rows the file covers, and rows of its layer, at full resolution. */
  texelRows: number;
  classRows: number;
  /** Finest mip level wanted; the ones before it are computed and dropped. */
  level: number;
  /** Overview colours as triples, indexed by token kind. */
  kindRgb: Float32Array;
}

/** Called once per mip level from `level` on, with a view of scratch memory
 *  that is only valid until the call returns. */
export type EmitLevel = (level: number, w: number, h: number, data: Uint8Array) => void;

export class OverviewRaster {
  /** Scratch accumulators, sized for the largest class. */
  private acc: Float32Array;
  private cov: Float32Array;
  /**
   * Scratch for the base and the mip chain.
   *
   * These used to be allocated per file: one layer-sized array for the base,
   * which is two megabytes for the largest height class, plus one per mip
   * level. Over a thousand files that is gigabytes of allocation for buffers
   * that live a fraction of a millisecond each, and it measured 453
   * milliseconds of the time to open a project. Reused instead, with two mip
   * buffers so a reduction never reads and writes the same one.
   */
  private full: Uint8Array;
  private mipA: Uint8Array;
  private mipB: Uint8Array;

  constructor() {
    const maxTexels = overview.texCols * MAX_ROWS;
    this.acc = new Float32Array(maxTexels * 3);
    this.cov = new Float32Array(maxTexels);
    this.full = new Uint8Array(maxTexels * 4);
    // A reduction halves both dimensions, so the largest output is a quarter
    // of the base. One buffer of that size each is enough to ping-pong.
    this.mipA = new Uint8Array(maxTexels);
    this.mipB = new Uint8Array(maxTexels);
  }

  /**
   * Rasterise a file and hand over its mip levels from `level` on.
   *
   * Coverage is accumulated fractionally: a token narrower than a texel
   * contributes its fraction rather than snapping on or off, which is the
   * difference between a stable image and one that crawls while zooming.
   * Always from full resolution, whatever level is wanted, so a coarse layer
   * is exactly the mip a full one would have had and swapping between them
   * changes nothing on screen.
   */
  run(input: RasterInput, emit: EmitLevel): void {
    const f = input;
    const { rows, panelCols, texelRows, kindRgb } = input;
    const tw = overview.texCols;
    const th = input.classRows;
    const texels = tw * texelRows;

    const acc = this.acc;
    const cov = this.cov;
    acc.fill(0, 0, texels * 3);
    cov.fill(0, 0, texels);

    const scaleX = tw / Math.max(1, panelCols);
    // Screen rows, not source lines: a wrapped line occupies several rows on
    // the panel, and the texture has to agree with the panel about which row
    // holds what, or the overview would not line up with the token geometry it
    // fades into.
    const screenRows = Math.max(1, rows[f.lineCount]);
    const texelsPerRow = texelRows / screenRows;
    // How many screen rows share one texel row, at least one.
    const perTexel = Math.max(1, screenRows / texelRows);

    for (let i = 0; i < f.lineCount; i++) {
      const lineRow = rows[i];
      const s0 = f.spanStart[i];
      const s1 = f.spanStart[i + 1];
      for (let s = s0; s < s1; s++) {
        const packed = f.spans[s];
        const kind = spanKind(packed);
        const ci = kind * 3;
        const cr = kindRgb[ci];
        const cg = kindRgb[ci + 1];
        const cb = kindRgb[ci + 2];
        const col = spanCol(packed);
        // Which wrapped row this span sits on, and where within it. One
        // division rather than a divide and a modulo.
        const wrapRow = panelCols > 0 ? (col / panelCols) | 0 : 0;
        const ty = Math.min(texelRows - 1, ((lineRow + wrapRow) * texelsPerRow) | 0);
        const rowBase = ty * tw;
        const x0 = (panelCols > 0 ? col - wrapRow * panelCols : col) * scaleX;
        const x1 = Math.min(tw, x0 + spanLen(packed) * scaleX);
        if (x1 <= x0) continue;
        const tx0 = x0 | 0;
        const tx1 = Math.min(tw - 1, Math.ceil(x1) - 1);
        for (let tx = tx0; tx <= tx1; tx++) {
          const k = Math.min(x1, tx + 1) - Math.max(x0, tx);
          if (k <= 0) continue;
          const t = rowBase + tx;
          cov[t] += k;
          const a = t * 3;
          acc[a] += cr * k;
          acc[a + 1] += cg * k;
          acc[a + 2] += cb * k;
        }
      }
    }

    // Straight into the buffer that gets uploaded. There used to be a second
    // array here and a copy of it afterwards, which is a hundred kilobytes per
    // file for no benefit.
    const full = this.full;
    const invPerTexel = 255 / perTexel;
    for (let t = 0; t < texels; t++) {
      const k = cov[t];
      const o = t * 4;
      if (k <= 0) {
        full[o] = 0;
        full[o + 1] = 0;
        full[o + 2] = 0;
        full[o + 3] = 0;
        continue;
      }
      const a = t * 3;
      const inv = 255 / k;
      const r = acc[a] * inv;
      const g = acc[a + 1] * inv;
      const b = acc[a + 2] * inv;
      const al = k * invPerTexel;
      full[o] = r > 255 ? 255 : r;
      full[o + 1] = g > 255 ? 255 : g;
      full[o + 2] = b > 255 ? 255 : b;
      full[o + 3] = al > 255 ? 255 : al;
    }

    // The mip chain is built from the whole layer, transparent rows past the
    // end of a short file included, so reducing cannot pull in whatever a
    // previous file left in the scratch buffer. Only those rows are cleared,
    // not the whole layer, which would cost more than the allocation did.
    full.fill(0, tw * texelRows * 4, tw * th * 4);
    if (input.level === 0) emit(0, tw, th, full.subarray(0, tw * th * 4));

    let src = full;
    let sw: number = tw;
    let sh = th;
    let used = texelRows;
    let level = 1;
    let toB = true;
    while (sw > 1 || sh > 1) {
      // Alternating destinations: a reduction reads every source texel it
      // averages, so it cannot write into the buffer it is reading.
      const next = this.reduce(src, sw, sh, toB ? this.mipB : this.mipA, used);
      toB = !toB;
      used = next.used;
      if (level >= input.level) emit(level, next.w, next.h, next.data.subarray(0, next.w * next.h * 4));
      src = next.data;
      sw = next.w;
      sh = next.h;
      level++;
    }
  }

  /**
   * Reduce one mip level, weighting each texel by coverage and saturation.
   *
   * A plain box filter, which is what `generateMipmap` applies, averages
   * colour towards grey: most of a line of code is identifiers, so the few
   * saturated texels are outvoted at every level, and three or four levels out
   * every file has drifted to the same neutral tone. What that looks like is
   * the colours changing as you zoom out rather than only the scale.
   *
   * Weighting by saturation lets comments, strings and keywords survive the
   * reduction, so a file keeps its signature all the way out. Alpha stays a
   * plain average, because it is ink coverage and has to remain linear or the
   * indentation structure would bloom.
   */
  private reduce(
    src: Uint8Array, sw: number, sh: number, dst: Uint8Array, usedRows: number,
  ): { data: Uint8Array; w: number; h: number; used: number } {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    // Only the part being written is cleared: the loop below sets alpha for
    // every destination texel it visits, and the colour channels only where
    // there is weight, so everything else has to start at zero. That includes
    // the rows past the file, which are not visited at all.
    dst.fill(0, 0, dw * dh * 4);

    // Rows the file actually occupies at this level. The rest of the layer is
    // transparent and reducing it would produce transparent texels at the cost
    // of reading them, which on a file using half its height class is half the
    // work for nothing.
    const dUsed = Math.max(1, Math.min(dh, (usedRows + 1) >> 1));

    for (let y = 0; y < dUsed; y++) {
      const y0 = Math.min(sh - 1, y * 2);
      const y1 = Math.min(sh - 1, y * 2 + 1);
      const row0 = y0 * sw;
      const row1 = y1 * sw;
      const dRow = y * dw;
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(sw - 1, x * 2);
        const x1 = Math.min(sw - 1, x * 2 + 1);
        let wr = 0;
        let wg = 0;
        let wb = 0;
        let weight = 0;
        let alpha = 0;

        // The four source texels, unrolled. This used to build two arrays per
        // destination texel and iterate them, which is twenty million array
        // allocations over a thousand files and was the single largest cost in
        // opening a project.
        for (let i = 0; i < 4; i++) {
          const o = ((i < 2 ? row0 : row1) + (i & 1 ? x1 : x0)) * 4;
          const a = src[o + 3];
          alpha += a;
          if (a === 0) continue;
          const r = src[o];
          const g = src[o + 1];
          const b = src[o + 2];
          const max = r > g ? (r > b ? r : b) : g > b ? g : b;
          const min = r < g ? (r < b ? r : b) : g < b ? g : b;
          const sat = max === 0 ? 0 : (max - min) / max;
          // Coverage times a saturation boost: a coloured texel counts for
          // roughly four times a grey one of the same coverage.
          const w = (a / 255) * (SAT_FLOOR + (1 - SAT_FLOOR) * sat);
          wr += r * w;
          wg += g * w;
          wb += b * w;
          weight += w;
        }

        const o = (dRow + x) * 4;
        if (weight > 0) {
          const inv = 1 / weight;
          const cr = wr * inv;
          const cg = wg * inv;
          const cb = wb * inv;
          dst[o] = cr > 255 ? 255 : cr + 0.5;
          dst[o + 1] = cg > 255 ? 255 : cg + 0.5;
          dst[o + 2] = cb > 255 ? 255 : cb + 0.5;
        }
        dst[o + 3] = alpha * 0.25 + 0.5;
      }
    }
    return { data: dst, w: dw, h: dh, used: dUsed };
  }


}
