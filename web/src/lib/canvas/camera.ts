// World space is measured in CSS pixels at zoom 1. The camera maps world to
// clip space; every LOD decision downstream is derived from `zoom` alone.

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  /** Viewport size in CSS pixels. */
  vw = 1;
  vh = 1;
  dpr = 1;

  minZoom = 0.0002;
  maxZoom = 4;

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.x + (sx - this.vw / 2) / this.zoom, this.y + (sy - this.vh / 2) / this.zoom];
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.zoom + this.vw / 2, (wy - this.y) * this.zoom + this.vh / 2];
  }

  /** Zoom around a fixed screen point, so the world point under the cursor
   *  stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    const [nx, ny] = this.screenToWorld(sx, sy);
    this.x += wx - nx;
    this.y += wy - ny;
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
  }

  /** Visible world rect as [x0, y0, x1, y1], optionally grown by a margin in
   *  screen pixels so that panels just off screen can be prepared. */
  visibleRect(marginPx = 0): [number, number, number, number] {
    const hw = (this.vw / 2 + marginPx) / this.zoom;
    const hh = (this.vh / 2 + marginPx) / this.zoom;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }

  /** Column-major 3x3 for a 2D affine world -> clip transform. */
  writeMatrix(out: Float32Array): void {
    const sx = (2 * this.zoom) / this.vw;
    const sy = (-2 * this.zoom) / this.vh;
    out[0] = sx;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = sy;
    out[5] = 0;
    out[6] = -this.x * sx;
    out[7] = -this.y * sy;
    out[8] = 1;
  }

  fit(x0: number, y0: number, x1: number, y1: number, padFrac = 0.04): void {
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const z = Math.min(this.vw / w, this.vh / h) * (1 - padFrac);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    this.x = (x0 + x1) / 2;
    this.y = (y0 + y1) / 2;
  }
}
