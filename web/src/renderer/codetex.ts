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

import { overview, overviewColors, rgb } from '../tokens';
import { spanCol, spanKind, spanLen, type FileData } from '../data/wire';
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

const kindRgb: [number, number, number][] = overviewColors.map(rgb);

export class OverviewTextures {
  private classes: TexClass[];
  private maxLayers: number;
  /** Scratch accumulators, sized for the largest class. */
  private acc: Float32Array;
  private cov: Float32Array;
  private out: Uint8Array;

  constructor(private gl: GL) {
    this.maxLayers = Math.min(512, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    this.classes = HEIGHT_CLASSES.map((texRows) => ({ texRows, chunks: [] }));
    const maxTexels = overview.texCols * HEIGHT_CLASSES[HEIGHT_CLASSES.length - 1];
    this.acc = new Float32Array(maxTexels * 3);
    this.cov = new Float32Array(maxTexels);
    this.out = new Uint8Array(maxTexels * 4);
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
  write(slot: Slot, f: FileData, panelCols: number): void {
    const { gl } = this;
    const cls = this.classes[slot.classIdx];
    const tw = overview.texCols;
    const th = cls.texRows;
    const rows = slot.texRows;
    const texels = tw * rows;

    const acc = this.acc;
    const cov = this.cov;
    acc.fill(0, 0, texels * 3);
    cov.fill(0, 0, texels);

    const scaleX = tw / Math.max(1, panelCols);
    const lineCount = Math.max(1, f.lineCount);
    const rowsPerLine = rows / lineCount;
    // How many source lines share one texel row, at least one.
    const linesPerRow = Math.max(1, lineCount / rows);

    for (let i = 0; i < f.lineCount; i++) {
      const ty = Math.min(rows - 1, (i * rowsPerLine) | 0);
      const rowBase = ty * tw;
      const s0 = f.spanStart[i];
      const s1 = f.spanStart[i + 1];
      for (let s = s0; s < s1; s++) {
        const packed = f.spans[s];
        const kind = spanKind(packed);
        const c = kindRgb[kind] ?? kindRgb[0];
        const x0 = spanCol(packed) * scaleX;
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
      out[o + 3] = Math.min(255, (k / linesPerRow) * 255) | 0;
    }

    const chunk = cls.chunks[slot.chunkIdx];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot.layer,
      tw, rows, 1,
      gl.RGBA, gl.UNSIGNED_BYTE,
      out, 0,
    );
    // Rows beyond the file's own extent stay transparent; clear them once so a
    // recycled layer does not bleed a previous file into this one.
    if (rows < th) {
      const blank = new Uint8Array(tw * (th - rows) * 4);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, 0, rows, slot.layer,
        tw, th - rows, 1,
        gl.RGBA, gl.UNSIGNED_BYTE,
        blank, 0,
      );
    }
    chunk.dirty = true;
  }

  /** Regenerate mipmaps for any chunk written to since the last call. */
  finalize(): void {
    const { gl } = this;
    for (const cls of this.classes) {
      for (const chunk of cls.chunks) {
        if (!chunk.dirty) continue;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        chunk.dirty = false;
      }
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
