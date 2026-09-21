// Directory and file labels as pooled DOM nodes on top of the canvas.
//
// Deliberately not drawn with the glyph atlas: labels are chrome, they have to
// be crisp at any zoom, and they are few, because a label is only worth
// showing once its panel is large enough on screen to read it.
//
// Only computed geometry is set inline. Colour, weight and shadow come from
// the classes in app.css, so a theme switch moves them without this file
// knowing that themes exist.

import type { Camera } from '$lib/canvas/camera';
import type { Layout } from '$lib/canvas/layout/tree';
import { metrics } from '$lib/metrics';

/** Minimum on-screen size, in CSS pixels, before a label appears. */
const MIN_DIR_PX = 34;
const MIN_FILE_PX = 26;
const MAX_LABELS = 400;

export class Labels {
  private pool: HTMLDivElement[] = [];
  private used = 0;

  constructor(private host: HTMLElement, private layout: Layout) {}

  setLayout(layout: Layout): void {
    this.layout = layout;
  }

  private take(kind: 'dir' | 'file'): HTMLDivElement {
    const el = this.used < this.pool.length ? this.pool[this.used] : this.create();
    this.used++;
    el.className = `label label-${kind}`;
    return el;
  }

  private create(): HTMLDivElement {
    const el = document.createElement('div');
    this.host.appendChild(el);
    this.pool.push(el);
    return el;
  }

  private place(el: HTMLDivElement, sx: number, sy: number, size: number, opacity: number): void {
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    el.style.fontSize = `${size.toFixed(1)}px`;
    el.style.opacity = opacity.toFixed(2);
  }

  update(cam: Camera): void {
    this.used = 0;
    const [vx0, vy0, vx1, vy1] = cam.visibleRect(0);

    for (const d of this.layout.dirs) {
      if (!d.name) continue;
      if (this.used >= MAX_LABELS) break;
      if (d.x > vx1 || d.y > vy1 || d.x + d.w < vx0 || d.y + d.h < vy0) continue;
      if (d.h * cam.zoom < MIN_DIR_PX || d.w * cam.zoom < MIN_DIR_PX) continue;
      const el = this.take('dir');
      el.textContent = d.name;
      const [sx, sy] = cam.worldToScreen(d.x + metrics.dirPad, d.y + 2);
      this.place(el, sx, sy, Math.min(18, Math.max(9, metrics.dirLabelHeight * cam.zoom * 0.62)), 1);
    }

    for (const f of this.layout.files) {
      if (this.used >= MAX_LABELS) break;
      if (f.x > vx1 || f.y > vy1 || f.x + f.w < vx0 || f.y + f.h < vy0) continue;
      const px = metrics.titleHeight * cam.zoom;
      if (px < MIN_FILE_PX * 0.45 || f.w * cam.zoom < MIN_FILE_PX) continue;
      const el = this.take('file');
      el.textContent = f.name;
      const [sx, sy] = cam.worldToScreen(f.x + metrics.panelPadX, f.y + 1);
      this.place(el, sx, sy, Math.min(15, Math.max(8, px * 0.62)), Math.min(1, (px - 6) / 8));
    }

    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.opacity = '0';
  }

  destroy(): void {
    for (const el of this.pool) el.remove();
    this.pool.length = 0;
    this.used = 0;
  }
}
