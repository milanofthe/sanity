// Turns a flat list of repo-relative paths into a nested, space-filling layout.
//
// Areas are computed bottom up, then rectangles are handed out top down by a
// squarified treemap, and each panel picks the column count that fits the slot
// it was given. See treemap.ts for why nesting rules out a rectangle packer.

import { metrics } from '../tokens';
import { fitPanel, panelArea, panelGeometry, type PanelGeometry } from './panel';
import { layoutTreemap, type Rect } from './treemap';

/** Width over height the whole canvas aims for; screens are wide. */
const ROOT_ASPECT = 16 / 9;

export interface FileEntry {
  path: string;
  lineCount: number;
  maxCols: number;
}

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  lineCount: number;
  maxCols: number;
  geom: PanelGeometry;
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
      geom: panelGeometry(e.lineCount, e.maxCols),
      area: panelArea(e.lineCount, e.maxCols),
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

function placeFile(f: FileNode, r: Rect): void {
  f.slotW = r.w;
  f.slotH = r.h;
  f.geom = fitPanel(f.lineCount, f.maxCols, r.w, r.h);
  f.w = f.geom.w;
  f.h = f.geom.h;
  // Centre in the slot, but never start outside it: a panel that could not be
  // fitted should overflow to the right and bottom, where it is least likely
  // to collide with a sibling.
  f.x = Math.max(r.x, r.x + (r.w - f.w) / 2);
  f.y = Math.max(r.y, r.y + (r.h - f.h) / 2);
}

function placeDir(dir: DirNode, r: Rect): void {
  dir.x = r.x;
  dir.y = r.y;
  dir.w = r.w;
  dir.h = r.h;

  // Degrade gracefully: a directory whose slot is barely larger than its own
  // frame drops the frame rather than handing its children a negative region.
  const roomy =
    r.w > 4 * metrics.dirPad && r.h > 4 * metrics.dirPad + metrics.dirLabelHeight;
  const pad = roomy ? metrics.dirPad : 0;
  const label = roomy ? metrics.dirLabelHeight : 0;
  const inner: Rect = {
    x: r.x + pad,
    y: r.y + pad + label,
    w: Math.max(1, r.w - 2 * pad),
    h: Math.max(1, r.h - 2 * pad - label),
  };

  layoutTreemap(dir.children, inner, (child, slot) => {
    if (child.kind === 'file') placeFile(child, slot);
    else placeDir(child, slot);
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
    placeDir(root, { x: 0, y: 0, w, h: area / w });

    remaining = 0;
    for (const f of files) {
      if (f.w <= f.slotW + 0.5 && f.h <= f.slotH + 0.5) continue;
      remaining++;
      // Ask for the area a slot of this aspect ratio would need in order to
      // contain the panel. Asking merely for the panel's own area is what
      // made an earlier version of this loop fail to converge: a panel that
      // overflows a flat slot usually has the same area as the slot, so the
      // correction was a few percent when a factor of three was needed.
      const aspect = f.slotW / Math.max(1, f.slotH);
      const need = Math.max(f.w, f.h * aspect) * Math.max(f.h, f.w / aspect);
      f.area = Math.max(f.area, need) * 1.02;
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
  for (const f of files) totalLines += f.lineCount;

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
  /** Panels that did not fit the slot they were given, as a fraction. */
  overflow: number;
  /** Sibling pairs that overlap, which must be zero. */
  overlaps: number;
  dirCount: number;
  /** Mean of each panel's own aspect ratio, as a sanity check on shape. */
  meanAspect: number;
}

export function layoutStats(l: Layout): LayoutStats {
  let panelArea = 0;
  let aspectSum = 0;
  for (const f of l.files) {
    panelArea += f.w * f.h;
    aspectSum += f.w / Math.max(1, f.h);
  }

  let overflow = 0;
  let overlaps = 0;
  for (const d of l.dirs) {
    const kids = d.children;
    for (let i = 0; i < kids.length; i++) {
      const a = kids[i];
      if (a.x < d.x || a.y < d.y || a.x + a.w > d.x + d.w + 0.5 || a.y + a.h > d.y + d.h + 0.5) {
        overflow++;
      }
      for (let j = i + 1; j < kids.length; j++) {
        const b = kids[j];
        if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
            a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) {
          overlaps++;
        }
      }
    }
  }

  return {
    fill: panelArea / Math.max(1, l.root.w * l.root.h),
    aspect: l.root.w / Math.max(1, l.root.h),
    overflow: overflow / Math.max(1, l.files.length + l.dirs.length),
    overlaps,
    dirCount: l.dirs.length,
    meanAspect: aspectSum / Math.max(1, l.files.length),
  };
}
