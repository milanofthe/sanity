// Turns a flat list of repo-relative paths into a nested, space-filling layout.
//
// Areas are computed bottom up, then rectangles are handed out top down by a
// squarified treemap, and each panel picks the column count that fits the slot
// it was given. See treemap.ts for why nesting rules out a rectangle packer.

import { columns as colBounds, metrics } from '$lib/metrics';
import {
  COLUMN_GUTTER, columnsWorth, fillSlot, MAX_COLUMNS, MAX_PANEL_COLS, MIN_PANEL_COLS,
  panelArea as panelArea_, panelGeometry,
  mediaGeometry, stubArea, stubGeometry, type PanelGeometry,
  SMALL_FILE_LINES,
} from './panel';
import { visualRowsCached, widthCovering } from './wrap';
import { CELL, cells, layoutTreemap, toWorld, type IntRect } from './treemap';

/**
 * Width over height the whole canvas aims for.
 *
 * Follows the window rather than being fixed, because the fit-to-view zoom is
 * `min(vw / w, vh / h)`: whichever way the canvas and the window disagree, the
 * difference is screen left empty. A 16:9 canvas in a 3:2 window uses 88
 * percent of the height available to it and nothing can be done about that
 * from the camera's side.
 *
 * It is free to follow the window because the layout barely cares. Swept from
 * 1.0 to 3.0 on a 989 file repository, the fill rate stayed between 95.8 and
 * 96.6 percent and the mean panel aspect between 1.24 and 1.41, so there is no
 * packing reason to prefer one over another.
 *
 * The clamp keeps a pathological window from producing a canvas nobody can
 * navigate: a very tall one would stack the whole project into a ribbon.
 */
const ROOT_ASPECT_MIN = 0.8;
const ROOT_ASPECT_MAX = 3.2;
const ROOT_ASPECT_DEFAULT = 16 / 9;

function rootAspect(viewport?: { w: number; h: number }): number {
  if (!viewport || viewport.w <= 0 || viewport.h <= 0) return ROOT_ASPECT_DEFAULT;
  return Math.min(ROOT_ASPECT_MAX, Math.max(ROOT_ASPECT_MIN, viewport.w / viewport.h));
}

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

/**
 * Ceiling on the aspect bound a directory passes upward.
 *
 * Bounds multiply up a tree: a directory of eight flexible children is eight
 * times as flexible, and four levels of that is a number the treemap may as
 * well treat as no bound at all. Capping it keeps the arithmetic finite and
 * costs nothing, since a rectangle ten times as wide as it is tall is already
 * outside what a squarified treemap hands out.
 */
const DIR_ASPECT_CAP = 10;

/**
 * Widest shape a picture's panel may be given.
 *
 * A picture has an aspect of its own, and it is tempting to hand that to the
 * treemap as a hard bound. That makes it a fixed box, which is the thing
 * stubs had to be lifted out of the treemap for. So a picture is bent like
 * any other panel and fitted inside what it gets; this only keeps it from
 * becoming a letterbox.
 */
const MEDIA_ASPECT_CAP = 6;

/** How much smaller than it asked for a picture's panel may be before the
 *  fitting pass grows it. Five percent, so a rounding of the cell grid is not
 *  a reason to run another pass. */
const MEDIA_FIT_SLACK = 0.95;

/** Floor under how badly a slot's shape can be counted against a picture, so
 *  one bad pass cannot ask for a canvas. A tenth means a 10:1 mismatch is the
 *  worst that is ever paid for. */
const MEDIA_MIN_EFFICIENCY = 0.1;

/** How much larger than it asked for a picture's panel may come out, when the
 *  slot allows. A quarter, so a row of pictures can use up a little slack
 *  without any of them becoming the largest thing on the canvas. */
const MEDIA_OVERSHOOT = 1.25;

export interface FileEntry {
  path: string;
  lineCount: number;
  /** Width the panel is sized for: the 90th percentile of line widths. */
  maxCols: number;
  /** Longest line, where text may be clipped. Defaults to `maxCols` when a
   *  source does not distinguish them. */
  clipCols?: number;
  /** Width of every line, for working out how tall the file is once its long
   *  lines wrap. Without it the layout falls back to one row per line. */
  lineCols?: ArrayLike<number>;
  /** When set, the file is laid out as a fixed-size stub: present in the
   *  structure, not drawn. Files that should not appear at all are filtered
   *  out before they get here. */
  stub?: boolean;
  /** Set when the file is a picture rather than text: an image with pixel
   *  dimensions, or a document with pages. It carries no lines, so its panel
   *  is sized from this instead. See `sanity_core::media`. */
  media?: MediaSize;
}

/** What the layout needs to know about a picture. */
export interface MediaSize {
  kind: 'image' | 'document';
  /** Pixel size for an image, point size of a page for a document; 0 when
   *  the file did not say. */
  w: number;
  h: number;
  /** Pages, 0 for an image and for a document that hides its page tree. */
  pages: number;
}

/** The panel a picture asks for. Deterministic, so the fitting pass and the
 *  placement can both ask without storing it. */
export function mediaWant(m: MediaSize): PanelGeometry {
  const shape = mediaShape(m);
  return mediaGeometry(shape.aspect, shape.pixels);
}

/** Preferred proportion of a picture's panel, and how much canvas it is
 *  worth. A document with no page size of its own is treated as A4. */
export function mediaShape(m: MediaSize): { aspect: number; pixels: number } {
  const w = m.w > 0 ? m.w : 595;
  const h = m.h > 0 ? m.h : 842;
  const pages = m.kind === 'document' ? Math.max(1, m.pages) : 1;
  return { aspect: w / h, pixels: w * h * pages };
}

export interface FileNode {
  kind: 'file';
  name: string;
  path: string;
  lineCount: number;
  maxCols: number;
  clipCols: number;
  lineCols: ArrayLike<number>;
  geom: PanelGeometry;
  /** Laid out as a fixed-size placeholder rather than drawn. */
  stub: boolean;
  /** Set when the panel holds a picture instead of lines. */
  media?: MediaSize;
  /** False when the slot did not reach the preferred column width; the fitting
   *  passes grow such a file's area and try again. */
  fits: boolean;
  /** In more columns than its rows are worth. A preference, not a misfit; see
   *  `SlotFit.crowded`. */
  crowded: boolean;
  /** In columns narrower than `fullCols`; see `SlotFit.narrow`. */
  narrow: boolean;
  /** Given area for a preference, crowded or narrow, by the fitting pass. */
  offered: boolean;
  /** Column width that holds `columns.fullWidthShare` of the lines unwrapped,
   *  or zero when there is no such preference. */
  fullCols: number;
  /** False when the panel is too narrow to draw at all. The layout check
   *  asserts this is never false. */
  usable: boolean;
  /** False when the panel is too short for its own wrapped rows, so some of
   *  its lines have nowhere to go. Also asserted. */
  holdsAll: boolean;
  /** Treemap weight: the area this file needs. Corrected by the fitting
   *  passes when the shape it was given turns out to need more. */
  area: number;
  /** Smallest slot the panel can be drawn in, and the widest shape it can
   *  take, in grid cells. Handed to the treemap so it can respect them while
   *  it cuts, rather than being discovered afterwards. See `Sized`. */
  minW: number;
  minH: number;
  maxAspect: number;
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
  /** Smallest slot this directory can hold its frame and its largest child
   *  in, in grid cells. */
  minW: number;
  minH: number;
  /**
   * Widest shape this directory can be given, as width over height.
   *
   * A directory does have one, and forgetting it was expensive. Its children
   * can be arranged many ways, so on its own it is flexible, but no
   * arrangement is wider than all of them side by side: a box holding three
   * files that can each be at most twice as wide as tall cannot usefully be
   * twenty times as wide as tall. Without this the bound was enforced between
   * siblings and then thrown away one level up, which put flat rectangles in
   * front of children that could not fill them.
   */
  maxAspect: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The placeholders of one directory, laid out as a grid rather than a treemap.
 *
 * A stub says "this file exists" and nothing else: it has a fixed size and
 * carries no information about how large the file is, which is the whole point
 * of the mode. A treemap over such items is meaningless and it looked it.
 * Measured on pathsim with its 275 Python files and 34 notebooks reduced: the
 * canvas dropped to 69 percent panel, the mean panel aspect went to 7.5, and
 * one pair of siblings overlapped, because a subdivision was dividing area
 * among items whose area is a constant and whose shape cannot bend.
 *
 * So they are collected per directory into one node the treemap sees as a
 * single item, with the area of the grid they need and a shape a grid can
 * take, and the chips are packed into whatever rectangle it gets. That fills
 * densely, cannot overlap by construction, and reads as what it is: a block of
 * files that are present and not being shown.
 */
export interface StubBlock {
  kind: 'stubs';
  /** The placeholders in this block, in the order they are packed. */
  children: FileNode[];
  area: number;
  minW: number;
  minH: number;
  maxAspect: number;
  /** Chips that did not fit in the rectangle the block was given, so the
   *  fitting passes know to ask for more. */
  hidden: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Node = FileNode | DirNode | StubBlock;

export interface Layout {
  root: DirNode;
  files: FileNode[];
  dirs: DirNode[];
  bounds: [number, number, number, number];
  totalLines: number;
}

function newDir(name: string, path: string, depth: number): DirNode {
  return {
    kind: 'dir', name, path, children: [], depth, area: 0,
    minW: 1, minH: 1, maxAspect: Infinity, x: 0, y: 0, w: 0, h: 0,
  };
}

/**
 * The smallest slot a panel can be drawn in, and the widest shape it can take.
 *
 * The floors are the preferred minimum column width and a panel with a single
 * line in it. The ceiling on the aspect is the panel at its widest: every code
 * column it is allowed, each as wide as the file's own longest line, which is
 * as flat as it can get. A slot wider than that cannot be filled however the
 * lines are wrapped, which is the thing the fitting loop used to discover one
 * expensive pass at a time.
 */
function panelBounds(lineCols: ArrayLike<number>, geom: PanelGeometry): {
  minW: number; minH: number; maxAspect: number;
} {
  const rows = Math.max(1, visualRowsCached(lineCols, geom.cols));
  const pitch = geom.cols * metrics.charWidth + COLUMN_GUTTER;
  // At the column cap, not at the fewest columns the file is worth cutting
  // into. The two differ for short files, and this is the bound on what the
  // panel *can* fill rather than on what it would rather be: handed a slot
  // flatter than it likes, a panel still takes the columns it needs to hold
  // its rows. Tried the other way round, so the treemap would hand short
  // files taller slots directly: it does place a few more of them in one
  // column, and it also put a thirteen line file in a slot of 210 by 98,
  // where seven columns of twelve characters is the only way to fill it and
  // none of them is readable. A preference belongs where it can be given up,
  // which is the fitting pass, not in a bound the packing takes literally.
  const widest = MAX_COLUMNS * pitch - COLUMN_GUTTER + 2 * metrics.panelPadX;
  const shortest =
    Math.ceil(rows / MAX_COLUMNS) * metrics.lineHeight
    + metrics.titleHeight + 2 * metrics.panelPadY;
  return {
    // Plus the cell each panel gives up at its right and bottom edge, or the
    // floor would be one cell short of usable exactly when it matters.
    minW: cells(MIN_PANEL_COLS * metrics.charWidth + 2 * metrics.panelPadX) + PANEL_GAP_CELLS,
    minH: cells(metrics.titleHeight + 2 * metrics.panelPadY + metrics.lineHeight)
      + PANEL_GAP_CELLS,
    maxAspect: widest / Math.max(1, shortest),
  };
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
    // A source without widths gets a flat profile, which reduces to the old
    // one-row-per-line behaviour rather than breaking.
    const lineCols = e.lineCols ?? new Uint16Array(e.lineCount).fill(e.maxCols);
    // A picture is not a stub and not text: it has a size of its own, and a
    // shape the layout is free to bend, since the picture is fitted into
    // whatever panel it ends up with.
    const shape = e.media && !e.stub ? mediaShape(e.media) : null;
    const geom = shape
      ? mediaGeometry(shape.aspect, shape.pixels)
      : e.stub
        ? stubGeometry()
        : panelGeometry(lineCols, e.maxCols);
    const bounds = shape
      ? {
        minW: cells(MIN_PANEL_COLS * metrics.charWidth + 2 * metrics.panelPadX) + PANEL_GAP_CELLS,
        minH: cells(metrics.titleHeight + 2 * metrics.panelPadY + metrics.lineHeight)
          + PANEL_GAP_CELLS,
        // Up to the picture's own proportion, never below a square-ish
        // bound: a hard aspect here would be a fixed box by another name, and
        // fixed boxes are what stubs had to be taken out of the treemap for.
        // This only nudges wide pictures towards wide slots, which is what
        // keeps the unused part of a slot small.
        maxAspect: Math.min(
          MEDIA_ASPECT_CAP,
          Math.max(1.3, mediaShape(e.media!).aspect * 1.2),
        ),
      }
      : e.stub
        ? {
          // A stub is a fixed box: its minimum is its size and it has no other
          // shape to offer.
          minW: cells(geom.w) + PANEL_GAP_CELLS,
          minH: cells(geom.h) + PANEL_GAP_CELLS,
          maxAspect: geom.w / Math.max(1, geom.h),
        }
        : panelBounds(lineCols, geom);
    parent.children.push({
      kind: 'file',
      name: fileName,
      path: e.path,
      lineCount: e.lineCount,
      maxCols: e.maxCols,
      clipCols: Math.max(e.clipCols ?? e.maxCols, e.maxCols),
      lineCols,
      geom,
      minW: bounds.minW,
      minH: bounds.minH,
      maxAspect: bounds.maxAspect,
      stub: Boolean(e.stub),
      media: e.media,
      fits: true,
      crowded: false,
      narrow: false,
      offered: false,
      fullCols: e.stub || e.media || colBounds.fullWidthShare <= 0
        ? 0
        : Math.min(MAX_PANEL_COLS, widthCovering(lineCols, colBounds.fullWidthShare)),
      usable: true,
      holdsAll: true,
      // The treemap weight: a stub's fixed box, or the area the file needs
      // once its long lines have wrapped.
      area: shape
        ? cells(geom.w) * cells(geom.h)
        : e.stub
          ? stubArea()
          : panelArea_(lineCols, e.maxCols),
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
  let minW = 1;
  let minH = 1;
  let wide = 0;
  for (const c of dir.children) {
    inner += c.kind === 'dir' ? computeAreas(c) : c.area;
    // A directory has to be able to hold its largest child, whatever else it
    // holds: below that, the child it cannot fit is the one that misfits, and
    // the correction would go to the child while the shortage is the parent's.
    if (c.minW > minW) minW = c.minW;
    if (c.minH > minH) minH = c.minH;
    // Every child side by side: the widest arrangement there is.
    wide += Math.min(DIR_ASPECT_CAP, c.maxAspect);
  }
  const side = Math.sqrt(Math.max(1, inner));
  const pad = 2 * metrics.dirPad;
  dir.area = (side + pad) * (side + pad + metrics.dirLabelHeight);
  dir.minW = minW + 2 * DIR_PAD_CELLS + DIR_GAP_CELLS;
  dir.minH = minH + 2 * DIR_PAD_CELLS + DIR_LABEL_CELLS + DIR_GAP_CELLS;
  dir.maxAspect = Math.min(DIR_ASPECT_CAP, Math.max(1, wide));
  return dir.area;
}

/** Sort children for a stable, readable order before the treemap sorts them
 *  by area: files before subdirectories, alphabetical within each group. The
 *  treemap keeps this as its tie-break, so equal-sized siblings stay put. */
function sortChildren(dir: DirNode): void {
  const files = dir.children.filter((c): c is FileNode => c.kind === 'file');
  const subs = dir.children.filter((c): c is DirNode => c.kind === 'dir');
  const byName = (a: FileNode | DirNode, b: FileNode | DirNode) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  files.sort(byName);
  subs.sort(byName);
  const drawn = files.filter((f) => !f.stub);
  const stubs = files.filter((f) => f.stub);
  dir.children = stubs.length > 0
    ? [...drawn, stubBlock(stubs), ...subs]
    : [...drawn, ...subs];
  for (const sub of subs) sortChildren(sub);
}

/** One chip and the gap it gives up, in grid cells. */
function chipCells(): { w: number; h: number } {
  const g = stubGeometry();
  return { w: cells(g.w) + PANEL_GAP_CELLS, h: cells(g.h) + PANEL_GAP_CELLS };
}

/** Wrap a directory's placeholders into a block the treemap can place. */
function stubBlock(stubs: FileNode[]): StubBlock {
  const chip = chipCells();
  const n = stubs.length;
  // Area in world units, from whole chips, so the weight it asks for is the
  // space it will actually use. A weight below that is what made the treemap
  // hand out slots the chips did not fit in.
  const area = n * chip.w * chip.h * CELL * CELL;
  // Shape: anything from one column of chips to one row of them. A grid can
  // take any of it, and saying so keeps the treemap from correcting a block
  // that was never in trouble.
  return {
    kind: 'stubs',
    children: stubs,
    area,
    minW: chip.w,
    minH: chip.h,
    maxAspect: Math.max(1, (n * chip.w) / chip.h),
    hidden: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
}

/**
 * Pack the chips into the rectangle the block was given.
 *
 * The columns come from the slot's width and then take all of it, the same way
 * a panel is the slot it was given rather than a fixed box centred in one.
 * That is what makes a block read as a block: with chips at a fixed width the
 * grid left a ragged margin down its right side and, in a slot taller than the
 * count needed, an empty half at the bottom.
 *
 * A chip's width carries no meaning, so stretching it costs nothing and buys
 * something: the wider it is, the more of the file's name fits in it.
 */
function placeStubs(block: StubBlock, slot: IntRect): void {
  const r = toWorld(slot);
  block.x = r.x;
  block.y = r.y;
  block.w = r.w;
  block.h = r.h;

  const chip = chipCells();
  const n = block.children.length;
  // Whole chips only, in both directions. Nothing here may leave the slot: a
  // block is placed by the treemap like any other child, so a chip past its
  // right edge is a chip in a sibling directory, and one past the bottom is a
  // chip over whatever is below. Both happened, from forcing the last column
  // to a full chip width when the slot had less than that left: 70 chips stood
  // 28 units outside their directory and one of them landed on a panel two
  // boxes away.
  const fitCols = Math.floor(slot.w / chip.w);
  const fitRows = Math.floor(slot.h / chip.h);
  const geom = stubGeometry();
  block.hidden = 0;

  if (fitCols < 1 || fitRows < 1) {
    // The slot cannot hold a single chip. Everything is hidden and counted, so
    // the fitting pass asks for a rectangle that can.
    for (const f of block.children) {
      f.geom = geom;
      f.slotW = 0;
      f.slotH = 0;
      f.x = r.x;
      f.y = r.y;
      f.w = 0;
      f.h = 0;
      f.fits = true;
      f.holdsAll = true;
      f.usable = false;
      block.hidden++;
    }
    return;
  }

  // As few columns as the height allows, so the chips stay wide and their
  // names readable, and never more than the width can hold.
  const cols = Math.max(1, Math.min(fitCols, Math.ceil(n / fitRows)));
  const colW = Math.floor(slot.w / cols);

  for (let i = 0; i < n; i++) {
    const f = block.children[i];
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    const at: IntRect = {
      x: slot.x + cx * colW,
      y: slot.y + cy * chip.h,
      // The last column takes what the division left over, so the block's
      // right edge is the slot's and no further.
      w: cx === cols - 1 ? slot.w - cx * colW : colW,
      h: chip.h,
    };
    const world = toWorld(at);
    f.geom = geom;
    f.slotW = world.w;
    f.slotH = world.h;
    f.x = world.x;
    f.y = world.y;
    // Minus the cell every panel gives up at its right and bottom edge, so
    // two chips never draw their border along the same line.
    f.w = Math.max(0, world.w - PANEL_GAP_CELLS * CELL);
    f.h = Math.max(0, world.h - PANEL_GAP_CELLS * CELL);
    f.fits = true;
    f.usable = true;
    f.holdsAll = true;
    if (cy >= fitRows) {
      f.w = 0;
      f.h = 0;
      f.usable = false;
      block.hidden++;
    }
  }
}

function placeFile(f: FileNode, slot: IntRect): void {
  // Give up a cell at the right and bottom, the same way directories do.
  const own: IntRect = {
    x: slot.x,
    y: slot.y,
    w: Math.max(1, slot.w - PANEL_GAP_CELLS),
    h: Math.max(1, slot.h - PANEL_GAP_CELLS),
  };
  // A slot wider than any shape the panel can take is trimmed rather than
  // filled, and the cells at its right stay empty.
  //
  // The rule everywhere else is that the panel *is* the slot, because that is
  // what makes every edge in the layout line up. This is the one exception,
  // and it buys something the rule cannot: a treemap's last row takes whatever
  // depth is left over, and if that leaves a flat strip, a file that may wrap
  // into at most twelve code columns cannot fill it however it is arranged.
  // Measured on 200 files of 4000 lines, one file landed in a strip of aspect
  // 4.4 against the 2.4 it could use, came out too narrow to draw with 2311
  // lines that had nowhere to go, and forty correction passes could not help
  // it: growing its area does not change the shape of a leftover. Trimming
  // costs a fraction of a percent of fill and keeps the content.
  if (own.w > own.h * f.maxAspect) {
    own.w = Math.max(1, Math.min(own.w, Math.floor(own.h * f.maxAspect)));
  }
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
    f.holdsAll = true;
    return;
  }

  if (f.media) {
    // The panel *is* the picture's shape: the largest box of that proportion
    // that fits the slot, at the slot's top left so edges still line up. A
    // panel stretched to the slot would show a 16:9 render as a square with
    // two grey bands, which is the one thing a picture panel must not do.
    // What the slot has left over stays empty, and the fitting pass below
    // makes up for it by asking for more area.
    const want = mediaWant(f.media);
    const a = want.w / Math.max(1, want.h);
    // Never much larger than it asked for, however large the slot is. A
    // picture has a size it is worth, and a slot that came out generous is
    // not a reason to draw a diagram across a quarter of the canvas.
    //
    // Unless the slot already has the picture's own shape, which is what the
    // row layout hands out: there the size was decided by how many pictures
    // share the row and how wide the directory is, and refusing to fill it
    // leaves exactly the gaps the rows were there to close.
    const slotAspect = h > 0 ? w / h : a;
    const shaped = Math.abs(Math.log2(slotAspect / a)) < 0.15;
    const cap = shaped ? Infinity : MEDIA_OVERSHOOT;
    const boxW = Math.min(w, h * a, want.w * cap);
    const boxH = Math.min(h, w / a, want.h * cap);
    f.geom = { ...want, w: boxW, h: boxH };
    f.w = boxW;
    f.h = boxH;
    // `fits` is the question the fitting pass acts on, and for a picture it is
    // whether the panel came out as large as the picture asked for. A file
    // with no lines fits every slot trivially, which is why 47 images ended up
    // with a quarter of a percent of the canvas between them while every text
    // panel grew around them.
    f.fits = boxW * boxH >= want.w * want.h * MEDIA_FIT_SLACK;
    f.usable = boxW > 0 && boxH > 0;
    f.holdsAll = true;
    return;
  }

  // The panel is the slot. Everything about its text layout is derived from
  // the rectangle it was given, which is what makes the edges align.
  const fit = fillSlot(f.lineCols, f.clipCols, w, h, f.fullCols);
  f.geom = fit;
  f.w = w;
  f.h = h;
  f.fits = fit.ok;
  f.crowded = fit.crowded;
  f.narrow = fit.narrow;
  f.usable = fit.usable;
  f.holdsAll = fit.holdsAll;
}


/**
 * Lay a directory of pictures out as justified rows, the way a gallery does.
 *
 * A squarified treemap divides by area and leaves the shape to chance, which
 * is right for panels of text: they can be any proportion and still hold
 * their lines. A picture cannot. Its panel has to keep the picture's own
 * proportion, so whatever the slot's shape was, the panel sits inside it with
 * space on all sides. Measured on a directory of 41 plots: the pictures
 * covered 39 percent of the box they were given.
 *
 * Rows fix that, because a row fixes one dimension. Every picture in a row is
 * drawn at the same height and keeps its own width, the row is then scaled so
 * it spans the box exactly, and nothing is left over horizontally. The height
 * to aim for comes from the area: at `sqrt(area / sum of aspects)` the rows
 * come out roughly as tall as the box can take.
 *
 * Whole cells throughout, since the treemap's invariants are about cells: no
 * gaps, no overlaps, nothing off the grid. The last cell of a row and the last
 * row of the box take the rounding.
 */
function layoutPictureRows(
  items: FileNode[],
  rect: IntRect,
  assign: (item: FileNode, r: IntRect) => void,
): void {
  const aspects = items.map((f) => {
    const want = mediaWant(f.media!);
    return Math.max(0.1, Math.min(10, want.w / Math.max(1, want.h)));
  });

  /** Break into rows at a target height, and say how tall that comes out. */
  const rowsAt = (target: number) => {
    const rows: { from: number; to: number; aspect: number }[] = [];
    let from = 0;
    let aspect = 0;
    for (let i = 0; i < items.length; i++) {
      const next = aspect + aspects[i];
      if (aspect > 0 && next * target > rect.w) {
        rows.push({ from, to: i, aspect });
        from = i;
        aspect = aspects[i];
      } else {
        aspect = next;
      }
    }
    if (from < items.length) rows.push({ from, to: items.length, aspect });
    // A justified row is as tall as spanning the box makes it, except the
    // last, which keeps the target rather than stretching two pictures across
    // the whole width.
    const heights = rows.map((r, i) =>
      i === rows.length - 1 && rows.length > 1
        ? Math.min(target, rect.w / Math.max(0.01, r.aspect))
        : rect.w / Math.max(0.01, r.aspect),
    );
    return { rows, heights, total: heights.reduce((s, h) => s + h, 0) };
  };

  // The target height that makes the rows add up to the box. Bisected rather
  // than scaled afterwards: scaling the heights alone changes every picture's
  // proportion, which is the one thing a picture panel may not do, and it was
  // what left a row of logos 126 tall inside cells 578 wide.
  let lo = 1;
  let hi = Math.max(2, rect.h);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (rowsAt(mid).total > rect.h) hi = mid;
    else lo = mid;
  }
  const { rows, heights } = rowsAt(lo);

  let y = rect.y;
  rows.forEach((row, ri) => {
    const last = ri === rows.length - 1;
    const h = Math.max(1, last ? rect.y + rect.h - y : Math.round(heights[ri]));
    let x = rect.x;
    for (let i = row.from; i < row.to; i++) {
      const lastInRow = i === row.to - 1;
      const w = Math.max(
        1,
        lastInRow ? rect.x + rect.w - x : Math.round((aspects[i] / row.aspect) * rect.w),
      );
      assign(items[i], { x, y, w: Math.max(1, Math.min(w, rect.x + rect.w - x)), h });
      x += w;
      if (x >= rect.x + rect.w) break;
    }
    y += h;
    if (y >= rect.y + rect.h) return;
  });
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

  // A directory of nothing but pictures is laid out as rows rather than as a
  // treemap; see `layoutPictureRows`.
  const pictures = dir.children.every((c) => c.kind === 'file' && c.media);
  if (pictures && dir.children.length > 1) {
    layoutPictureRows(dir.children as FileNode[], inner, placeFile);
    return;
  }

  layoutTreemap(dir.children, inner, (child, childSlot) => {
    if (child.kind === 'file') placeFile(child, childSlot);
    else if (child.kind === 'stubs') placeStubs(child, childSlot);
    else placeDir(child, childSlot);
  });
}

function collect(
  dir: DirNode, files: FileNode[], dirs: DirNode[], blocks: StubBlock[],
): void {
  dirs.push(dir);
  for (const c of dir.children) {
    if (c.kind === 'file') files.push(c);
    else if (c.kind === 'stubs') {
      blocks.push(c);
      files.push(...c.children);
    } else collect(c, files, dirs, blocks);
  }
}

/** How many times to re-run the subdivision with corrected areas. */
/**
 * Cap on the correction loop. It stops as soon as nothing misfits, so this is
 * a safety limit rather than a cost.
 *
 * Raised twice: wrapping made the first area estimate further off, since a
 * wrapped panel is taller than its line count suggests, and files compete for
 * the same slots so a correction to one disturbs its siblings. The worst case
 * in scripts/layout-check.mjs, 800 files of twelve lines across 87
 * directories, settles on pass 32 in 8 milliseconds; a realistic repository
 * takes three to thirteen.
 */
const FIT_PASSES = 40;

/**
 * How far a file's current slot aspect is taken at face value when it asks for
 * more area, as a factor either side of square.
 *
 * Three, because that is about the worst aspect a squarified treemap hands out
 * for a slot a panel can still use, so anything beyond it is a sliver the next
 * pass will not repeat.
 */
const ASPECT_TRUST = 3;

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
/**
 * Lay out once, then correct.
 *
 * Known weakness, measured rather than suspected: the root extent is derived
 * from the *corrected* total area, so which files happened to need a
 * correction decides how big the whole canvas is. Adding five lines to one
 * file can change that, the root moves by about a percent, every integer
 * split lands differently, and 95 percent of panels change place. It is not
 * the common case: the median five line edit moves nothing at all, and
 * scripts/stability-check.mjs reports both numbers.
 *
 * Fixing the root on the first pass, from the uncorrected areas, was tried and
 * does not work. The first estimate is badly wrong for files whose natural
 * shape cannot match their slot, and the loop has to be able to grow the
 * canvas to accommodate them: with the root fixed and headroom swept from 1.0
 * to 1.25, a repository of 200 files of 4000 lines left 95 to 104 panels
 * unusable and 145 overflowing, and 800 files of twelve lines fell to 81
 * percent fill. The amplification is in the integer treemap, where a one
 * percent change to a parent rectangle flips a row boundary, so that is where
 * a fix has to go. Tracked as issue #8.
 */
function fitPasses(
  root: DirNode, files: FileNode[], blocks: StubBlock[], aspect: number,
): number {
  let remaining = 0;
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const area = computeAreas(root);
    const w = Math.sqrt(area * aspect);
    placeDir(root, { x: 0, y: 0, w: cells(w), h: cells(area / w) });

    remaining = 0;
    // A block that could not fit all its chips asks for the area they need at
    // the shape it was given. Same correction as a panel gets, for the same
    // reason: the shape it will be handed is not known when the weight is set.
    for (const b of blocks) {
      if (b.hidden === 0) continue;
      remaining++;
      const chip = chipCells();
      const raw = b.w / Math.max(1, b.h);
      const a = Math.min(ASPECT_TRUST, Math.max(1 / ASPECT_TRUST, raw));
      const minW = chip.w * CELL;
      const minH = chip.h * CELL;
      const grid = b.children.length * minW * minH;
      const need = Math.max(grid, (minW * minW) / a, minH * minH * a);
      b.area = Math.max(b.area, need) * 1.06;
    }
    for (const f of files) {
      if (f.stub || (f.fits && !f.crowded && !f.narrow)) continue;
      // Only the column preference is missing; handled below.
      const soft = f.fits;
      if (!soft) remaining++;
      // Ask for the smallest slot of this aspect that the panel could fill in
      // *any* of the shapes it is allowed to take.
      //
      // That is the honest question, and it is the same one `fillSlot` answers
      // in reverse. A panel is not a fixed rectangle: it may wrap its lines at
      // any column width from the narrowest readable one up to its own longest
      // line, and it may stack up to MAX_COLUMNS code columns. So the area it
      // needs is the minimum over that set, and asking for anything else is
      // asking for a shape it never insisted on.
      //
      // Two earlier versions asked for one fixed shape each, and both were
      // wrong in opposite directions. The preferred shape overshoots on width:
      // the preferred width of a file with long lines is several times what it
      // needs to be readable, and a one line JSON file with a 411 character
      // line came out with a panel of 4690 by 7350, larger than a 1661 line
      // source file. The narrowest usable shape overshoots on height: at 24
      // columns a 4000 line file is 16,000 rows tall, and asking for a slot
      // that holds that in twelve columns demanded seven times the file's own
      // area.
      //
      // The aspect is clamped, and that is not a safety margin, it is the
      // difference between a correction and a runaway. The slot a file has
      // right now is not a constraint on the slot it gets next pass: its area
      // is about to change, so the treemap will place it somewhere else. Taken
      // literally, a sliver asks for an absurd area, and `Math.max` keeps it
      // for good: the same JSON file landed in a slot 42 by 1890 and
      // extrapolated a need of 33 million from that one pass.
      if (f.media) {
        // The area the picture wants, divided by how much of a slot of this
        // shape it can actually use. A 4:1 render in a 1:1 slot uses a
        // quarter of it, so it asks for four times its own area and comes out
        // the right size in the shape it needs.
        //
        // Divided rather than extrapolated from the slot's proportion the way
        // a text panel is: taken literally, a sliver of a slot asks for an
        // absurd area and `Math.max` keeps it, which is how a flat plot once
        // demanded 3010 by 5712, larger than any source file in the project.
        // Hence the floor on the efficiency.
        const want = mediaWant(f.media);
        const a = want.w / Math.max(1, want.h);
        // Before the first placement there is no slot, and taking one that
        // does not exist as a proportion means dividing by the floor below:
        // every picture asked for ten times its area on pass one and kept it,
        // since the correction only ever grows. Which is how a 4122 by 1720
        // plot ended up in a panel of 5418 by 2279.
        const slot = f.slotH > 0 ? f.slotW / f.slotH : a;
        const efficiency = Math.max(MEDIA_MIN_EFFICIENCY, Math.min(a / slot, slot / a));
        f.area = Math.max(f.area, (want.w * want.h) / efficiency) * 1.06;
        continue;
      }
      const natural = panelGeometry(f.lineCols, f.maxCols);
      const raw = f.slotW / Math.max(1, f.slotH);
      const aspect = Math.min(ASPECT_TRUST, Math.max(1 / ASPECT_TRUST, raw));
      let need = Infinity;
      // Widths halved down to the floor rather than every step of eight: the
      // minimum is flat enough that three or four samples find it, and each
      // width costs a walk over every line of the file.
      // A narrow panel asks only for shapes whose columns are at least the
      // width it was found lacking.
      const floorCols = soft && f.narrow ? Math.max(MIN_PANEL_COLS, f.fullCols) : MIN_PANEL_COLS;
      for (let c = natural.cols; ; c = Math.max(floorCols, Math.floor(c / 16) * 8)) {
        const rows = visualRowsCached(f.lineCols, c);
        const pitch = c * metrics.charWidth + COLUMN_GUTTER;
        // A crowded panel asks for a shape that keeps it in as few columns as
        // its rows are worth, which is what it was found lacking. Anything
        // else may take as many as it needs.
        const kMax = soft ? columnsWorth(rows) : MAX_COLUMNS;
        for (let k = 1; k <= kMax; k++) {
          const w = k * pitch - COLUMN_GUTTER + 2 * metrics.panelPadX;
          const h =
            Math.ceil(rows / k) * metrics.lineHeight
            + metrics.titleHeight + 2 * metrics.panelPadY;
          const area = Math.max(w, h * aspect) * Math.max(h, w / aspect);
          if (area < need) need = area;
        }
        if (c <= floorCols) break;
      }
      if (soft) {
        // Exactly the area the preferred shape needs in a slot like this one,
        // with no nudge on top and only if it is more than the file has.
        //
        // The nudge is what a misfit needs: without it a panel whose need
        // equals its area gets the same slot back and stays unreadable. A
        // preference has no such claim. With the nudge, a panel that stayed
        // crowded for ten passes came out with 1.06^10 = 1.79 times its area,
        // which is what the median short file on pathsim had, and the short
        // files took 34 percent of the canvas for 24 percent of the lines.
        if (need > f.area * 1.01) {
          f.area = need;
          f.offered = true;
          remaining++;
        }
        continue;
      }
      f.area = Math.max(f.area, need) * 1.06;
    }
    if (remaining === 0) {
      passesUsed = pass + 1;
      break;
    }
    passesUsed = pass + 1;
  }
  return remaining;
}

/** How many subdivision passes the last layout actually needed. */
export let passesUsed = 0;

export function computeLayout(
  entries: FileEntry[],
  viewport?: { w: number; h: number },
): Layout {
  const root = buildTree(entries);
  collapseChains(root);
  sortChildren(root);

  const allFiles: FileNode[] = [];
  const allDirs: DirNode[] = [];
  const allBlocks: StubBlock[] = [];
  collect(root, allFiles, allDirs, allBlocks);
  fitPasses(root, allFiles, allBlocks, rootAspect(viewport));

  const files: FileNode[] = [];
  const dirs: DirNode[] = [];
  const blocks: StubBlock[] = [];
  collect(root, files, dirs, blocks);
  // Outermost first, so nesting reads correctly when they are drawn. Sorted
  // here rather than in the renderer, which was copying and sorting the whole
  // list on every frame to get the same order.
  dirs.sort((a, b) => a.depth - b.depth);

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
  /** Panels too short for their own wrapped content. Also has to be zero. */
  overflowing: number;
  /** Placeholders that did not fit in their block. Also has to be zero: a
   *  file the mode exists to show as present must not go missing. */
  hiddenStubs: number;
  /**
   * Panels that stand outside the directory box they belong to. Has to be
   * zero.
   *
   * Checked apart from `overlaps` because the two catch different mistakes and
   * one of them was invisible: overlaps are counted between siblings, so
   * anything that leaves its own box and lands in another directory is not a
   * pair the sibling test ever looks at. That is exactly what a grid of
   * placeholders did, and it took a separate measurement to see it.
   */
  escapes: number;
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
  /**
   * How many times larger a panel is than the file needs, at the 95th
   * percentile and at the worst panel.
   *
   * Fill says how much of the canvas is panel. This says whether a panel is
   * the size of its file, and the two can disagree: a correction loop that
   * hands a three line file ten times the area it needs raises fill, because
   * the waste is inside a panel rather than between panels. Fill did not
   * notice exactly that, and read 96 percent while a one line JSON file had
   * the second largest panel in the project.
   *
   * Against the preferred area rather than the text's own area on purpose. A
   * panel is allowed to hold wide gutters between its code columns, which is
   * what surplus slot width turns into, and that is a different question from
   * whether the slot should have been that large at all.
   *
   * A percentile rather than a mean, because a mean over a thousand files
   * hides the handful of panels anyone would notice.
   */
  bloatP95: number;
  bloatMax: number;
  /**
   * Share of the panel area short files take, over their share of the lines.
   * One means area follows size, which is what a treemap promises.
   *
   * What keeping short files in fewer columns costs, and the number that was
   * missing when that was first built. Fill cannot see it, since the extra
   * area is still panel, and a bloat percentile against each file's own
   * preferred shape cannot either, since the preferred shape is what changed.
   * The first version reported both as unchanged while short files took 34
   * percent of pathsim's canvas for 24 percent of its lines.
   */
  shortShare: number;
  /**
   * Panel area of all text files over the area they would take at their
   * preferred shapes: what the preferences for fewer columns and for columns
   * as wide as the lines together cost the canvas.
   */
  inflation: number;
  /**
   * Column breaks plus wrapped rows, per hundred lines of text: how often a
   * reader has to jump. The other side of `shortShare`.
   *
   * Wrapped rows are nearly all of it. On pathsim before any of this there
   * were 1.3 column breaks per hundred lines of short files and 23 wraps, and
   * nearly every wrap came from a column narrower than the file's own longest
   * line rather than from a line longer than any column could be.
   */
  breaks: number;
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
  let overflowing = 0;
  let hiddenStubs = 0;
  const bloat: number[] = [];
  let panelSum = 0;
  let naturalSum = 0;
  let shortArea = 0;
  let textArea = 0;
  let shortLines = 0;
  let textLines = 0;
  let jumps = 0;
  for (const f of l.files) {
    panelArea += f.w * f.h;
    aspectSum += f.w / Math.max(1, f.h);
    colsSum += f.geom.cols;
    if (!f.fits) misfits++;
    if (!f.usable && !f.stub) unusable++;
    if (!f.holdsAll) overflowing++;
    if (f.stub && !f.usable) hiddenStubs++;
    // Short files are excluded on purpose. They are offered area to stay in
    // fewer columns, which is a decision, and `shortShare` accounts for it.
    // Counting it here as well would report the decision as a fault and hide
    // a real one behind it.
    if (!f.stub) {
      const b = (f.w * f.h) / Math.max(1, panelArea_(f.lineCols, f.maxCols));
      // Files given area for a preference are left out: that area is a
      // decision, `inflation` accounts for it, and counted here it would hide
      // a correction running away behind it.
      if (f.lineCount > SMALL_FILE_LINES && !f.offered) bloat.push(b);
      if (!f.media) {
        panelSum += f.w * f.h;
        naturalSum += panelArea_(f.lineCols, f.maxCols);
      }
    }
    if (!f.stub && !f.media) {
      const a = f.w * f.h;
      textArea += a;
      textLines += f.lineCount;
      if (f.lineCount <= SMALL_FILE_LINES) {
        shortArea += a;
        shortLines += f.lineCount;
      }
      jumps += f.geom.columns - 1
        + visualRowsCached(f.lineCols, f.geom.cols) - f.lineCount;
    }
  }
  bloat.sort((a, b) => a - b);

  let overlaps = 0;
  let offGrid = 0;
  let escapes = 0;
  // Containment, per directory, over its files and over the chips of its
  // placeholder block. Linear, unlike an all-pairs overlap test, and it
  // catches anything that leaves its box whether or not a sibling is there.
  const outside = (a: { x: number; y: number; w: number; h: number }, d: DirNode) =>
    a.w > 0 && a.h > 0
    && (a.x < d.x - 0.5 || a.y < d.y - 0.5
      || a.x + a.w > d.x + d.w + 0.5 || a.y + a.h > d.y + d.h + 0.5);
  for (const d of l.dirs) {
    for (const c of d.children) {
      if (c.kind === 'stubs') {
        for (const chip of c.children) if (outside(chip, d)) escapes++;
      } else if (outside(c, d)) escapes++;
    }
  }
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
    bloatP95: bloat.length ? bloat[Math.floor(0.95 * (bloat.length - 1))] : 1,
    shortShare: shortLines > 0 && textArea > 0
      ? (shortArea / textArea) / (shortLines / textLines)
      : 1,
    breaks: (100 * jumps) / Math.max(1, textLines),
    inflation: panelSum / Math.max(1, naturalSum),
    bloatMax: bloat.length ? bloat[bloat.length - 1] : 1,
    fill: panelArea / Math.max(1, l.root.w * l.root.h),
    aspect: l.root.w / Math.max(1, l.root.h),
    misfits,
    unusable,
    overflowing,
    hiddenStubs,
    escapes,
    overlaps,
    offGrid,
    dirCount: l.dirs.length,
    meanAspect: aspectSum / Math.max(1, l.files.length),
    meanCols: colsSum / Math.max(1, l.files.length),
    worstOverlap: worst,
  };
}
