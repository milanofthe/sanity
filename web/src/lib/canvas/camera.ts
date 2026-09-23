// World space is measured in CSS pixels at zoom 1. The camera maps world to
// clip space; every LOD decision downstream is derived from `zoom` alone.

interface Flight {
  x0: number;
  y0: number;
  z0: number;
  /** Log zoom, because that is what interpolates evenly. */
  lz0: number;
  x1: number;
  y1: number;
  lz1: number;
  /** The world point that is at the same place on screen at both ends, which
   *  the flight scales about; null when the zoom barely changes and the
   *  flight is a pan. See `update`. */
  px: number | null;
  py: number;
  start: number;
  duration: number;
}

/** Zoom ratios closer to one than this are flown as a pan: the point both
 *  ends share moves off towards infinity as the ratio approaches one. */
const PAN_ONLY = 1e-3;

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  private flight: Flight | null = null;

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
    this.flight = null;
    const [wx, wy] = this.screenToWorld(sx, sy);
    const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    const [nx, ny] = this.screenToWorld(sx, sy);
    this.x += wx - nx;
    this.y += wy - ny;
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.flight = null;
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

  /** Zoom and centre that would fit the rect, without applying it. */
  fitFor(
    x0: number, y0: number, x1: number, y1: number, padFrac = 0.04,
  ): { x: number; y: number; zoom: number } {
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const z = Math.min(this.vw / w, this.vh / h) * (1 - padFrac);
    return {
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      zoom: Math.min(this.maxZoom, Math.max(this.minZoom, z)),
    };
  }

  fit(x0: number, y0: number, x1: number, y1: number, padFrac = 0.04): void {
    const t = this.fitFor(x0, y0, x1, y1, padFrac);
    this.flight = null;
    this.x = t.x;
    this.y = t.y;
    this.zoom = t.zoom;
  }

  /**
   * Animate to a target.
   *
   * Zoom is interpolated in log space. Linear interpolation of the zoom factor
   * looks wrong for the same reason linear interpolation of a scale does: a
   * flight from 0.02 to 2 would spend almost all its time at the far end and
   * then snap, because equal steps in zoom are not equal steps in apparent
   * motion. In log space, each frame covers the same ratio.
   */
  flyTo(x: number, y: number, zoom: number, seconds = 0.45): void {
    const target = Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
    if (seconds <= 0) {
      this.flight = null;
      this.x = x;
      this.y = y;
      this.zoom = target;
      return;
    }
    const z0 = this.zoom;
    const dz = target - z0;
    const pan = Math.abs(dz) < PAN_ONLY * Math.max(z0, target);
    this.flight = {
      x0: this.x,
      y0: this.y,
      z0,
      lz0: Math.log(z0),
      x1: x,
      y1: y,
      lz1: Math.log(target),
      // (P - c0) z0 = (P - c1) z1: the same screen offset from the centre
      // at the start and at the end.
      px: pan ? null : (x * target - this.x * z0) / dz,
      py: pan ? 0 : (y * target - this.y * z0) / dz,
      start: performance.now(),
      duration: seconds * 1000,
    };
  }

  flyToRect(x0: number, y0: number, x1: number, y1: number, seconds = 0.45, padFrac = 0.04): void {
    const t = this.fitFor(x0, y0, x1, y1, padFrac);
    this.flyTo(t.x, t.y, t.zoom, seconds);
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /** Cancel an animation, so a drag or a wheel takes over immediately. */
  stop(): void {
    this.flight = null;
  }

  /** Advance any animation. Call once per frame before rendering. */
  update(now: number): void {
    const f = this.flight;
    if (!f) return;
    const raw = Math.min(1, (now - f.start) / f.duration);
    // Cubic ease in and out: no sudden start, no overshoot at the end.
    const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - (-2 * raw + 2) ** 3 / 2;
    this.zoom = Math.exp(f.lz0 + (f.lz1 - f.lz0) * t);
    if (f.px === null) {
      this.x = f.x0 + (f.x1 - f.x0) * t;
      this.y = f.y0 + (f.y1 - f.y0) * t;
    } else {
      // A scaling about the point both ends share, so every point on screen
      // moves in a straight line. The centre used to move linearly in the
      // world while the zoom moved in log space, and the two disagree about
      // where the middle of a flight is: zooming in, the zoom is most of the
      // way there while the centre is halfway, so the target swung out
      // towards the edge of the screen and came back.
      const k = f.z0 / this.zoom;
      this.x = f.px + (f.x0 - f.px) * k;
      this.y = f.py + (f.y0 - f.py) * k;
    }
    if (raw >= 1) {
      // Exactly the target, not the target up to rounding.
      this.x = f.x1;
      this.y = f.y1;
      this.zoom = Math.exp(f.lz1);
      this.flight = null;
    }
  }
}
