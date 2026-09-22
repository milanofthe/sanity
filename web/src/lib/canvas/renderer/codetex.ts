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
import type { FileData } from '$lib/canvas/data/wire';
import { OverviewRaster } from './raster';
import type { RasterPool } from './rasterpool';
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
  /** Finest mip level this slot holds; see `BASE_LEVEL`. */
  level: number;
  /** Counts the writes, so a result from a worker that arrives after a newer
   *  write, or after the slot was given back, is dropped rather than drawn
   *  over what replaced it. */
  gen?: number;
  released?: boolean;
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
  /** Rasterises on this thread, for the files written one at a time. */
  private raster = new OverviewRaster();

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
    slot.released = true;
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
  /**
   * Rasterise a file into its layer on a worker, and upload it when it is
   * back. `done` is called then, and not at all if the slot was written again
   * or given back in the meantime.
   */
  writeAsync(
    pool: RasterPool, slot: Slot, f: FileData, panelCols: number, rows: Uint32Array,
    done: () => void,
  ): void {
    const gen = (slot.gen = (slot.gen ?? 0) + 1);
    const cls = this.classes[slot.classIdx];
    pool.submit(
      {
        lineCount: f.lineCount, spans: f.spans, spanStart: f.spanStart, rows, panelCols,
        texelRows: slot.texRows, classRows: cls.baseRows, level: slot.level,
        kindRgb: this.kindRgb,
      },
      (levels) => {
        if (slot.released || slot.gen !== gen) return;
        for (const l of levels) this.upload(slot, l.level, l.w, l.h, l.data);
        done();
      },
    );
  }

  write(slot: Slot, f: FileData, panelCols: number, rows: Uint32Array): void {
    const { gl } = this;
    // A write here supersedes one still out on a worker.
    slot.gen = (slot.gen ?? 0) + 1;
    const cls = this.classes[slot.classIdx];
    const chunk = cls.chunks[slot.chunkIdx];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
    // Set here rather than trusted: these are global, a 3D upload from an
    // array fails outright with either of them on, and the picture uploads
    // turn premultiplication on for their own.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.raster.run(
      {
        lineCount: f.lineCount, spans: f.spans, spanStart: f.spanStart, rows, panelCols,
        texelRows: slot.texRows, classRows: cls.baseRows, level: slot.level,
        kindRgb: this.kindRgb,
      },
      (level, w, h, data) => this.upload(slot, level, w, h, data),
    );
    chunk.dirty = true;
  }

  /** One mip level of a slot's layer, `level` counted at full resolution. */
  upload(slot: Slot, level: number, w: number, h: number, data: Uint8Array): void {
    const { gl } = this;
    const chunk = this.classes[slot.classIdx].chunks[slot.chunkIdx];
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, chunk.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, level - slot.level, 0, 0, slot.layer,
      w, h, 1,
      gl.RGBA, gl.UNSIGNED_BYTE,
      data, 0,
    );
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
