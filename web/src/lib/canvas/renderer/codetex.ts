// Overview textures: one texture layer per file, holding the file's token
// colours as an image. Texel row is (a range of) source lines, texel column is
// a range of character columns, alpha is ink coverage.
//
// This is what makes the zoomed-out levels of detail cheap: no per-line
// geometry exists, a whole file is one textured quad per code column, and the
// mipmap chain does the downsampling for free and antialiased.
//
// Files are bucketed by line count into power-of-two height classes so that a
// 20k line file does not get the same texel budget as a 40 line one, and each
// class is backed by as many array textures as the driver's layer limit needs.

import { overview } from '$lib/metrics';
import { rgb } from '$lib/theme';
import { spanCol, spanKind, spanLen, type FileData } from '$lib/canvas/data/wire';
import type { GL } from './gl';

/**
 * Texel rows per height class. A file lands in the smallest class at least as
 * tall as its line count, capped at the largest.
 *
 * The steps are powers of two one apart, not four: with a factor of four
 * between classes a 400 line file is given 1024 texel rows and wastes three
 * quarters of them, which measured as hundreds of megabytes across a real
 * repository. One texel row per source line is the right resolution because
 * token geometry does not take over until three pixels per line, and lines
 * have to stay distinguishable up to that point.
 */
export const HEIGHT_CLASSES = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;

export interface Slot {
  classIdx: number;
  chunkIdx: number;
  layer: number;
  /** Texel rows actually covered, so the quad's v range can be exact. */
  texRows: number;
}

/** Storage budget for one array texture. Layer counts are derived from it, so
 *  a class of tall files gets few layers per chunk and a class of short ones
 *  gets many. A fixed layer count would reserve hundreds of megabytes for the
 *  tallest class no matter how few files actually land in it. */
const CHUNK_BUDGET_BYTES = 8 << 20;

/**
 * Weight a fully desaturated texel keeps when a mip level is reduced.
 *
 * At 1 the reduction is a plain average and colour washes out; at 0 a single
 * saturated texel would take over its whole block and the overview would
 * crawl while zooming. A quarter keeps comments and strings legible several
 * levels out without either happening.
 */
const SAT_FLOOR = 0.25;

interface Chunk {
  tex: WebGLTexture;
  layers: number;
  used: number;
  dirty: boolean;
}

interface TexClass {
  texRows: number;
  chunks: Chunk[];
}

export class OverviewTextures {
  private classes: TexClass[];
  private maxLayers: number;
  /** Scratch accumulators, sized for the largest class. */
  private acc: Float32Array;
  private cov: Float32Array;
  private out: Uint8Array;

  /** Damped token colours as floats, indexed by `Kind`. Held here rather
   *  than imported so that a theme switch can replace them and re-rasterise. */
  private kindRgb: [number, number, number][];

  constructor(private gl: GL, overviewColors: number[]) {
    this.kindRgb = overviewColors.map(rgb);
    this.maxLayers = Math.min(512, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    this.classes = HEIGHT_CLASSES.map((texRows) => ({ texRows, chunks: [] }));
    const maxTexels = overview.texCols * HEIGHT_CLASSES[HEIGHT_CLASSES.length - 1];
    this.acc = new Float32Array(maxTexels * 3);
    this.cov = new Float32Array(maxTexels);
    this.out = new Uint8Array(maxTexels * 4);
  }

  /** Swap the palette. The caller has to rewrite every layer afterwards;
   *  the colours are baked into the texels, so there is no shortcut. */
  setColors(overviewColors: number[]): void {
    this.kindRgb = overviewColors.map(rgb);
  }

  private classFor(lineCount: number): number {
    for (let i = 0; i < HEIGHT_CLASSES.length; i++) {
      if (lineCount <= HEIGHT_CLASSES[i]) return i;
    }
    return HEIGHT_CLASSES.length - 1;
  }

  private layersFor(texRows: number): number {
    const bytesPerLayer = overview.texCols * texRows * 4 * 1.34;
    return Math.max(4, Math.min(this.maxLayers, Math.floor(CHUNK_BUDGET_BYTES / bytesPerLayer)));
  }

  private newChunk(texRows: number): Chunk {
    const { gl } = this;
    const layers = this.layersFor(texRows);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const levels = 1 + Math.floor(Math.log2(Math.max(overview.texCols, texRows)));
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      levels,
      gl.RGBA8,
      overview.texCols,
      texRows,
      layers,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, layers, used: 0, dirty: false };
  }

  allocate(lineCount: number): Slot {
    const classIdx = this.classFor(lineCount);
    const cls = this.classes[classIdx];
    let chunkIdx = cls.chunks.findIndex((c) => c.used < c.layers);
    if (chunkIdx < 0) {
      cls.chunks.push(this.newChunk(cls.texRows));
      chunkIdx = cls.chunks.length - 1;
    }
    const chunk = cls.chunks[chunkIdx];
    return {
      classIdx,
      chunkIdx,
      layer: chunk.used++,
      texRows: Math.min(cls.texRows, Math.max(1, lineCount)),
    };
  }

  /**
   * Rasterise a file into its layer.
   *
   * `panelCols` is the panel's column width, so the horizontal mapping matches
   * what the detailed levels of detail will draw. Coverage is accumulated
   * fractionally: a token narrower than a texel contributes its fraction
   * rather than snapping on or off, which is the difference between a stable
   * image and one that crawls while zooming.
   */
  write(slot: Slot, f: FileData, panelCols: number, rows: Uint32Array): void {
    const { gl } = this;
    const cls = this.classes[slot.classIdx];
    const tw = overview.texCols;
    const th = cls.texRows;
    const texelRows = slot.texRows;
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
        const c = this.kindRgb[kind] ?? this.kindRgb[0];
        const col = spanCol(packed);
        // Which wrapped row this span sits on, and where within it.
        const wrapRow = panelCols > 0 ? Math.floor(col / panelCols) : 0;
        const ty = Math.min(texelRows - 1, ((lineRow + wrapRow) * texelsPerRow) | 0);
        const rowBase = ty * tw;
        const x0 = (panelCols > 0 ? col % panelCols : col) * scaleX;
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
          acc[a] += c[0] * k;
          acc[a + 1] += c[1] * k;
          acc[a + 2] += c[2] * k;
        }
      }
    }

    const out = this.out;
    for (let t = 0; t < texels; t++) {
      const k = cov[t];
      const o = t * 4;
      if (k <= 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }
      const a = t * 3;
      out[o] = Math.min(255, (acc[a] / k) * 255) | 0;
      out[o + 1] = Math.min(255, (acc[a + 1] / k) * 255) | 0;
      out[o + 2] = Math.min(255, (acc[a + 2] / k) * 255) | 0;
      out[o + 3] = Math.min(255, (k / perTexel) * 255) | 0;
    }

    const chunk = cls.chunks[slot.chunkIdx];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
    // The mip chain is built from the whole layer, transparent rows past the
    // end of a short file included, so reducing cannot pull in whatever a
    // previous occupant of the layer left behind.
    const full = new Uint8Array(tw * th * 4);
    full.set(out.subarray(0, tw * texelRows * 4));

    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot.layer,
      tw, th, 1,
      gl.RGBA, gl.UNSIGNED_BYTE,
      full, 0,
    );
    this.uploadMips(slot.layer, full, tw, th);
    chunk.dirty = true;
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
  private reduce(src: Uint8Array, sw: number, sh: number): { data: Uint8Array; w: number; h: number } {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);

    for (let y = 0; y < dh; y++) {
      const rows = [Math.min(sh - 1, y * 2), Math.min(sh - 1, y * 2 + 1)];
      for (let x = 0; x < dw; x++) {
        const colsIdx = [Math.min(sw - 1, x * 2), Math.min(sw - 1, x * 2 + 1)];
        let wr = 0;
        let wg = 0;
        let wb = 0;
        let weight = 0;
        let alpha = 0;

        for (const sy of rows) {
          for (const sx of colsIdx) {
            const o = (sy * sw + sx) * 4;
            const r = src[o];
            const g = src[o + 1];
            const b = src[o + 2];
            const a = src[o + 3];
            alpha += a;
            if (a === 0) continue;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            // Coverage times a saturation boost: a coloured texel counts for
            // roughly four times a grey one of the same coverage.
            const w = (a / 255) * (SAT_FLOOR + (1 - SAT_FLOOR) * sat);
            wr += r * w;
            wg += g * w;
            wb += b * w;
            weight += w;
          }
        }

        const o = (y * dw + x) * 4;
        if (weight > 0) {
          dst[o] = Math.min(255, Math.round(wr / weight));
          dst[o + 1] = Math.min(255, Math.round(wg / weight));
          dst[o + 2] = Math.min(255, Math.round(wb / weight));
        }
        dst[o + 3] = Math.round(alpha / 4);
      }
    }
    return { data: dst, w: dw, h: dh };
  }

  /** Build and upload the whole mip chain for one layer. */
  private uploadMips(layer: number, base: Uint8Array, w: number, h: number): void {
    const { gl } = this;
    let src = base;
    let sw = w;
    let sh = h;
    let level = 1;
    while (sw > 1 || sh > 1) {
      const next = this.reduce(src, sw, sh);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, level, 0, 0, layer,
        next.w, next.h, 1,
        gl.RGBA, gl.UNSIGNED_BYTE,
        next.data, 0,
      );
      src = next.data;
      sw = next.w;
      sh = next.h;
      level++;
    }
  }

  /** Mip chains are written per layer as files arrive, so there is nothing to
   *  flush. Kept because the call site should not have to know that. */
  finalize(): void {
    for (const cls of this.classes) {
      for (const chunk of cls.chunks) chunk.dirty = false;
    }
  }

  texture(classIdx: number, chunkIdx: number): WebGLTexture {
    return this.classes[classIdx].chunks[chunkIdx].tex;
  }

  /** Fraction of the class's texel rows that this file occupies. */
  vExtent(slot: Slot): number {
    return slot.texRows / this.classes[slot.classIdx].texRows;
  }

  chunkKeys(): [number, number][] {
    const keys: [number, number][] = [];
    this.classes.forEach((cls, ci) => cls.chunks.forEach((_, chi) => keys.push([ci, chi])));
    return keys;
  }

  stats(): { layers: number; bytes: number } {
    let layers = 0;
    let bytes = 0;
    for (const cls of this.classes) {
      for (const c of cls.chunks) {
        layers += c.used;
        // Allocated storage, mip chain included.
        bytes += overview.texCols * cls.texRows * 4 * c.layers * 1.34;
      }
    }
    return { layers, bytes: Math.round(bytes) };
  }
}
