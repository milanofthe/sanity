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
  /** Texel rows actually covered at full resolution, so the quad's v range can
   *  be exact. The same fraction of the layer at every mip level. */
  texRows: number;
  /** Finest mip level this slot holds; see `DETAIL_LEVELS`. */
  level: number;
}

/**
 * Mip levels a file's overview can be held from.
 *
 * Level 0 is the full texture, 128 texels across; each level after it halves
 * both sides and quarters the memory. Every file always holds `BASE_LEVEL`,
 * 8 texels across, a 256th of the full size, which is all a panel a few
 * pixels wide can show anyway. Finer levels are held only for panels large
 * enough on screen to need them, under a budget, so the memory follows the
 * screen rather than the project: measured before this, one full layer per
 * file came to 204 KB a file, 6.1 GB at thirty thousand files, and at a
 * hundred thousand the context gave up and nothing was drawn at all.
 */
export const BASE_LEVEL = 4;


/**
 * Storage budget for one array texture. Layer counts are derived from it, so
 * a class of tall files gets few layers per chunk and a class of short ones
 * gets many. A fixed layer count would reserve hundreds of megabytes for the
 * tallest class no matter how few files actually land in it.
 *
 * Four megabytes rather than eight. The last chunk of every class is only
 * partly filled, and the bigger the chunk the more of it is reserved for files
 * that are not there: measured on a 989 file project, 232 of 1221 layers were
 * empty, 19 percent of 273 megabytes. At four it is 119 of 1108 and the total
 * is 260.
 *
 * Smaller is not better past that point, because a chunk is a draw call at any
 * zoom where something in it is visible. One megabyte brought the total to 244
 * but raised the frame cost at the zoom that shows the whole project, which is
 * the one this is meant to be watched from, from 0.95 to 1.50 milliseconds.
 */
const CHUNK_BUDGET_BYTES = 4 << 20;

/**
 * Weight a fully desaturated texel keeps when a mip level is reduced.
 *
 * At 1 the reduction is a plain average and colour washes out; at 0 a single
 * saturated texel would take over its whole block and the overview would
 * crawl while zooming. A quarter keeps comments and strings legible several
 * levels out without either happening.
 */
const SAT_FLOOR = 0.25;

/** Colours as a flat triple array, for the rasteriser's inner loop. */
function flatColours(colours: number[]): Float32Array {
  const out = new Float32Array(Math.max(1, colours.length) * 3);
  colours.forEach((hex, i) => {
    const [r, g, b] = rgb(hex);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  });
  return out;
}

interface Chunk {
  tex: WebGLTexture;
  layers: number;
  used: number;
  dirty: boolean;
  /** Layers handed back by `release`, reused before any new one is taken.
   *  Without this a relayout that moves a file into a different height class
   *  leaks a layer every time, and a project being watched relayouts on every
   *  save. */
  free: number[];
  /** Layers occupied right now: `used` minus what is on the free list. */
  live: number;
}

interface TexClass {
  /** Mip level the class's layers start at. */
  level: number;
  /** Texel rows of a layer at full resolution, which is what a file's rows
   *  are measured against, and the texture's own size at its level. */
  baseRows: number;
  texCols: number;
  texRows: number;
  chunks: Chunk[];
}

/** From EXT_texture_filter_anisotropic, which WebGL2 exposes as an extension
 *  rather than in core. */
const TEXTURE_MAX_ANISOTROPY = 0x84fe;
const MAX_TEXTURE_MAX_ANISOTROPY = 0x84ff;

export class OverviewTextures {
  private classes: TexClass[];
  /** Samples the driver will take along the compressed axis, or 1 when the
   *  extension is absent. */
  private maxAnisotropy = 1;
  private maxLayers: number;
  /** Scratch accumulators, sized for the largest class. */
  private acc: Float32Array;
  private cov: Float32Array;
  /**
   * Scratch for the upload and the mip chain.
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

  /** Damped token colours as floats, indexed by `Kind`. Held here rather
   *  than imported so that a theme switch can replace them and re-rasterise. */
  /** Overview colours as a flat Float32Array of triples, indexed by kind * 3.
   *  Flat rather than an array of arrays because this is read once per span
   *  per texel, and a nested dereference there costs more than the lookup. */
  private kindRgb: Float32Array;

  constructor(private gl: GL, overviewColors: number[]) {
    this.kindRgb = flatColours(overviewColors);
    this.maxLayers = Math.min(512, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    // One class per mip level and height, flattened: level * heights + height.
    this.classes = [];
    for (let level = 0; level <= BASE_LEVEL; level++) {
      for (const baseRows of HEIGHT_CLASSES) {
        this.classes.push({
          level,
          baseRows,
          texCols: Math.max(1, overview.texCols >> level),
          texRows: Math.max(1, baseRows >> level),
          chunks: [],
        });
      }
    }
    const maxTexels = overview.texCols * HEIGHT_CLASSES[HEIGHT_CLASSES.length - 1];
    this.acc = new Float32Array(maxTexels * 3);
    this.cov = new Float32Array(maxTexels);
    this.full = new Uint8Array(maxTexels * 4);
    // A reduction halves both dimensions, so the largest output is a quarter
    // of the base. One buffer of that size each is enough to ping-pong.
    this.mipA = new Uint8Array(maxTexels);
    this.mipB = new Uint8Array(maxTexels);

    // Off by default in WebGL2 and not in core, so it has to be asked for.
    // Absent on some drivers, in which case the texture stays isotropic and
    // simply looks the way it did before.
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) {
      this.maxAnisotropy = Math.min(
        16,
        (gl.getParameter(MAX_TEXTURE_MAX_ANISOTROPY) as number) || 1,
      );
    }
  }

  /** How many samples the driver will take along the compressed axis. Reported
   *  so a measurement can say whether it is on. */
  get anisotropy(): number {
    return this.maxAnisotropy;
  }

  /** Swap the palette. The caller has to rewrite every layer afterwards;
   *  the colours are baked into the texels, so there is no shortcut. */
  setColors(overviewColors: number[]): void {
    this.kindRgb = flatColours(overviewColors);
  }

  private heightFor(lineCount: number): number {
    for (let i = 0; i < HEIGHT_CLASSES.length; i++) {
      if (lineCount <= HEIGHT_CLASSES[i]) return i;
    }
    return HEIGHT_CLASSES.length - 1;
  }

  private bytesPerLayer(cls: TexClass): number {
    return cls.texCols * cls.texRows * 4 * 1.34;
  }

  private layersFor(cls: TexClass): number {
    return Math.max(
      4,
      Math.min(this.maxLayers, Math.floor(CHUNK_BUDGET_BYTES / this.bytesPerLayer(cls))),
    );
  }

  private newChunk(cls: TexClass): Chunk {
    const { gl } = this;
    const layers = this.layersFor(cls);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const levels = 1 + Math.floor(Math.log2(Math.max(cls.texCols, cls.texRows)));
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      levels,
      gl.RGBA8,
      cls.texCols,
      cls.texRows,
      layers,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // This texture is strongly anisotropic in use: 128 texels cover at most
    // 120 characters horizontally while one texel covers a whole line
    // vertically, so at the zoom where it is the picture it is minified across
    // and magnified down. Measured: 0.43 pixels per texel horizontally
    // against 1.82 vertically at the same zoom.
    //
    // Isotropic mip selection takes the worse axis, so the horizontal
    // minification picked a coarser level and threw away the vertical
    // resolution with it, then averaged the gaps between tokens into the ink.
    // That is both the softness and the reason the picture brightened when the
    // token bars took over: the texture was showing diluted ink and the bars
    // are not diluted at all.
    if (this.maxAnisotropy > 1) {
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, TEXTURE_MAX_ANISOTROPY, this.maxAnisotropy);
    }
    return { tex, layers, used: 0, dirty: false, free: [], live: 0 };
  }

  /** A layer for a file of this many screen rows, holding mip `level` and
   *  everything coarser. */
  allocate(lineCount: number, level: number): Slot {
    const classIdx = level * HEIGHT_CLASSES.length + this.heightFor(lineCount);
    const cls = this.classes[classIdx];
    const texRows = Math.min(cls.baseRows, Math.max(1, lineCount));

    // A released layer first, then a chunk with room, then a new chunk.
    let chunkIdx = cls.chunks.findIndex((c) => c.free.length > 0);
    if (chunkIdx >= 0) {
      const chunk = cls.chunks[chunkIdx];
      chunk.live++;
      return { classIdx, chunkIdx, layer: chunk.free.pop()!, texRows, level };
    }
    chunkIdx = cls.chunks.findIndex((c) => c.used < c.layers);
    if (chunkIdx < 0) {
      cls.chunks.push(this.newChunk(cls));
      chunkIdx = cls.chunks.length - 1;
    }
    const chunk = cls.chunks[chunkIdx];
    chunk.live++;
    return { classIdx, chunkIdx, layer: chunk.used++, texRows, level };
  }

  /** Hand a layer back. The pixels are left alone; `write` clears a layer
   *  before filling it, so a new occupant cannot see the old one. */
  release(slot: Slot): void {
    const chunk = this.classes[slot.classIdx]?.chunks[slot.chunkIdx];
    if (!chunk) return;
    if (chunk.free.includes(slot.layer)) return;
    chunk.free.push(slot.layer);
    chunk.live--;
  }

  /** Whether a file of this many rows still fits the slot it has, so a
   *  relayout can keep the layer instead of taking another. */
  fitsSlot(slot: Slot, lineCount: number): boolean {
    return slot.classIdx === slot.level * HEIGHT_CLASSES.length + this.heightFor(lineCount);
  }

  /** Texel rows a file of this many rows covers in the slot's class. */
  rowsFor(slot: Slot, lineCount: number): number {
    const cls = this.classes[slot.classIdx];
    return Math.min(cls.baseRows, Math.max(1, lineCount));
  }

  /** Bytes a layer for a file of this many rows would take at `level`. */
  bytesFor(lineCount: number, level: number): number {
    return this.bytesPerLayer(this.classes[level * HEIGHT_CLASSES.length + this.heightFor(lineCount)]);
  }

  /** Bytes a layer of this slot's class takes, mip chain included. */
  slotBytes(slot: Slot): number {
    return this.bytesPerLayer(this.classes[slot.classIdx]);
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
    const th = cls.baseRows;
    const texelRows = slot.texRows;
    const texels = tw * texelRows;

    const acc = this.acc;
    const cov = this.cov;
    const kindRgb = this.kindRgb;
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

    const chunk = cls.chunks[slot.chunkIdx];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
    // Set here rather than trusted: these are global, a 3D upload from an
    // array fails outright with either of them on, and the picture uploads
    // turn premultiplication on for their own.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // The mip chain is built from the whole layer, transparent rows past the
    // end of a short file included, so reducing cannot pull in whatever a
    // previous occupant of the layer left behind. The scratch buffer is
    // reused, so the rows past the file have to be cleared rather than assumed
    // zero: only those, not the whole layer, which would cost more than the
    // allocation did.
    full.fill(0, tw * texelRows * 4, tw * th * 4);

    // Always rasterised at full resolution and reduced from there, whatever
    // level the slot starts at, so a coarse layer is exactly the mip a full
    // one would have had and swapping between them changes nothing on screen.
    if (slot.level === 0) {
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot.layer,
        tw, th, 1,
        gl.RGBA, gl.UNSIGNED_BYTE,
        full, 0,
      );
    }
    this.uploadMips(slot.layer, slot.level, full, tw, th, texelRows);
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


  /** Build and upload the whole mip chain for one layer. */
  private uploadMips(
    layer: number, from: number, base: Uint8Array, w: number, h: number, usedRows: number,
  ): void {
    const { gl } = this;
    let src = base;
    let sw = w;
    let sh = h;
    let used = usedRows;
    let level = 1;
    let toB = true;
    while (sw > 1 || sh > 1) {
      // Alternating destinations: a reduction reads every source texel it
      // averages, so it cannot write into the buffer it is reading.
      const next = this.reduce(src, sw, sh, toB ? this.mipB : this.mipA, used);
      toB = !toB;
      used = next.used;
      // Levels finer than the slot holds are computed, since the coarser ones
      // are reduced from them, and not uploaded.
      if (level >= from) {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY, level - from, 0, 0, layer,
          next.w, next.h, 1,
          gl.RGBA, gl.UNSIGNED_BYTE,
          // A view of the scratch buffer, since only its head is this level.
          next.data.subarray(0, next.w * next.h * 4), 0,
        );
      }
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
    return slot.texRows / this.classes[slot.classIdx].baseRows;
  }

  /** Texel rows of the texture a class is drawn from, for the shader's
   *  vertical sharpening. */
  texRowsOf(classIdx: number): number {
    return this.classes[classIdx].texRows;
  }

  chunkKeys(): [number, number][] {
    const keys: [number, number][] = [];
    this.classes.forEach((cls, ci) => cls.chunks.forEach((_, chi) => keys.push([ci, chi])));
    return keys;
  }

  /**
   * Layers in use, and allocated storage in bytes, mip chains included, in
   * all and for the finer levels alone. The finer levels are what the budget
   * in the scene bounds; the base level is one small layer per file.
   */
  stats(): { layers: number; bytes: number; detailBytes: number } {
    let layers = 0;
    let bytes = 0;
    let detailBytes = 0;
    for (const cls of this.classes) {
      for (const c of cls.chunks) {
        layers += c.live;
        const b = this.bytesPerLayer(cls) * c.layers;
        bytes += b;
        if (cls.level < BASE_LEVEL) detailBytes += b;
      }
    }
    return { layers, bytes: Math.round(bytes), detailBytes: Math.round(detailBytes) };
  }
}
