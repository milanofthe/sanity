// Directory names on the canvas, and the colour each directory takes.
//
// The names are placed the way a map places its labels: in screen space, at a
// size that follows how large the directory is on screen, outermost first, and
// left out where they would collide with one placed before them. A label in
// world units, which is what this replaced, was either unreadable or absent in
// exactly the view that is meant to show the structure: the whole project,
// where every directory is a few hundred pixels across and its name was a
// sliver a few pixels tall.
//
// Pure arithmetic on rectangles, so it can be tested without a GL context.
// The renderer measures the directories on screen, calls `placeLabels`, and
// draws what comes back.

import type { DirNode } from './layout/tree';

/** Em sizes a label is drawn at, in CSS pixels. A handful rather than a
 *  continuous range, so each has an atlas of its own drawn 1:1. */
export const LABEL_SIZES = [11, 13, 16, 20] as const;

/** Em size of the breadcrumb, in CSS pixels. */
export const CRUMB_SIZE = 13;

/**
 * Square root of a directory's screen area per pixel of label em.
 *
 * What makes the size follow the hierarchy: a directory a quarter of the
 * screen gets the largest size, one of its children the next, and a directory
 * a hundred pixels square none at all, which at the whole-project zoom is
 * what keeps the labels to a few dozen instead of one per directory.
 */
const AREA_PER_EM = 14;

/** A plate is this many ems tall, and this many ems wider than its text. */
export const PLATE_LINE = 1.5;
export const PLATE_PAD = 0.45;

/** Smallest distance from a directory's edge, and between two plates. */
const INSET_PX = 3;
const GAP_PX = 2;

/** A directory has to be this many plates tall to take a label, so the label
 *  names a region rather than covering it. */
const HEIGHTS_PER_LABEL = 3;

/** Smallest a directory can be on screen and still take a label, so the
 *  renderer can pass over the rest without measuring them. */
export const MIN_LABELLED = {
  w: 2 * INSET_PX + 2 * PLATE_PAD * LABEL_SIZES[0],
  h: LABEL_SIZES[0] * PLATE_LINE * HEIGHTS_PER_LABEL,
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
  /** Em size in CSS pixels, one of `LABEL_SIZES`. */
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
  /** A directory's frame on screen: the band above its contents, and the
   *  margin to their left, in CSS pixels. */
  strip: number;
  inset: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w + GAP_PX && b.x < a.x + a.w + GAP_PX
  && a.y < b.y + b.h + GAP_PX && b.y < a.y + a.h + GAP_PX;

const plateW = (chars: number, size: number, advance: number): number =>
  chars * advance * size + 2 * PLATE_PAD * size;

/**
 * The size a directory's label is drawn at, and how opaque, or none.
 *
 * The largest size its area allows that also fits the part of it on screen.
 * Faded in over the last two pixels of em below the smallest size, so a label
 * does not pop into existence at one zoom step.
 */
export function labelSize(
  whole: Box, shown: Box, chars: number, advance: number,
): { size: number; alpha: number } {
  const byArea = Math.sqrt(Math.max(0, whole.w) * Math.max(0, whole.h)) / AREA_PER_EM;
  for (let i = LABEL_SIZES.length - 1; i >= 0; i--) {
    const s = LABEL_SIZES[i];
    const fits = plateW(chars, s, advance) <= shown.w - 2 * INSET_PX
      && s * PLATE_LINE * HEIGHTS_PER_LABEL <= shown.h;
    if (!fits) continue;
    if (s <= byArea) return { size: s, alpha: 1 };
    if (i === 0 && byArea > s - 2) return { size: s, alpha: (byArea - (s - 2)) / 2 };
  }
  return { size: 0, alpha: 0 };
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
 * clear of it. Every other directory whose corner is off screen has its
 * label held at the top left of the part that is showing, the way a sticky
 * header is.
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
    const { size, alpha } = labelSize(d, shown, d.name.length, o.advance);
    if (size === 0) continue;
    const w = plateW(d.name.length, size, o.advance);
    const h = size * PLATE_LINE;
    // Where the directory's own frame puts it: text aligned with the
    // contents' left edge, centred in the band above them when the band is
    // tall enough, and just inside the corner when it is not.
    const x = Math.max(d.x + Math.max(INSET_PX, o.inset - PLATE_PAD * size), shown.x + INSET_PX);
    let y = Math.max(d.y + Math.max(INSET_PX, (o.strip - h) / 2), shown.y + INSET_PX);
    let plate = { x, y, w, h };
    // Pushed down once, below whatever it ran into, as long as it stays in
    // the upper part of the directory. A child in its parent's corner would
    // otherwise always lose its label to the parent's.
    const hit = placed.find((p) => overlaps(p, plate));
    if (hit) {
      y = hit.y + hit.h + GAP_PX;
      plate = { x, y, w, h };
      if (y + h > shown.y + shown.h / 2 || placed.some((p) => overlaps(p, plate))) continue;
    }
    if (x + w > shown.x + shown.w - INSET_PX) continue;
    placed.push(plate);
    labels.push({ path: d.path, text: d.name, size, plate, alpha });
  }
  return { labels, crumb };
}

/** One line, top left, outermost first, dropping from the front with a
 *  leading ".." when it is wider than the view. */
function placeCrumb(chain: ScreenDir[], o: PlaceOpts): Breadcrumb {
  const size = CRUMB_SIZE;
  const ch = o.advance * size;
  const sep = ' / ';
  const room = Math.max(1, Math.floor((o.vw - 4 * INSET_PX - 2 * PLATE_PAD * size) / ch));
  let first = 0;
  const width = (from: number) =>
    chain.slice(from).reduce((n, d) => n + d.name.length, 0)
    + (chain.length - from - 1) * sep.length + (from > 0 ? 2 + sep.length : 0);
  while (first < chain.length - 1 && width(first) > room) first++;

  const h = size * PLATE_LINE;
  const x0 = 2 * INSET_PX;
  const y = 2 * INSET_PX;
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
