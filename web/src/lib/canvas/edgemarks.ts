// Where a change outside the view is pointed at from the edge of the screen.
//
// A file an agent writes while you are zoomed into another one used to show
// only as a dot and a count in the status bar, which says that something
// happened and not where. So each changed panel that is off screen gets a
// short bar on the edge of the view, on the line from the middle of the
// screen towards it, for as long as its lines stay marked. A click on one
// goes there.
//
// Pure arithmetic in screen pixels, so it can be tested without a GL context.

export interface EdgeTarget {
  path: string;
  /** Centre of the panel, in CSS pixels, anywhere outside the view. */
  x: number;
  y: number;
  /** How strongly it is marked, 0 to 1; see `markStep`. */
  alpha: number;
  /** Seconds since the change, for deciding which of two close ones shows. */
  since: number;
}

export interface EdgeMark {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

/** Distance of a mark from the edge of the view, its length along the edge
 *  and its thickness, in CSS pixels. */
const INSET = 3;
const LENGTH = 18;
const THICK = 4;

/** Marks closer than this along the edge are one mark, the newest change's:
 *  a directory an agent is rewriting is one place, not twenty bars. */
const MERGE = 26;

/**
 * The marks for a set of changed panels outside a view `vw` by `vh`.
 *
 * Each is where the line from the centre of the view to the panel's centre
 * leaves the view, pulled in by `INSET`, and lies along the edge it is on.
 * Snapped to device pixels, so a four pixel bar is four pixels.
 */
export function edgeMarks(targets: EdgeTarget[], vw: number, vh: number, dpr: number): EdgeMark[] {
  const cx = vw / 2;
  const cy = vh / 2;
  const hx = cx - INSET - THICK / 2;
  const hy = cy - INSET - THICK / 2;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const out: EdgeMark[] = [];
  const newest = [...targets].sort((a, b) => a.since - b.since);
  for (const t of newest) {
    const dx = t.x - cx;
    const dy = t.y - cy;
    if (dx === 0 && dy === 0) continue;
    // How far along the ray the edge is, on whichever axis gives out first.
    const sx = dx === 0 ? Infinity : hx / Math.abs(dx);
    const sy = dy === 0 ? Infinity : hy / Math.abs(dy);
    const s = Math.min(sx, sy);
    const px = cx + dx * s;
    const py = cy + dy * s;
    if (out.some((m) => Math.hypot(m.x + m.w / 2 - px, m.y + m.h / 2 - py) < MERGE)) continue;
    // Along the edge it sits on: upright on the sides, flat on top and bottom.
    const side = sx <= sy;
    const w = side ? THICK : LENGTH;
    const h = side ? LENGTH : THICK;
    const x = Math.min(vw - INSET - w, Math.max(INSET, px - w / 2));
    const y = Math.min(vh - INSET - h, Math.max(INSET, py - h / 2));
    out.push({ path: t.path, x: snap(x), y: snap(y), w, h, alpha: t.alpha });
  }
  return out;
}

/** The mark at a screen position, generously: a four pixel bar is a small
 *  thing to aim at. */
export function edgeMarkAt(marks: EdgeMark[], sx: number, sy: number): string | null {
  const slack = 6;
  for (const m of marks) {
    if (sx >= m.x - slack && sx <= m.x + m.w + slack && sy >= m.y - slack && sy <= m.y + m.h + slack) {
      return m.path;
    }
  }
  return null;
}
