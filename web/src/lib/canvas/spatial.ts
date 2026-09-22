// A uniform grid over the layout, for asking what is in view.
//
// A frame used to walk every file and every directory and test each against
// the view. That is cheap per file and linear in the project, so a project of
// a hundred thousand files paid for all of them on a frame showing one. The
// grid is built once per layout and a query touches only the cells the view
// covers.
//
// Uniform rather than a tree because the layout is a treemap: its rectangles
// tile the canvas without gaps, so their density is even by construction and
// a grid sized to the average rectangle holds a few of them per cell almost
// everywhere. Rectangles that span several cells are listed in each of them
// and reported once per query.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class SpatialGrid {
  private x0: number;
  private y0: number;
  private cell: number;
  private cols: number;
  private rows: number;
  /** Items per cell as one flat list: cell `c` owns
   *  `items[start[c]] .. items[start[c + 1] - 1]`. */
  private start: Uint32Array;
  private items: Uint32Array;
  /** Query that last reported each item, so one spanning several cells is
   *  reported once. */
  private seen: Uint32Array;
  private query = 0;

  /**
   * @param boxes the rectangles, indexed by position; a query reports indices.
   * @param perCell how many rectangles an average cell should hold.
   */
  constructor(boxes: readonly Box[], perCell = 4) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of boxes) {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    if (boxes.length === 0) {
      x0 = y0 = 0;
      x1 = y1 = 1;
    }
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    // Cells of the area that holds `perCell` average rectangles.
    this.cell = Math.max(1, Math.sqrt((w * h * perCell) / Math.max(1, boxes.length)));
    this.x0 = x0;
    this.y0 = y0;
    this.cols = Math.max(1, Math.ceil(w / this.cell));
    this.rows = Math.max(1, Math.ceil(h / this.cell));

    // Two passes, count then fill, so the lists are one allocation.
    const n = this.cols * this.rows;
    const count = new Uint32Array(n + 1);
    this.each(boxes, (c) => { count[c + 1]++; });
    for (let c = 0; c < n; c++) count[c + 1] += count[c];
    this.start = count;
    this.items = new Uint32Array(count[n]);
    const fill = count.slice(0, n);
    this.each(boxes, (c, i) => { this.items[fill[c]++] = i; });
    this.seen = new Uint32Array(boxes.length);
  }

  /** Every cell each box covers. */
  private each(boxes: readonly Box[], visit: (cell: number, index: number) => void): void {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const [c0, r0, c1, r1] = this.span(b.x, b.y, b.x + b.w, b.y + b.h);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) visit(r * this.cols + c, i);
      }
    }
  }

  /** Cell range covering a rectangle, clamped to the grid. */
  private span(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const clampC = (v: number) => Math.min(this.cols - 1, Math.max(0, v));
    const clampR = (v: number) => Math.min(this.rows - 1, Math.max(0, v));
    return [
      clampC(Math.floor((x0 - this.x0) / this.cell)),
      clampR(Math.floor((y0 - this.y0) / this.cell)),
      clampC(Math.floor((x1 - this.x0) / this.cell)),
      clampR(Math.floor((y1 - this.y0) / this.cell)),
    ];
  }

  /**
   * Indices of the boxes in cells the rectangle touches, each once.
   *
   * A candidate list, not an exact one: a box sharing a cell with the view
   * may still miss it, and the caller tests the box it actually draws, which
   * may be animated away from the one indexed here anyway.
   */
  near(x0: number, y0: number, x1: number, y1: number, out: number[]): number[] {
    out.length = 0;
    if (x1 < this.x0 || y1 < this.y0) return out;
    if (x0 > this.x0 + this.cols * this.cell || y0 > this.y0 + this.rows * this.cell) return out;
    // Wrapping at 2^32 queries would report nothing on the one query whose
    // number matches a stale mark; clearing first makes that impossible.
    if (++this.query === 0xffffffff) {
      this.seen.fill(0);
      this.query = 1;
    }
    const q = this.query;
    const [c0, r0, c1, r1] = this.span(x0, y0, x1, y1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c;
        for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
          const i = this.items[k];
          if (this.seen[i] === q) continue;
          this.seen[i] = q;
          out.push(i);
        }
      }
    }
    return out;
  }
}
