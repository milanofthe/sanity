// The outline of the wordmark, as SVG path data, traced from
// assets/sanity-logo.png, the original. The icons are cut from it rather than
// redrawn, so they are the logo's own shapes.
//
// Marching squares over the alpha mask, the loops linked, then simplified
// with Ramer-Douglas-Peucker to a tolerance well under a pixel of the
// original, which is 1114 by 465.

import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

/** The original's alpha mask: which pixels are ink. */
export function readMask(file) {
  const img = decodePng(readFileSync(file));
  const { width: w, height: h } = img;
  return { w, h, on: (x, y) => x >= 0 && y >= 0 && x < w && y < h && img.data[(y * w + x) * 4 + 3] > 127 };
}

/** The whole wordmark as path data. */
export function traceLogo(file) {
  const m = readMask(file);
  return { d: trace(m.on, m.w, m.h), width: m.w, height: m.h };
}

/** A mask traced into path data, one closed loop per edge of ink. */
export function trace(on, w, h, eps = 0.9) {
  // Edges between an inside pixel and an outside one, directed so the inside
  // is on the left, keyed by their start corner.
  const next = new Map();
  const add = (x0, y0, x1, y1) => next.set(`${x0},${y0}`, [x1, y1]);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a = on(x, y);
      if (a !== on(x + 1, y)) {
        if (a) add(x + 1, y + 1, x + 1, y);
        else add(x + 1, y, x + 1, y + 1);
      }
      if (a !== on(x, y + 1)) {
        if (a) add(x, y + 1, x + 1, y + 1);
        else add(x + 1, y + 1, x, y + 1);
      }
    }
  }
  const loops = [];
  while (next.size > 0) {
    const [start] = next.keys();
    const loop = [];
    let key = start;
    while (next.has(key)) {
      const [x1, y1] = next.get(key);
      next.delete(key);
      loop.push(key.split(',').map(Number));
      key = `${x1},${y1}`;
    }
    if (loop.length > 8) loops.push(simplify(loop, eps));
  }
  return loops.map((l) => `M${l.map(([x, y]) => `${x} ${y}`).join('L')}Z`).join('');
}

function simplify(points, eps) {
  // Closed loop: split at the point furthest from the first, simplify halves.
  let far = 0;
  let best = -1;
  points.forEach(([x, y], i) => {
    const dd = (x - points[0][0]) ** 2 + (y - points[0][1]) ** 2;
    if (dd > best) { best = dd; far = i; }
  });
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0];
    const [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let idx = 0;
    let dmax = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i];
      const dist = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len;
      if (dist > dmax) { dmax = dist; idx = i; }
    }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, idx + 1)).slice(0, -1), ...rdp(pts.slice(idx))];
  };
  const a = rdp(points.slice(0, far + 1));
  const b = rdp([...points.slice(far), points[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
