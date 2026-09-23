// Directory names on the canvas, and the colour each directory takes.
//
// The names are placed the way a map places its labels: in screen space, once
// a directory is large enough on screen to be worth naming, outermost first,
// and left out where they would collide with one placed before them. A label
// in world units, the default, is unreadable in exactly the view that is meant
// to show the structure: the whole project, where every directory is a few
// hundred pixels across and its name a sliver a few pixels tall. This is the
// option that names them there.
//
// Pure arithmetic on rectangles, so it can be tested without a GL context.
// The renderer measures the directories on screen, calls `placeLabels`, and
// draws what comes back.

import type { DirNode } from './layout/tree';

/**
 * Em size of every label and of the breadcrumb, in CSS pixels.
 *
 * One size. The first version sized labels by how large their directory was
 * on screen, from 11 to 20 pixels, so the hierarchy would read from the type,
 * and it read as loud and inconsistent instead: the top-level names were
 * headlines over the code, and the same directory changed size as you
 * zoomed. The order of placement already says which directory is outer.
 * Ten, after twelve and then eleven looked too large on screen: a tab is a
 * note on a frame, not a heading.
 */
export const LABEL_SIZE = 10;

/**
 * Side of the square a directory has to cover on screen to be named, in CSS
 * pixels: about the smallest region a name still reads as the name of,
 * rather than as a caption on one panel. At the whole-project zoom that keeps
 * the labels to a few dozen instead of one per directory.
 */
const MIN_SIDE = 170;

/** A plate is this many ems tall, and this many ems wider than its text. */
export const PLATE_LINE = 1.5;
export const PLATE_PAD = 0.45;

/** Room a label leaves to its directory's right edge, and between two
 *  plates. */
const INSET_PX = 3;
const GAP_PX = 2;

/** A directory has to be this many plates tall to take a label, so the label
 *  names a region rather than covering it. */
const HEIGHTS_PER_LABEL = 3;

/** Smallest a directory can be on screen and still take a label, so the
 *  renderer can pass over the rest without measuring them. */
export const MIN_LABELLED = {
  w: 2 * INSET_PX + 2 * PLATE_PAD * LABEL_SIZE,
  h: LABEL_SIZE * PLATE_LINE * HEIGHTS_PER_LABEL,
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A directory as it is on screen, in CSS pixels. */
export interface ScreenDir extends Box {
  path: string;
  name: string;
  depth: number;
}

export interface PlacedLabel {
  path: string;
  text: string;
  /** Em size in CSS pixels. */
  size: number;
  /** The plate behind the text; the text starts `PLATE_PAD` ems in. */
  plate: Box;
  alpha: number;
}

export interface Crumb {
  path: string;
  text: string;
  /** Where its text sits, in CSS pixels. */
  box: Box;
}

export interface Breadcrumb {
  crumbs: Crumb[];
  /** Separators between the crumbs, and a leading ".." when some did not fit. */
  seps: { text: string; x: number }[];
  plate: Box;
  size: number;
}

export interface Placement {
  labels: PlacedLabel[];
  crumb: Breadcrumb | null;
}

export interface PlaceOpts {
  /** The viewport, in CSS pixels. */
  vw: number;
  vh: number;
  /** Character advance as a multiple of the em. */
  advance: number;
  /** Device pixels per CSS pixel, which a plate's edges are snapped to. */
  dpr: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w + GAP_PX && b.x < a.x + a.w + GAP_PX
  && a.y < b.y + b.h + GAP_PX && b.y < a.y + a.h + GAP_PX;

const plateW = (chars: number, size: number, advance: number): number =>
  chars * advance * size + 2 * PLATE_PAD * size;

/**
 * Whether a directory takes a label, as how opaque it is: 0 for none.
 *
 * It has to cover `MIN_SIDE` squared on screen, and its name has to fit the
 * part of it showing. Faded in over the last tenth below that area, so a
 * label does not pop into existence at one zoom step.
 */
export function labelAlpha(whole: Box, shown: Box, chars: number, advance: number): number {
  const side = Math.sqrt(Math.max(0, whole.w) * Math.max(0, whole.h));
  const fits = plateW(chars, LABEL_SIZE, advance) <= shown.w - 2 * INSET_PX
    && LABEL_SIZE * PLATE_LINE * HEIGHTS_PER_LABEL <= shown.h;
  if (!fits) return 0;
  return Math.min(1, Math.max(0, (side - 0.9 * MIN_SIDE) / (0.1 * MIN_SIDE)));
}

/** The part of a box inside the viewport. */
function clip(b: Box, vw: number, vh: number): Box {
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(vw, b.x + b.w);
  const y1 = Math.min(vh, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Place the breadcrumb and the labels for the directories in view.
 *
 * `dirs` outermost first, which is the layout's order, so a directory's label
 * is placed before any of its children's and wins where they collide.
 *
 * The breadcrumb is the chain of directories holding the centre of the view
 * whose own corner is off screen: the ones you are inside of and would
 * otherwise have no name for. It goes first, top left, and the labels keep
 * clear of it.
 *
 * A label is a tab in its directory's top left corner, flush with the frame
 * and snapped to the device pixel the frame's corner is snapped to, so the
 * two are one shape. Where it would run into one placed before it, it is
 * left out rather than moved: a name away from its corner is a name that
 * could belong to anything around it. A directory whose corner is off screen
 * has its tab held against the edge of the screen, along its own frame, the
 * way a sticky header is.
 */
export function placeLabels(dirs: ScreenDir[], o: PlaceOpts): Placement {
  const cx = o.vw / 2;
  const cy = o.vh / 2;
  const chain: ScreenDir[] = [];
  for (const d of dirs) {
    if (!d.name) continue;
    const holds = d.x <= cx && cx <= d.x + d.w && d.y <= cy && cy <= d.y + d.h;
    if (holds && (d.x < 0 || d.y < 0)) chain.push(d);
  }
  const crumb = chain.length > 0 ? placeCrumb(chain, o) : null;
  const inChain = new Set(chain.map((d) => d.path));

  const placed: Box[] = crumb ? [crumb.plate] : [];
  const labels: PlacedLabel[] = [];
  for (const d of dirs) {
    if (!d.name || inChain.has(d.path)) continue;
    const shown = clip(d, o.vw, o.vh);
    if (shown.w <= 0 || shown.h <= 0) continue;
    const alpha = labelAlpha(d, shown, d.name.length, o.advance);
    if (alpha <= 0) continue;
    const size = LABEL_SIZE;
    const snap = (v: number) => Math.round(v * o.dpr) / o.dpr;
    const plate = {
      x: snap(shown.x), y: snap(shown.y),
      w: snap(plateW(d.name.length, size, o.advance)), h: snap(size * PLATE_LINE),
    };
    if (placed.some((p) => overlaps(p, plate))) continue;
    if (plate.x + plate.w > shown.x + shown.w - INSET_PX) continue;
    placed.push(plate);
    labels.push({ path: d.path, text: d.name, size, plate, alpha });
  }
  return { labels, crumb };
}

/** One line, top left, outermost first, dropping from the front with a
 *  leading ".." when it is wider than the view. */
function placeCrumb(chain: ScreenDir[], o: PlaceOpts): Breadcrumb {
  const size = LABEL_SIZE;
  const ch = o.advance * size;
  const sep = ' / ';
  const room = Math.max(1, Math.floor((o.vw - 4 * INSET_PX - 2 * PLATE_PAD * size) / ch));
  let first = 0;
  const width = (from: number) =>
    chain.slice(from).reduce((n, d) => n + d.name.length, 0)
    + (chain.length - from - 1) * sep.length + (from > 0 ? 2 + sep.length : 0);
  while (first < chain.length - 1 && width(first) > room) first++;

  // In the canvas's own corner, the way a label sits in its directory's.
  const h = size * PLATE_LINE;
  const x0 = 0;
  const y = 0;
  let x = x0 + PLATE_PAD * size;
  const crumbs: Crumb[] = [];
  const seps: { text: string; x: number }[] = [];
  if (first > 0) {
    seps.push({ text: `..${sep}`, x });
    x += (2 + sep.length) * ch;
  }
  for (let i = first; i < chain.length; i++) {
    const d = chain[i];
    if (i > first) {
      seps.push({ text: sep, x });
      x += sep.length * ch;
    }
    const w = d.name.length * ch;
    crumbs.push({ path: d.path, text: d.name, box: { x, y, w, h } });
    x += w;
  }
  const plate = { x: x0, y, w: x + PLATE_PAD * size - x0, h };
  return { crumbs, seps, plate, size };
}

/** What a click at a screen position lands on: a label or a crumb, by path. */
export function labelAt(p: Placement, sx: number, sy: number): string | null {
  const inside = (b: Box) => sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h;
  if (p.crumb) {
    for (const c of p.crumb.crumbs) if (inside(c.box)) return c.path;
    if (inside(p.crumb.plate)) return null;
  }
  for (const l of p.labels) if (inside(l.plate)) return l.path;
  return null;
}

/**
 * Order the theme's data hues are handed to branches in: blue, orange, green
 * and purple first, which every theme keeps far apart, then the grey, and the
 * red last, since red on a directory reads as something being wrong with it.
 */
const BRANCH_ORDER = [0, 3, 2, 1, 4, 5];

/**
 * The hue each directory takes, as an index into the theme's data hues, or
 * -1 for none.
 *
 * By branch rather than by path: the directories directly below the trunk
 * each get a hue, largest first, and everything below them inherits it, so a
 * part of the project reads as one colour at every zoom. The trunk is the
 * root and any directory below it that holds most of its parent on its own,
 * the `src` of a project with a README beside it, since giving that one
 * branch a hue would colour the whole project the same.
 *
 * Hashing the path, which this replaced, kept a directory's colour stable
 * when its siblings changed, and said nothing: two siblings came out in
 * unrelated colours and a directory had nothing in common with its parent.
 */
export function branchHues(root: DirNode, hues: number): Map<string, number> {
  const out = new Map<string, number>();
  const order = BRANCH_ORDER.filter((i) => i < hues);
  if (order.length === 0) return out;
  const dirsOf = (d: DirNode) => d.children.filter((c): c is DirNode => c.kind === 'dir');

  let trunk = root;
  for (;;) {
    out.set(trunk.path, -1);
    const sub = dirsOf(trunk);
    if (sub.length !== 1 || sub[0].area < 0.5 * trunk.area) break;
    trunk = sub[0];
  }
  const branches = dirsOf(trunk).sort((a, b) => b.area - a.area || (a.path < b.path ? -1 : 1));
  const paint = (d: DirNode, hue: number) => {
    out.set(d.path, hue);
    for (const c of dirsOf(d)) paint(c, hue);
  };
  branches.forEach((b, i) => paint(b, order[i % order.length]));
  return out;
}
