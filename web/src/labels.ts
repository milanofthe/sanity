// Directory and file labels as pooled DOM nodes on top of the canvas.
//
// Deliberately not drawn with the glyph atlas: labels are UI, they must be
// crisp at any zoom and they are few, because a label is only worth showing
// once its panel is large enough on screen to read it.

import type { Camera } from './camera';
import type { Layout } from './layout/tree';
import { css, font, metrics, palette } from './tokens';

/** Minimum on-screen height, in CSS pixels, before a label appears. */
const MIN_DIR_PX = 34;
const MIN_FILE_PX = 26;
const MAX_LABELS = 400;

export class Labels {
  private pool: HTMLDivElement[] = [];
  private used = 0;

  constructor(private host: HTMLElement, private layout: Layout) {
    host.style.font = `${font.uiSize}px ${font.ui}`;
  }

  private take(): HTMLDivElement {
    if (this.used < this.pool.length) return this.pool[this.used++];
    const el = document.createElement('div');
    el.className = 'label';
    this.host.appendChild(el);
    this.pool.push(el);
    this.used++;
    return el;
  }

  update(cam: Camera): void {
    this.used = 0;
    const [vx0, vy0, vx1, vy1] = cam.visibleRect(0);

    for (const d of this.layout.dirs) {
      if (!d.name) continue;
      if (this.used >= MAX_LABELS) break;
      if (d.x > vx1 || d.y > vy1 || d.x + d.w < vx0 || d.y + d.h < vy0) continue;
      if (d.h * cam.zoom < MIN_DIR_PX || d.w * cam.zoom < MIN_DIR_PX) continue;
      const el = this.take();
      const [sx, sy] = cam.worldToScreen(d.x + metrics.dirPad, d.y + 2);
      el.textContent = d.name;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.color = css(palette.dirLabel);
      el.style.fontSize = `${Math.min(18, Math.max(9, metrics.dirLabelHeight * cam.zoom * 0.62))}px`;
      el.style.opacity = '1';
    }

    for (const f of this.layout.files) {
      if (this.used >= MAX_LABELS) break;
      if (f.x > vx1 || f.y > vy1 || f.x + f.w < vx0 || f.y + f.h < vy0) continue;
      const px = metrics.titleHeight * cam.zoom;
      if (px < MIN_FILE_PX * 0.45 || f.w * cam.zoom < MIN_FILE_PX) continue;
      const el = this.take();
      const [sx, sy] = cam.worldToScreen(f.x + metrics.panelPadX, f.y + 1);
      el.textContent = f.name;
      el.style.transform = `translate(${sx}px, ${sy}px)`;
      el.style.color = css(palette.panelLabel);
      el.style.fontSize = `${Math.min(15, Math.max(8, px * 0.62))}px`;
      el.style.opacity = String(Math.min(1, (px - 6) / 8));
    }

    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.opacity = '0';
  }
}
