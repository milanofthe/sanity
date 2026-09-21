// Turns a flat list of repo-relative paths into a nested, space-filling layout.
//
// Areas are computed bottom up, then rectangles are handed out top down by a
// squarified treemap, and each panel picks the column count that fits the slot
// it was given. See treemap.ts for why nesting rules out a rectangle packer.

import { metrics } from '$lib/metrics';
import {
  fillSlot, panelArea, panelGeometry, stubArea, stubGeometry, type PanelGeometry,
} from './panel';
import { CELL, cells, layoutTreemap, toWorld, type IntRect } from './treemap';

/** Width over height the whole canvas aims for; screens are wide. */
const ROOT_ASPECT = 16 / 9;

/**
 * Gap between a panel and the edge of its slot: one grid cell.
 *
 * One cell rather than zero so that two neighbouring panels do not each draw
 * their border along the same line, and rather than some smaller value because
 * a gap off the lattice would push the text off the character grid with it.
 * Same size as the gap between directories, so every separation in the layout
 * is the same width.
 */
const PANEL_GAP_CELLS = 1;

/** Directory frame, in grid cells, so the nesting also lands on the lattice. */
const DIR_PAD_CELLS = 1;
const DIR_LABEL_CELLS = 1;

/**
 * Cells a directory gives up at its right and bottom edge.
 *
 * The treemap tiles exactly, so without this two sibling directories share an
 * edge and each draws its own border along it: a doubled line, and where three
 * boxes meet a doubled corner. Leaving a cell means every border stands alone,
 * which is also what lets the borders be thick enough to read.
 */
const DIR_GAP_CELLS = 1;

export interface FileEntry {
  path: string;
  lineCount: number;
  /** Width the panel is sized for: the 90th percentile of line widths. */
  maxCols: number;
  /** Longest line, where text may be clipped. Defaults to `maxCols` when a
   *  source does not distinguish them. */
  clipCols?: number;
  /** When set, the file is laid out as a fixed-size stub: present in the
   *  structure, not drawn. Files that should not appear at all are filtered
   *  out before they get here. */
  stub?: boolean;
}

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  lineCount: number;
  maxCols: number;
  clipCols: number;
  geom: PanelGeometry;
  /** Laid out as a fixed-size placeholder rather than drawn. */
  stub: boolean;
  /** False when the slot did not reach the preferred column width; the fitting
   *  passes grow such a file's area and try again. */
  fits: boolean;
  /** False when the panel is too narrow to draw at all. The layout check
   *  asserts this is never false. */
  usable: boolean;
  /** Treemap weight: the area this file needs. Corrected by the fitting
   *  passes when the shape it was given turns out to need more. */
  area: number;
  /** The slot the treemap handed out, kept so overflow can be detected. */
  slotW: number;
  slotH: number;
  /** Absolute world position of the panel's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Slot in the overview texture array, assigned by the renderer. */
  layer: number;
}

export interface DirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: Node[];
  depth: number;
  area: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Node = FileNode | DirNode;

export interface Layout {
  root: DirNode;
  files: FileNode[];
  dirs: DirNode[];
  bounds: [number, number, number, number];
  totalLines: number;
}

function newDir(name: string, path: string, depth: number): DirNode {
  return { kind: 'dir', name, path, children: [], depth, area: 0, x: 0, y: 0, w: 0, h: 0 };
}

function buildTree(entries: FileEntry[]): DirNode {
  const root = newDir('', '', 0);
  const dirIndex = new Map<string, DirNode>([['', root]]);

  for (const e of entries) {
    const parts = e.path.split('/');
    const fileName = parts.pop()!;
    let parent = root;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let d = dirIndex.get(prefix);
      if (!d) {
        d = newDir(part, prefix, parent.depth + 1);
        dirIndex.set(prefix, d);
        parent.children.push(d);
      }
      parent = d;
    }
    parent.children.push({
      kind: 'file',
      name: fileName,
      path: e.path,
      lineCount: e.lineCount,
      maxCols: e.maxCols,
      clipCols: Math.max(e.clipCols ?? e.maxCols, e.maxCols),
      geom: e.stub ? stubGeometry() : panelGeometry(e.lineCount, e.maxCols),
      stub: Boolean(e.stub),
      fits: true,
      usable: true,
      area: e.stub ? stubArea() : panelArea(e.lineCount, e.maxCols),
      slotW: 0,
      slotH: 0,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      layer: -1,
    });
  }
  return root;
}

/** Collapse directories that hold a single subdirectory and nothing else, so
 *  that `src/main/java/com/x` does not cost four nested boxes. */
function collapseChains(dir: DirNode): void {
  while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
    const only = dir.children[0] as DirNode;
    dir.name = dir.name ? `${dir.name}/${only.name}` : only.name;
    dir.path = only.path;
    dir.children = only.children;
  }
  for (const c of dir.children) if (c.kind === 'dir') collapseChains(c);
}

/**
 * Compute treemap weights bottom up.
 *
 * A directory's frame costs a fixed amount of space regardless of how small
 * its slot is, so that cost has to be folded into its weight. Approximating
 * the inner region as a square of side sqrt(childArea) is close enough, and
 * without it a deep directory holding two small files gets a slot its own
 * border does not fit in.
 */
function computeAreas(dir: DirNode): number {
  let inner = 0;
  for (const c of dir.children) {
    inner += c.kind === 'file' ? c.area : computeAreas(c);
  }
  const side = Math.sqrt(Math.max(1, inner));
  const pad = 2 * metrics.dirPad;
  dir.area = (side + pad) * (side + pad + metrics.dirLabelHeight);
  return dir.area;
}

/** Sort children for a stable, readable order before the treemap sorts them
 *  by area: files before subdirectories, alphabetical within each group. The
 *  treemap keeps this as its tie-break, so equal-sized siblings stay put. */
function sortChildren(dir: DirNode): void {
  const files = dir.children.filter((c): c is FileNode => c.kind === 'file');
  const subs = dir.children.filter((c): c is DirNode => c.kind === 'dir');
  const byName = (a: Node, b: Node) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  files.sort(byName);
  subs.sort(byName);
  dir.children = [...files, ...subs];
  for (const sub of subs) sortChildren(sub);
}

function placeFile(f: FileNode, slot: IntRect): void {
  // Give up a cell at the right and bottom, the same way directories do.
  const own: IntRect = {
    x: slot.x,
    y: slot.y,
    w: Math.max(1, slot.w - PANEL_GAP_CELLS),
    h: Math.max(1, slot.h - PANEL_GAP_CELLS),
  };
  const r = toWorld(own);
  const w = r.w;
  const h = r.h;
  f.slotW = w;
  f.slotH = h;
  f.x = r.x;
  f.y = r.y;

  if (f.stub) {
    // A stub never reshapes: its fixed size is the point. It still sits at the
    // slot origin, so it lines up with everything around it.
    f.geom = stubGeometry();
    f.w = Math.min(w, f.geom.w);
    f.h = Math.min(h, f.geom.h);
    f.fits = true;
    f.usable = true;
    return;
  }

  // The panel is the slot. Everything about its text layout is derived from
  // the rectangle it was given, which is what makes the edges align.
  const fit = fillSlot(f.lineCount, f.clipCols, w, h);
  f.geom = fit;
  f.w = w;
  f.h = h;
  f.fits = fit.ok;
  f.usable = fit.usable;
}

function placeDir(dir: DirNode, slot: IntRect): void {
  // Shrink away from the right and bottom edge so a sibling's border does not
  // land on top of this one. The root has no sibling, so it keeps its cells.
  const gap = dir.depth === 0 ? 0 : DIR_GAP_CELLS;
  const own: IntRect = {
    x: slot.x,
    y: slot.y,
    w: Math.max(1, slot.w - gap),
    h: Math.max(1, slot.h - gap),
  };
  const r = toWorld(own);
  dir.x = r.x;
  dir.y = r.y;
  dir.w = r.w;
  dir.h = r.h;

  // Degrade gracefully: a directory whose slot is barely larger than its own
  // frame drops the frame rather than handing its children a negative region.
  const roomy =
    own.w > 2 * DIR_PAD_CELLS + 2 && own.h > 2 * DIR_PAD_CELLS + DIR_LABEL_CELLS + 2;
  const pad = roomy ? DIR_PAD_CELLS : 0;
  const label = roomy ? DIR_LABEL_CELLS : 0;
  const inner: IntRect = {
    x: own.x + pad,
    y: own.y + pad + label,
    w: Math.max(1, own.w - 2 * pad),
    h: Math.max(1, own.h - 2 * pad - label),
  };

  layoutTreemap(dir.children, inner, (child, childSlot) => {
    if (child.kind === 'file') placeFile(child, childSlot);
    else placeDir(child, childSlot);
  });
}

function collect(dir: DirNode, files: FileNode[], dirs: DirNode[]): void {
  dirs.push(dir);
  for (const c of dir.children) {
    if (c.kind === 'file') files.push(c);
    else collect(c, files, dirs);
  }
}

/** How many times to re-run the subdivision with corrected areas. */
const FIT_PASSES = 14;

/**
 * Lay out once, then correct.
 *
 * A panel's area depends on the shape of the slot it gets, and the slot
 * depends on the area, so one pass cannot satisfy both: a file handed a slot
 * whose aspect ratio none of its column counts can match overflows it and
 * collides with a sibling. Re-running the subdivision with each overflowing
 * file's area raised to what it actually needed converges in a handful of
 * passes, and unlike a safety factor it costs nothing in fill where the first
 * guess was already right.
 */
function fitPasses(root: DirNode, files: FileNode[]): number {
  let remaining = 0;
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const area = computeAreas(root);
    const w = Math.sqrt(area * ROOT_ASPECT);
    placeDir(root, { x: 0, y: 0, w: cells(w), h: cells(area / w) });

    remaining = 0;
    for (const f of files) {
      if (f.fits) continue;
      remaining++;
      // Ask for the area a slot of this aspect ratio would need to hold the
      // panel at its natural shape. Asking merely for the panel's own area is
      // what made an earlier version of this loop fail to converge: a panel
      // that cannot use a flat slot usually has the same area as the slot, so
      // the correction was a few percent when a factor of three was needed.
      const natural = panelGeometry(f.lineCount, f.maxCols);
      const aspect = f.slotW / Math.max(1, f.slotH);
      const need =
        Math.max(natural.w, natural.h * aspect) * Math.max(natural.h, natural.w / aspect);
      f.area = Math.max(f.area, need) * 1.06;
    }
    if (remaining === 0) break;
  }
  return remaining;
}

export function computeLayout(entries: FileEntry[]): Layout {
  const root = buildTree(entries);
  collapseChains(root);
  sortChildren(root);

  const allFiles: FileNode[] = [];
  const allDirs: DirNode[] = [];
  collect(root, allFiles, allDirs);
  fitPasses(root, allFiles);

  const files: FileNode[] = [];
  const dirs: DirNode[] = [];
  collect(root, files, dirs);

  let totalLines = 0;
  for (const f of files) if (!f.stub) totalLines += f.lineCount;

  return {
    root,
    files,
    dirs,
    bounds: [root.x, root.y, root.x + root.w, root.y + root.h],
    totalLines,
  };
}

export interface LayoutStats {
  /** Panel area divided by the area of the root box. The number to beat. */
  fill: number;
  /** Root box width over height. */
  aspect: number;
  /** Panels that did not reach the preferred column width. Cosmetic. */
  misfits: number;
  /** Panels too narrow to draw. This one has to be zero. */
  unusable: number;
  /** Sibling pairs that overlap. Must be zero: the treemap tiles exactly, so
   *  anything here means the integer split lost or double-counted a cell. */
  overlaps: number;
  /** Panel edges that do not sit on the grid. Must be zero. */
  offGrid: number;
  dirCount: number;
  /** Mean of each panel's own aspect ratio, as a check on shape. */
  meanAspect: number;
  /** Mean characters per code column; a panel that fills a narrow slot gets
   *  fewer, and if this drops far below the natural width the treemap is
   *  handing out badly shaped slots. */
  meanCols: number;
  /** The directory with the most children among those that had an overlap,
   *  with its size in cells. Points straight at whether the integer split ran
   *  out of cells or got the arithmetic wrong. */
  worstOverlap: { path: string; children: number; cellsW: number; cellsH: number };
}

export function layoutStats(l: Layout): LayoutStats {
  let panelArea = 0;
  let aspectSum = 0;
  let colsSum = 0;
  let misfits = 0;
  let unusable = 0;
  for (const f of l.files) {
    panelArea += f.w * f.h;
    aspectSum += f.w / Math.max(1, f.h);
    colsSum += f.geom.cols;
    if (!f.fits) misfits++;
    if (!f.usable) unusable++;
  }

  let overlaps = 0;
  let offGrid = 0;
  let worst = { path: '', children: 0, cellsW: 0, cellsH: 0 };
  const onGrid = (v: number) => Math.abs(v / CELL - Math.round(v / CELL)) < 1e-6;
  for (const d of l.dirs) {
    const kids = d.children;
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i];
      if (!onGrid(a.x) || !onGrid(a.y)) offGrid++;
      for (let j = i + 1; j < kids.length; j++) {
        const b = kids[j];
        if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
            a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) {
          overlaps++;
          if (kids.length > worst.children) {
            worst = {
              path: d.path || '/',
              children: kids.length,
              cellsW: Math.round(d.w / CELL),
              cellsH: Math.round(d.h / CELL),
            };
          }
        }
      }
    }
  }

  return {
    fill: panelArea / Math.max(1, l.root.w * l.root.h),
    aspect: l.root.w / Math.max(1, l.root.h),
    misfits,
    unusable,
    overlaps,
    offGrid,
    dirCount: l.dirs.length,
    meanAspect: aspectSum / Math.max(1, l.files.length),
    meanCols: colsSum / Math.max(1, l.files.length),
    worstOverlap: worst,
  };
}
