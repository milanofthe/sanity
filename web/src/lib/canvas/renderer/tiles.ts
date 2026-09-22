// The canvas at the far zoom, cached as tiles.
//
// Far out, a project of thirty thousand files is thirty thousand panels a few
// pixels across, and drawing each of them every frame cost 16 milliseconds
// for a picture that changes only when a file does. So at that zoom the
// canvas is rendered once into square tiles, the way a map viewer does it,
// and a frame draws a few dozen textured quads instead. A tile is drawn again
// only when something inside it changed.
//
// Tiles come in levels: at level L a texel is 2^L world units, and the level
// used is the one whose texels are closest to the screen's pixels. A tile is
// rendered by the scene's own drawing pass with a camera of its own, so it is
// the same picture the live view would have drawn, not an approximation of it.

/** Texels along a tile's side, gutter excluded. */
export const TILE_TEXELS = 512;

/**
 * Texels of overlap rendered around each tile and not drawn.
 *
 * A tile's mip chain is built from its own texels only, so without an
 * overlap every level of it clamps at the edge and neighbouring tiles meet
 * at a seam that shows once the tiles are drawn smaller than they are.
 */
export const TILE_GUTTER = 8;

/** Most tiles held at once. A screen needs about fifty at the level in use,
 *  and the rest is the levels either side of it, which zooming falls back
 *  to while its own are being made. */
const MAX_TILES = 160;

export interface Tile {
  level: number;
  tx: number;
  ty: number;
  tex: WebGLTexture;
  /** Something inside it changed since it was rendered. Still drawn, since a
   *  tile a moment out of date is closer to right than nothing. */
  dirty: boolean;
  /** Frame it was last drawn in, for eviction. */
  seen: number;
  /** Rendered while some of its panels were still waiting for their
   *  overview detail, so it is worth rendering again once that is in. */
  lacking: boolean;
  /** When it was last rendered, and how many times it has been rendered
   *  again for missing detail; see `lacking`. */
  renderedAt: number;
  retries: number;
}

/** World units a tile covers at a level. */
export const tileWorld = (level: number): number => TILE_TEXELS * 2 ** level;

const key = (level: number, tx: number, ty: number) => `${level}:${tx}:${ty}`;

export class TileCache {
  private gl: WebGL2RenderingContext;
  private tiles = new Map<string, Tile>();
  readonly fbo: WebGLFramebuffer;
  /** Side of a tile's texture, gutter included. */
  readonly side = TILE_TEXELS + 2 * TILE_GUTTER;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.fbo = gl.createFramebuffer()!;
  }

  get(level: number, tx: number, ty: number): Tile | undefined {
    return this.tiles.get(key(level, tx, ty));
  }

  /** A tile to render into, reusing its texture when it already exists. */
  take(level: number, tx: number, ty: number, frame: number): Tile {
    const k = key(level, tx, ty);
    let t = this.tiles.get(k);
    if (!t) {
      this.trim(frame);
      const { gl } = this;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const levels = 1 + Math.floor(Math.log2(this.side));
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, this.side, this.side);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t = { level, tx, ty, tex, dirty: true, seen: frame, lacking: false, renderedAt: 0, retries: 0 };
      this.tiles.set(k, t);
    }
    return t;
  }

  /** Mark every tile over a world rectangle as out of date. */
  invalidate(x: number, y: number, w: number, h: number): void {
    for (const t of this.tiles.values()) {
      const s = tileWorld(t.level);
      const x0 = t.tx * s;
      const y0 = t.ty * s;
      if (x0 > x + w || y0 > y + h || x0 + s < x || y0 + s < y) continue;
      t.dirty = true;
    }
  }

  invalidateAll(): void {
    for (const t of this.tiles.values()) t.dirty = true;
  }

  /** Throw every tile away: the layout moved, so none of them is even close. */
  clear(): void {
    for (const t of this.tiles.values()) this.gl.deleteTexture(t.tex);
    this.tiles.clear();
  }

  /** Make room for one more, from the tiles drawn longest ago. */
  private trim(frame: number): void {
    if (this.tiles.size < MAX_TILES) return;
    const old = [...this.tiles.entries()]
      .filter(([, t]) => t.seen !== frame)
      .sort((a, b) => a[1].seen - b[1].seen);
    for (const [k, t] of old) {
      if (this.tiles.size < MAX_TILES) break;
      this.gl.deleteTexture(t.tex);
      this.tiles.delete(k);
    }
  }

  get size(): number {
    return this.tiles.size;
  }

  dispose(): void {
    this.clear();
    this.gl.deleteFramebuffer(this.fbo);
  }
}
