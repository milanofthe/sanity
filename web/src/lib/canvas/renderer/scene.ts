// The scene: owns the GPU resources, decides the level of detail per file and
// builds this frame's instance data.
//
// The load-bearing property is that detail and count trade off against each
// other. Zoomed out, every file is a handful of textured quads, so the frame
// cost is proportional to the file count and nothing else. Zoomed in, token
// and glyph geometry appears, but by then only a few files intersect the
// viewport and only a few hundred of their lines do, so the instance count
// stays in the tens of thousands no matter how large the repository is.

import { Camera } from '$lib/canvas/camera';
import { metrics, timing } from '$lib/metrics';
import {
  applyTo, finished, IDENTITY, same, settleIn, slideFrom, transformFor,
  type PanelAnim, type Rect as PanelRect, type Transform,
} from '$lib/canvas/anim';
import { diffLines, seams, signatures, type Seam, type Signature } from '$lib/canvas/linediff';
import { languageTint, lodWeights, spanBarHeight } from '$lib/canvas/lod';
import { familyColours, FAMILY_COUNT, familyOf, familyTints } from '$lib/canvas/language';
import { flashAt, markStep, recent } from '$lib/canvas/recency';
import { bandColour, lerp, mixToward } from '$lib/canvas/colour';
import { rgb, UiInk, type Palette } from '$lib/theme';
import { Kind, LineState, spanCol, spanKind, spanLen, type FileData } from '$lib/canvas/data/wire';
import {
  columnPitch, columnWidth, COLUMN_GUTTER, textIndent, textOriginX, textOriginY,
} from '$lib/canvas/layout/panel';
import { lineAtRow, visualRowsCached, wrapOffsets } from '$lib/canvas/layout/wrap';
import type { DirNode, FileNode, Layout } from '$lib/canvas/layout/tree';
import { BASELINE_RATIO, GlyphAtlas } from './glyphatlas';
import { HEIGHT_CLASSES, OverviewTextures, type Slot } from './codetex';
import { MediaTextures } from './mediatex';
import {
  createProgram, instanceAttribs, quadAttrib, uniforms, unitQuad,
  InstanceBuffer, type GL,
} from './gl';
import {
  glyphFS, glyphVS, overviewFS, overviewVS, rectFS, rectVS, spanFS, spanVS,
  imageVS, imageFS,
} from './shaders';

/** Supplies the actual characters of a line, only ever asked for lines that
 *  are about to be drawn as readable text. The synthetic repo and the Rust
 *  backend both sit behind this. */
export interface TextSource {
  lineText(path: string, line: number): string | null;
}

export interface SceneFile {
  node: FileNode;
  data: FileData;
  slot: Slot;
  /**
   * Screen row each source line starts on, at this panel's column width.
   *
   * Cached per file because every drawing pass walks screen rows and has to
   * map back to source lines, and recomputing a prefix sum over a 20,000 line
   * file per frame would undo the point of the level-of-detail system. Rebuilt
   * whenever the layout changes the width.
   */
  rows: Uint32Array;
  /** Recency of the last change, 1 right after an edit, decaying to 0. */
  /**
   * Seconds since this file last changed, or Infinity if it has not changed
   * while the canvas has been open.
   *
   * One clock, read two ways: a bright flash over the panel for half a second,
   * and bands on the changed lines for a few seconds. See recency.ts, for both
   * and for what the ninety second glow this replaced got wrong.
   */
  since: number;
  /** The mark strength as last drawn, quantised, so a frame is only spent
   *  when it visibly moves. */
  shownMark: number;
  /** Aggregate git state of the file, drives the panel border. */
  state: LineState;
  /** Which language family's colour this file takes at the outermost zoom. */
  family: number;
  /** Settle animation, or null once it has finished. */
  anim: PanelAnim | null;
  /** Screen rows the texture was last written for, and the column width it
   *  was written at. A relayout compares against these to decide whether the
   *  layer still holds the right picture. */
  wroteRows: number;
  wroteCols: number;
  /** Per-line signatures of the content on screen, to diff the next version
   *  against. */
  sig: Signature;
  /** A change being shown, or null. */
  change: LineChangeAnim | null;
}

/**
 * A change in progress on one file: take the old lines away, then put the new
 * ones in.
 *
 * Both halves are needed and they are in different coordinate systems. The
 * removed lines are indices into the version on screen, so they are drawn
 * while that version is still up. The added lines are indices into the version
 * that replaces it, so the content is swapped when the first phase ends and
 * the second phase draws against the new rows.
 */
interface LineChangeAnim {
  phase: 'remove' | 'add';
  /** Seconds into the current phase. */
  t: number;
  /** Line indices in the version being replaced. */
  removedRows: number[];
  /** Line indices in the version replacing it. */
  addedRows: number[];
  /** Where a removal left a gap in the new version, with the edge of the line
   *  it sits at, so a deletion leaves a trace instead of simply vanishing. */
  gaps: Seam[];
  /** The new payload, held until the removal has played. */
  pending: FileData | null;
  /** Set when the next version should also warm the panel: a write, not a
   *  baseline moving. */
  warm: boolean;
}



export interface FrameStats {
  visibleFiles: number;
  overviewQuads: number;
  spanQuads: number;
  glyphQuads: number;
  rectQuads: number;
  pxPerLine: number;
  cpuMs: number;
}

const RECT_STRIDE = 12;
const OVERVIEW_STRIDE = 11;
const SPAN_STRIDE = 6;
const GLYPH_STRIDE = 6;

/**
 * The single hairline used for every separation inside a panel: its border,
 * the rule under its header, and the rules between its code columns.
 *
 * One device pixel at full strength, whatever the zoom. Defined once because
 * these three were drawn from three places with three different weights, and a
 * border at full opacity next to a separator at 0.85 reads as two kinds of
 * line for no reason: a panel's edge and the divisions inside it are the same
 * kind of statement and should look it.
 */
const HAIRLINE_PX = 1;
/**
 * How far a changed line's band steps away from the panel's own brightness,
 * towards the change colour's.
 *
 * A luminance step rather than a translucent wash over the text, and rather
 * than a plain mix. A wash at any useful strength turned light code on a dark
 * panel into light code on a light band, because `--added` is near white in
 * the sanity theme. A plain mix has the same problem. Stepping the luminance
 * keeps the contrast between the code and what it sits on bounded whatever the
 * palette says, and works on a light theme without a second rule; see
 * `bandColour`.
 *
 * `BAND` is the standing mark on a line that differs from the baseline, kept
 * low because the code is what should be read. `CHANGE` is the strength at the
 * start of a change, which settles back to `BAND`.
 */
const BAND_MIX = 0.12;
const CHANGE_MIX = 0.4;

/**
 * How thick the crack marking a removal is: at least this many CSS pixels,
 * and at most this fraction of a line.
 *
 * Both ends matter. It has to hold together at the zoom where the gutter marks
 * first come up, which is two or three pixels a line, and it must not grow
 * into something that reads as a line of its own when the text is large, since
 * what it stands for is precisely the absence of lines.
 */
const GAP_PX = 2;
const GAP_OF_LINE = 0.16;

/**
 * How much of its brightness a panel keeps while a search passes it by.
 *
 * Far enough down that the matches read as the only thing on the canvas, not
 * so far that the project's shape disappears: the point of searching on a map
 * is still the map.
 */
const SEARCH_DIM = 0.22;

/** Strength of the band on a line a search found, and on the one the camera
 *  is on. Both above the standing change band, since a query is a question
 *  being asked right now. */
const HIT_MIX = 0.22;
const HIT_MIX_CURRENT = 0.55;

/**
 * How far a panel's background is washed towards the recency colour at the
 * peak of its flash.
 *
 * Strong, unlike the standing tint this replaced, because it is over in half a
 * second: what it has to do is catch the eye across a canvas of a thousand
 * panels, and then get out of the way.
 */
const FLASH_WASH = 0.55;

/** On-screen floor for a stub panel, in CSS pixels. */
/** CSS pixels of panel width below which a picture is not fetched at all.
 *
 *  Small, because a thumbnail is cheap: 24 pixels still shows the colour and
 *  the rough shape of a plot, which is worth having, and the panels this rules
 *  out are the ones where a picture would be two pixels of mush. The rule
 *  earns its keep on the projects where a directory holds hundreds of
 *  renders. */
const MEDIA_MIN_PX = 24;

/**
 * How much of a line box a token bar is worth, as ink.
 *
 * A bar stands in for a word, and a word is mostly background: rasterising
 * the 86 characters code is made of at the atlas size puts the ink at 15.2
 * percent of a character cell, which is 21.3 percent of a line box. So the
 * bar's colour is the average of the glyph and what is behind it, and this is
 * the weight.
 *
 * It is not that 21.3 percent, though, and the difference is worth stating:
 * the overview texture the bars take over from is rasterised with its own
 * saturation weighting and comes out far stronger than the ink alone. Averaged
 * at the honest 0.21 the panel loses a third of its luminance the moment the
 * bars arrive. Measured across the hand-over, as spread in mean luminance:
 *
 *   0.21   18.8, the bars are visibly weaker than both neighbours
 *   0.30   16.0
 *   0.42   12.3
 *   0.55    8.8
 *   0.68    6.7, flattest, and still an average rather than the flat token
 *          colour a bar used to be drawn in
 */
const BAR_INK = 0.68;

const STUB_MIN_PX = 1.5;

/**
 * Border width of a top-level directory, in device pixels. Each level in loses
 * one, down to `DIR_BORDER_MIN_PX`.
 *
 * Heavier than the hairline that panels use, and deliberately so: a region
 * boundary encloses many panels and has to be readable as the stronger
 * statement of the two. At four dropping to one, the inner levels were the
 * same weight as the panels inside them and the nesting disappeared.
 */
const DIR_BORDER_PX = 6;
const DIR_BORDER_MIN_PX = 2;

/**
 * Line count for a header, short enough to fit one.
 *
 * Thousands are abbreviated because the exact figure is not what the header is
 * for: a glance should say whether a file is small, large or enormous, and four
 * characters of panel width is a fair price for that. The status bar carries
 * the exact totals.
 */
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * A stable palette index per directory path.
 *
 * Hashed rather than assigned in tree order so a directory keeps its colour
 * when siblings are added or removed. The golden-ratio step spreads adjacent
 * hash values apart, which matters because sibling directories often share a
 * long prefix.
 */
function dirColourIndex(path: string, count: number): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const t = (((h >>> 0) / 4294967296) * 0.6180339887) % 1;
  return Math.min(count - 1, Math.floor(t * count));
}

/**
 * Blend `base` towards `target` by `amount`, keeping base's luminance.
 *
 * Both colours come from the theme, so the result cannot leave the theme's
 * range. Matching the luminance by scaling the target's channels only works
 * when the target is brighter; where it is darker the blend is lifted towards
 * white instead, because scaling up clips and a clipped channel is how the
 * light themes grew a band of fluorescent magenta.
 */
/**
 * A file's change state as one value: the first line state that is not
 * unchanged, or unchanged if there is none.
 *
 * A file usually has one kind of change in it, and where the changes are is
 * the gutter's job; this is only for the panel-level signal.
 */
function aggregateState(data: FileData): LineState {
  for (let i = 0; i < data.lineState.length; i++) {
    const st = data.lineState[i];
    if (st !== LineState.Unchanged) return st as LineState;
  }
  return LineState.Unchanged;
}



export class Scene {
  private gl: GL;
  private quad: WebGLBuffer;

  private progRect: WebGLProgram;
  private progOverview: WebGLProgram;
  private progImage: WebGLProgram;
  /** Pictures on the GPU, at the resolution the zoom asks for. Absent until a
   *  source that can hand over image bytes is opened. */
  media: MediaTextures | null = null;
  /** Device pixel ratio of the frame being drawn, for asking the picture
   *  cache for a resolution in real pixels. */
  private dpr = 1;
  /** Pictures placed this frame, drawn after the panels so they sit on top of
   *  their own background. */
  private imageDraws: { tex: WebGLTexture; x: number; y: number; w: number; h: number; fade: number }[] = [];
  /** Where the camera was in the previous frame, to tell a moving view from a
   *  still one; see the call to `media.tick`. */
  private camWas = { x: 0, y: 0, zoom: 0 };
  /** Set from that, and read by the glyph pass: an exact atlas is worth
   *  rasterising for a view somebody is looking at, not for one being flown
   *  through. */
  private cameraStill = false;
  private progSpan: WebGLProgram;
  private progGlyph: WebGLProgram;
  private uRect: Record<string, WebGLUniformLocation | null>;
  private uOverview: Record<string, WebGLUniformLocation | null>;
  private uImage: Record<string, WebGLUniformLocation | null>;
  private uSpan: Record<string, WebGLUniformLocation | null>;
  private uGlyph: Record<string, WebGLUniformLocation | null>;

  private bgRects: InstanceBuffer;
  private fgRects: InstanceBuffer;
  private overviewByChunk = new Map<string, InstanceBuffer>();
  private spans: InstanceBuffer;
  private glyphs: InstanceBuffer;

  textures: OverviewTextures;
  atlas: GlyphAtlas;

  private view = new Float32Array(9);
  private kindFlat: Float32Array;
  /**
   * Token colours for the span bars, between the overview's damped palette and
   * the full one.
   *
   * A bar stands for a run of characters and the background between them, so
   * its colour is the average of the two rather than the ink's own colour.
   * Without that the first hand-over is a step: the texture paints a line in
   * the damped `--ov-*` colours and the bars painted the same line in full
   * token colours, which measured 0.33 mean luminance against the texture's
   * 0.14 and the real glyphs' 0.18, on the same panel at the same zoom. The
   * canvas brightened when the bars arrived, or darkened on a light theme.
   *
   * Rebuilt per frame from the glyph weight, so a bar starts out matching the
   * texture it replaces and ends up matching the text that replaces it. Twelve
   * kinds of three floats: the cost is not worth caching.
   */
  private spanFlat: Float32Array;
  private ovFlat: Float32Array;

  files = new Map<string, SceneFile>();
  /**
   * The same files as an array, for iterating.
   *
   * The map is for looking one up by path, which the watcher and the hover do.
   * Every frame walks the whole set several times, and iterating a Map costs
   * noticeably more than an array: measured at 0.40 milliseconds a frame for a
   * view with 34 panels in it out of 989, almost all of it the walking rather
   * than the drawing.
   */
  private fileList: SceneFile[] = [];
  /** Whether anything was moving on the last frame drawn; see `moving`. */
  private wasMoving = false;
  /** Path whose header the pointer is over, for the hover highlight. */
  hoveredPath: string | null = null;

  /** Sharpen the overview texture's vertical interpolation. Off only for the
   *  measurement that shows what it is worth. */
  sharpen = true;
  /** Rasterise the glyph atlas at the exact size the zoom asks for once the
   *  camera is still. Off only for the measurement that shows what it is
   *  worth: with it off, glyphs come from the nearest fixed level and are
   *  scaled, which is what text-check compares against. */
  exactGlyphAtlas = true;
  /** Colour the overview by language family. Off by default: what the canvas
   *  is for is the shape of a project and what changed in it, and a second
   *  colour scheme on top of the syntax colours is a third thing competing for
   *  the same pixels. Switched on from the View menu, and by lang-check, which
   *  measures what it separates. */
  tintLanguages = false;
  /** How much of the overview's colour comes from the language rather than the
   *  tokens on this frame. Written by `render` from the zoom. */
  private langTint = 0;
  /** One tint vector per language family, flattened for the uniform. */
  private familyFlat = new Float32Array(FAMILY_COUNT * 3);

  /**
   * Paths matching the search, or null when nothing is being searched.
   *
   * Everything else is drawn dimmed rather than hidden. Hiding would answer
   * "where is this file" by removing the thing that makes the answer legible:
   * the shape of the project around it. Dimming keeps the map and marks the
   * destination on it.
   */
  private matched: Set<string> | null = null;
  /** Directories holding a match, so a lit panel is not inside a dark box. */
  private matchedDirs = new Set<string>();
  /** Scratch transform for a dimmed panel, so dimming allocates nothing. */
  private dimTf: Transform = { scale: 1, bx: 0, by: 0, alpha: 1 };

  /**
   * Content hits per path, as flat line and column pairs.
   *
   * Separate from the matching path set because they answer different
   * questions and are drawn differently: a path match lights a whole panel,
   * a content hit marks the lines inside it.
   */
  private hits = new Map<string, number[]>();
  /** The hit the camera is on, so it can be drawn as the current one. */
  private current: { path: string; line: number } | null = null;

  setHits(hits: Map<string, number[]>, current: { path: string; line: number } | null): void {
    this.hits = hits;
    this.current = current;
  }

  /**
   * World rectangle of one source line, for the camera to fly to.
   *
   * Follows the same wrap offsets and column geometry the text pass draws
   * from, rather than a second calculation of where a line is: those two
   * drifting apart is how a search flies to the wrong place in a panel that
   * wraps into eleven columns.
   */
  lineRect(path: string, line: number): [number, number, number, number] | null {
    const f = this.files.get(path);
    if (!f || f.node.stub) return null;
    const g = f.node.geom;
    const row = f.rows[Math.min(line, Math.max(0, f.data.lineCount - 1))];
    const column = Math.min(g.columns - 1, Math.floor(row / g.linesPerColumn));
    const x = f.node.x + textOriginX + column * columnPitch(g);
    const y =
      f.node.y + textOriginY + (row - column * g.linesPerColumn) * metrics.lineHeight;
    return [x, y, columnWidth(g), metrics.lineHeight];
  }

  /** Take a set of matching paths, or null to stop searching. */
  setSearch(paths: Set<string> | null): void {
    this.matched = paths;
    this.matchedDirs.clear();
    if (!paths) return;
    // Every directory on the way to a match, so the boxes around it stay lit.
    for (const path of paths) {
      let cut = path.indexOf('/');
      while (cut > 0) {
        this.matchedDirs.add(path.slice(0, cut));
        cut = path.indexOf('/', cut + 1);
      }
    }
    this.matchedDirs.add('');
  }

  /** Whether a search is running. */
  get searching(): boolean {
    return this.matched !== null;
  }

  /** Dim what the search did not match, by folding it into the transform the
   *  settle animation already applies. */
  private dim(): void {
    const tf = this.tf;
    this.dimTf.scale = tf.scale;
    this.dimTf.bx = tf.bx;
    this.dimTf.by = tf.by;
    this.dimTf.alpha = tf.alpha * SEARCH_DIM;
    this.tf = this.dimTf;
  }

  /** Transform in force while the current panel's geometry is pushed. */
  private tf: Transform = IDENTITY;
  /** Longest distance from the layout centre, for the appearance stagger. */
  private spread = 1;
  /**
   * Settle animations for the directory regions, by path.
   *
   * Kept apart from the files because a directory has no scene state of its
   * own: it is read straight out of the layout every frame. Without these the
   * frames jump to their new places while the panels inside them are still
   * sliding, which reads as the regions tearing loose from their contents and
   * was the largest part of what a relayout looked like.
   */
  private dirAnims = new Map<string, PanelAnim>();
  /** True while at least one panel is still animating, so the frame loop can
   *  tell whether the picture is still changing on its own. */
  animating = false;
  /** True while a change is still playing out on some file. */
  changing = false;
  stats: FrameStats = {
    visibleFiles: 0, overviewQuads: 0, spanQuads: 0, glyphQuads: 0,
    rectQuads: 0, pxPerLine: 0, cpuMs: 0,
  };

  constructor(gl: GL, public layout: Layout, private text: TextSource, private pal: Palette) {
    this.gl = gl;
    this.quad = unitQuad(gl);
    this.textures = new OverviewTextures(gl, pal.overview);
    this.atlas = new GlyphAtlas(gl);
    this.kindFlat = new Float32Array(pal.token.length * 3);
    this.spanFlat = new Float32Array(pal.token.length * 3);
    this.ovFlat = new Float32Array(pal.token.length * 3);

    this.progRect = createProgram(gl, rectVS, rectFS, 'rect');
    this.progOverview = createProgram(gl, overviewVS, overviewFS, 'overview');
    this.progImage = createProgram(gl, imageVS, imageFS, 'image');
    this.progSpan = createProgram(gl, spanVS, spanFS, 'span');
    this.progGlyph = createProgram(gl, glyphVS, glyphFS, 'glyph');
    this.uRect = uniforms(gl, this.progRect, ['uView', 'uViewport']);
    this.uOverview = uniforms(gl, this.progOverview, [
      'uView', 'uTex', 'uTexRows', 'uSharp', 'uLangTint', 'uFamily[0]',
    ]);
    this.uImage = uniforms(gl, this.progImage, ['uView', 'uTex', 'uRect', 'uFade']);
    this.uSpan = uniforms(gl, this.progSpan, ['uView', 'uKind[0]']);
    this.uGlyph = uniforms(gl, this.progGlyph, [
      'uView', 'uKind[0]', 'uAtlas', 'uCell', 'uGridCols', 'uViewport', 'uBoxPx',
      'uEmWorld',
    ]);

    this.bgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.fgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.spans = new InstanceBuffer(gl, SPAN_STRIDE, 65536);
    this.glyphs = new InstanceBuffer(gl, GLYPH_STRIDE, 65536);

    this.writeKindFlat();
    this.measureSpread();

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Take a new layout without rebuilding the scene.
   *
   * Rebuilding is what `open` used to do on every relayout, and it costs what
   * a first load costs: measured on a 989 file project, 1813 ms of which 1380
   * was re-uploading textures that had not changed, with the canvas
   * progressively refilling from empty the whole time. The reorder animation
   * was invisible underneath it.
   *
   * What actually has to change depends on the edit, and the two regimes are
   * far apart. Measured on the same project, adding five lines to one file:
   *
   * | case | panels keeping their rect | keeping their column geometry |
   * |---|---|---|
   * | the common edit | 100% | 100% |
   * | one that reshuffles | 0% | 17.6% |
   *
   * So the common edit needs nothing at all, and even a reshuffle keeps a
   * sixth of the textures. Returns the paths whose texture content has to be
   * written again, for the caller to spread over frames; everything else is
   * done by the time this returns.
   */
  relayout(layout: Layout): string[] {
    const wasDir = new Map(
      this.layout.dirs.map((d) => [d.path, { x: d.x, y: d.y, w: d.w, h: d.h }]),
    );
    this.layout = layout;
    this.measureSpread();

    // The regions move with their contents.
    this.dirAnims.clear();
    for (const d of layout.dirs) {
      const was = wasDir.get(d.path);
      if (was && !same(was, d)) this.dirAnims.set(d.path, slideFrom(was, d));
    }

    const byPath = new Map(layout.files.map((n) => [n.path, n]));

    // Files that are gone give their texture layer back, or a watched project
    // would leak one per save.
    let gone = false;
    for (const [path, f] of [...this.files]) {
      if (byPath.has(path)) continue;
      if (!f.node.stub) this.textures.release(f.slot);
      this.files.delete(path);
      gone = true;
    }
    // Rebuilt once rather than filtered per removal, which would be quadratic
    // on a relayout that drops a third of the files.
    if (gone) this.fileList = [...this.files.values()];

    const rewrite: string[] = [];
    for (const node of layout.files) {
      const f = this.files.get(node.path);
      if (!f) {
        // New file. The caller adds it, which is where its texture comes from.
        rewrite.push(node.path);
        continue;
      }

      const was: PanelRect = { x: f.node.x, y: f.node.y, w: f.node.w, h: f.node.h };
      const before = f.node.geom;
      const moved = !same(was, node);
      f.anim = moved ? slideFrom(was, node) : null;

      if (node.stub) {
        f.node = node;
        continue;
      }

      // The wrap offsets follow the new column width immediately, even when
      // the texture write is deferred: the draw passes walk screen rows, so
      // leaving them disagreeing with the geometry would stretch the overview
      // for however many frames the write takes to arrive.
      const colsChanged = before.cols !== node.geom.cols;
      if (colsChanged) f.rows = wrapOffsets(f.data.lineCols, node.geom.cols);
      const rows = f.rows[f.data.lineCount];

      // Only noted, not acted on: the layer is swapped in `ensure`, at the
      // moment the new content is written. Releasing it here would blank the
      // panel for however many frames the rewrite takes to arrive, which on a
      // reshuffling edit is most of a second and most of the panels.
      if (rows !== f.wroteRows || node.geom.cols !== f.wroteCols) {
        rewrite.push(node.path);
      }

      f.node = node;
      node.layer = f.slot.layer;
    }
    return rewrite;
  }

  /** Put a file in both the map and the iteration array. */
  private add(path: string, file: SceneFile): void {
    const existing = this.files.get(path);
    this.files.set(path, file);
    if (existing) {
      const i = this.fileList.indexOf(existing);
      if (i >= 0) this.fileList[i] = file;
      else this.fileList.push(file);
    } else {
      this.fileList.push(file);
    }
  }

  /** Half the layout's diagonal, which the appearance stagger is spread over. */
  private measureSpread(): void {
    const [x0, y0, x1, y1] = this.layout.bounds;
    this.spread = Math.max(1, Math.hypot(x1 - x0, y1 - y0) / 2);
  }

  /**
   * How a panel that was not on screen before arrives: it settles into its
   * slot, delayed by its distance from the centre so a project blooms outward
   * rather than appearing as one block.
   *
   * A panel that was already here is handled by `relayout`, which knows where
   * it was and slides it from there.
   */
  private animFor(node: FileNode): PanelAnim {
    const [bx0, by0, bx1, by1] = this.layout.bounds;
    const cx = (bx0 + bx1) / 2;
    const cy = (by0 + by1) / 2;
    const dist = Math.hypot(node.x + node.w / 2 - cx, node.y + node.h / 2 - cy);
    return settleIn(node, Math.min(1, dist / this.spread) * timing.appearStagger);
  }

  private writeKindFlat(): void {
    this.pal.token.forEach((hex, i) => {
      const [r, g, b] = rgb(hex);
      this.kindFlat[i * 3] = r;
      this.kindFlat[i * 3 + 1] = g;
      this.kindFlat[i * 3 + 2] = b;
    });
    // One tint vector per language family, from the palette's data hues.
    // Worked out here rather than per frame: it changes with the theme and
    // nothing else.
    this.familyFlat = familyTints(
      familyColours(this.pal.data, this.pal.surface.reducedInk),
    );
    // The damped palette the overview textures are rasterised with. Held
    // separately so the bars can start from it.
    this.pal.overview.forEach((hex, i) => {
      const [r, g, b] = rgb(hex);
      this.ovFlat[i * 3] = r;
      this.ovFlat[i * 3 + 1] = g;
      this.ovFlat[i * 3 + 2] = b;
    });
  }

  /**
   * Bar colours for this frame.
   *
   * A bar stands in for a word, and a word is mostly background: the ink of
   * the rasterised font covers 15.2 percent of a character cell, which is
   * 21.3 percent of a line box. Drawn in the token's own colour a bar is
   * therefore a solid block where the text it replaces is a few strokes, and
   * that is the step you see at the hand-over, in both directions. So the
   * colour is the average of the glyph and what is behind it, weighted by how
   * much of the line the bar covers: a shorter bar has to be stronger to carry
   * the same ink.
   *
   * From there it moves to the full token colour as the glyphs come up, since
   * by then the glyphs are drawing the ink and the bars are only supporting
   * them.
   */
  private writeSpanFlat(toGlyphs: number, barFill: number): void {
    const k = Math.min(1, Math.max(0, toGlyphs));
    const mix = Math.min(1, BAR_INK / Math.max(0.05, barFill));
    const [br, bg, bb] = rgb(this.pal.surface.panelBg);
    for (let i = 0; i < this.spanFlat.length; i += 3) {
      const back = [br, bg, bb];
      for (let c = 0; c < 3; c++) {
        // The bar as the average of glyph and background.
        const averaged = back[c] + (this.kindFlat[i + c] - back[c]) * mix;
        this.spanFlat[i + c] = averaged + (this.kindFlat[i + c] - averaged) * k;
      }
    }
  }

  /**
   * Adopt a new theme. Token and surface colours are uniforms and change for
   * free, but the overview colours are baked into the texture layers, so every
   * file has to be re-rasterised. At a few hundred files that is a visible
   * blink, which is why it happens on an explicit theme switch and nowhere
   * else.
   */
  setPalette(pal: Palette): void {
    this.pal = pal;
    this.kindFlat = new Float32Array(pal.token.length * 3);
    this.spanFlat = new Float32Array(pal.token.length * 3);
    this.ovFlat = new Float32Array(pal.token.length * 3);
    this.writeKindFlat();
    this.textures.setColors(pal.overview);
    for (const f of this.files.values()) {
      if (f.node.stub) continue;
      this.textures.write(f.slot, f.data, f.node.geom.cols, f.rows);
    }
    this.textures.finalize();
  }

  addFile(node: FileNode, data: FileData): void {
    // Stubs draw from geometry alone, so they get no texture layer. On a repo
    // whose artefacts outweigh its source this is most of the memory saved.
    if (node.stub) {
      this.add(node.path, {
        node, data,
        slot: { classIdx: 0, chunkIdx: 0, layer: 0, texRows: 0 },
        rows: new Uint32Array(1),
        since: Infinity, shownMark: 0, state: aggregateState(data), anim: this.animFor(node),
        family: familyOf(data.langId),
        wroteRows: 0, wroteCols: 0,
        sig: signatures(data.lineCount, data.lineCols, data.spanStart, data.spans),
        change: null,
      });
      return;
    }
    const rows = wrapOffsets(data.lineCols, node.geom.cols);
    // The texture is as tall as the file is on screen, wrapped rows included,
    // so a row of the texture is a row of the panel either way.
    const slot = this.textures.allocate(rows[data.lineCount]);
    node.layer = slot.layer;
    this.textures.write(slot, data, node.geom.cols, rows);
    this.add(node.path, {
      node, data, slot, rows, since: Infinity, shownMark: 0, state: aggregateState(data),
      family: familyOf(data.langId),
      anim: this.animFor(node),
      wroteRows: rows[data.lineCount], wroteCols: node.geom.cols,
      sig: signatures(data.lineCount, data.lineCols, data.spanStart, data.spans),
      change: null,
    });
  }

  /**
   * Add a file, or rewrite one already here whose column width changed.
   *
   * The caller works through a queue of paths and does not have to know which
   * case each one is: after a relayout some are new panels and some are
   * existing panels whose texture no longer matches their geometry.
   */
  ensure(node: FileNode, data: FileData): void {
    const f = this.files.get(node.path);
    if (!f) {
      this.addFile(node, data);
      return;
    }
    f.node = node;
    f.data = data;
    f.state = aggregateState(data);
    f.family = familyOf(data.langId);
    f.sig = signatures(data.lineCount, data.lineCols, data.spanStart, data.spans);
    if (node.stub) return;
    f.rows = wrapOffsets(data.lineCols, node.geom.cols);
    const rows = f.rows[data.lineCount];
    if (!this.textures.fitsSlot(f.slot, rows)) {
      // A different height class needs a different layer. Swapped here rather
      // than when the relayout decided so, because until this point the old
      // layer is what the panel is drawing.
      this.textures.release(f.slot);
      f.slot = this.textures.allocate(rows);
    }
    f.slot.texRows = this.textures.rowsFor(f.slot, rows);
    this.textures.write(f.slot, data, node.geom.cols, f.rows);
    f.wroteRows = f.rows[data.lineCount];
    f.wroteCols = node.geom.cols;
    node.layer = f.slot.layer;
  }

  /**
   * Called when the watcher reports a file changed on disk.
   *
   * `warm` is false when the change came from the baseline moving rather than
   * from someone writing the file: a commit turns every panel cold at once,
   * and flashing two hundred of them would say the opposite of what happened.
   */
  touch(path: string, data?: FileData, warm = true): void {
    const f = this.files.get(path);
    if (!f) return;
    if (!data) {
      if (warm) {
        f.since = 0;
        f.shownMark = 1;
      }
      return;
    }

    // A change already playing is finished first, so the diff is against what
    // the file will actually be showing rather than against a version that is
    // on its way out. Two saves in quick succession are two changes, not a
    // tangle.
    if (f.change?.pending) this.applyData(f, f.change.pending);
    f.change = null;

    const next = signatures(data.lineCount, data.lineCols, data.spanStart, data.spans);
    const diff = diffLines(f.sig, next);

    // Nothing to play: identical content, or so much of it changed that
    // animating each line individually would say less than replacing the
    // panel. A checkout is the second case.
    if (diff.wholesale || (diff.removed.length === 0 && diff.added.length === 0)) {
      this.applyData(f, data);
      if (warm) {
        f.since = 0;
        f.shownMark = 1;
      }
      return;
    }

    // The new content waits until the removal has played. Until then the panel
    // keeps showing the version the removed lines belong to.
    f.change = {
      phase: 'remove',
      t: 0,
      removedRows: diff.removed,
      addedRows: diff.added,
      gaps: seams(diff, f.data.lineCount, data.lineCount),
      pending: data,
      warm,
    };
    // The glow starts now rather than when the content lands: the file was
    // written now.
    if (warm) {
      f.since = 0;
      f.shownMark = 1;
    }
  }

  /** Put a new version of a file on screen. */
  private applyData(f: SceneFile, data: FileData): void {
    f.data = data;
    f.state = aggregateState(data);
    f.sig = signatures(data.lineCount, data.lineCols, data.spanStart, data.spans);
    if (f.node.stub) return;
    f.rows = wrapOffsets(data.lineCols, f.node.geom.cols);
    this.textures.write(f.slot, data, f.node.geom.cols, f.rows);
    f.wroteRows = f.rows[data.lineCount];
    f.wroteCols = f.node.geom.cols;
  }

  /**
   * Advance a change by `dt`, swapping the content when the removal is done.
   *
   * Returns true while there is still something to draw, so the frame loop
   * knows the picture is changing on its own.
   */
  private advanceChange(f: SceneFile, dt: number): boolean {
    const ch = f.change;
    if (!ch) return false;
    ch.t += dt;
    if (ch.phase === 'remove') {
      if (ch.t < timing.changeOut) return true;
      // The old lines are gone; now the new ones arrive.
      if (ch.pending) this.applyData(f, ch.pending);
      ch.pending = null;
      ch.phase = 'add';
      ch.t = 0;
      return true;
    }
    if (ch.t >= timing.changeIn) {
      // The marks stay after the animation, so a save is still visible a
      // moment later. They fade with the panel's heat, which is what keeps the
      // canvas from filling up with everything ever touched.
      const state = f.data.lineState;
      for (const line of ch.addedRows) {
        if (line < state.length) state[line] = LineState.Added;
      }
      for (const { line, side } of ch.gaps) {
        if (line < state.length && state[line] === LineState.Unchanged) {
          state[line] = side === 'above' ? LineState.GapAbove : LineState.GapBelow;
        }
      }
      f.state = aggregateState(f.data);
      f.change = null;
      return false;
    }
    return true;
  }

  /**
   * Whether a file still fits the panel it was laid out into.
   *
   * A texture slot is allocated for a fixed number of rows, so a file that
   * grew past it would be written truncated. The caller uses this to decide
   * between an in-place update and a relayout; asking here rather than in the
   * caller keeps the row count and the slot size in one place.
   */
  fits(path: string, data: FileData): boolean {
    const f = this.files.get(path);
    if (!f) return false;
    if (f.node.stub) return true;
    const geom = f.node.geom;
    const rows = visualRowsCached(data.lineCols, geom.cols);
    return rows <= geom.columns * geom.linesPerColumn && rows <= f.slot.texRows;
  }

  /**
   * Whether anything in the scene changes the picture on its own next frame.
   *
   * Panel animations, a change playing, and heat decaying, which moves a
   * border colour a little every frame for ninety seconds. The renderer skips
   * a frame when nothing here is true and nothing outside has changed.
   *
   * Answered from the last frame drawn rather than recomputed, which would be
   * another walk over every file before every frame. One frame of over-drawing
   * when something stops is the price, and it is not visible.
   */
  moving(): boolean {
    return this.wasMoving;
  }

  /** Files that differ from the baseline, by their own drawn state. */
  /** Whether a path has a panel in this scene. */
  has(path: string): boolean {
    return this.files.has(path);
  }

  /**
   * Mark files that have just appeared: every line new, and glowing.
   *
   * A file an agent created is the most informative thing on the canvas and
   * used to be the least visible: it arrived with the same neutral border as
   * code nobody has touched in a year, because the glow is set when a change
   * is applied and a new panel has no change to apply. Marking every line as
   * added says what happened, and it fades with the heat like any other
   * change rather than standing forever.
   */
  markCreated(paths: Iterable<string>): void {
    for (const path of paths) {
      const f = this.files.get(path);
      if (!f) continue;
      f.since = 0;
      f.shownMark = 1;
      f.data.lineState.fill(LineState.Added);
      f.state = LineState.Added;
    }
  }

  changedCount(): number {
    let n = 0;
    for (const f of this.files.values()) if (f.state !== LineState.Unchanged) n++;
    return n;
  }

  /** Files still inside their change window, flash or marks. */
  recentCount(): number {
    let n = 0;
    for (const f of this.files.values()) if (recent(f.since)) n++;
    return n;
  }

  finalizeTextures(): void {
    this.textures.finalize();
  }

  private pushRect(
    b: InstanceBuffer, x: number, y: number, w: number, h: number,
    fill: number, fillA: number, border: number, borderPx: number,
  ): void {
    const o = b.alloc();
    const d = b.data;
    const tf = this.tf;
    d[o] = x * tf.scale + tf.bx;
    d[o + 1] = y * tf.scale + tf.by;
    d[o + 2] = w * tf.scale;
    d[o + 3] = h * tf.scale;
    // Unpacked in place. `rgb` returns a tuple, and two of those per
    // rectangle is several thousand arrays a frame for the collector.
    d[o + 4] = ((fill >> 16) & 0xff) / 255;
    d[o + 5] = ((fill >> 8) & 0xff) / 255;
    d[o + 6] = (fill & 0xff) / 255;
    d[o + 7] = fillA * tf.alpha;
    // A border has no alpha of its own in the instance data, so a transform
    // that fades something out has to fade the border by blending it into the
    // background instead. Without this a dimmed panel kept its bright outline,
    // and a search that dimmed nine hundred panels still showed nine hundred
    // frames at full strength: the grid, not the matches, was what you saw.
    const edge = tf.alpha < 1 ? lerp(border, this.pal.surface.bg, 1 - tf.alpha) : border;
    // The border width is in device pixels, so it is the one thing that must
    // not scale: a hairline is a hairline at every zoom, and that is what
    // keeps it from shimmering.
    d[o + 8] = ((edge >> 16) & 0xff) / 255;
    d[o + 9] = ((edge >> 8) & 0xff) / 255;
    d[o + 10] = (edge & 0xff) / 255;
    d[o + 11] = borderPx;
  }

  private drawRects(b: InstanceBuffer): void {
    if (b.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.progRect);
    gl.uniformMatrix3fv(this.uRect.uView, false, this.view);
    gl.uniform2f(this.uRect.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    b.upload();
    quadAttrib(gl, this.progRect, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    instanceAttribs(gl, this.progRect, RECT_STRIDE, [
      ['aRect', 4, 0], ['aFill', 4, 4], ['aBorder', 4, 8],
    ]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
  }

  /**
   * Advance everything that moves on its own, and say what it costs.
   *
   * Apart from `render` because the two questions are different: this one is
   * "has anything changed", which has to be asked on a clock whatever is on
   * screen, and drawing is the expensive answer to it. A glow fades over
   * ninety seconds and a frame costs 0.7 milliseconds, so asking and drawing
   * in one place meant 5400 frames for one save and an app that never parked
   * while an agent worked. Ticking is a few microseconds: one walk over the
   * files, no GL.
   *
   * `redraw` says the picture would come out different, `ticking` says
   * something is still in flight and the loop has to keep asking.
   */
  advance(dt: number): { redraw: boolean; ticking: boolean } {
    let redraw = false;
    let ticking = false;
    let changing = false;
    for (const f of this.fileList) {
      // Gated on the clock existing at all, not on it being inside the
      // window: a file whose window has passed still has marks to clear, and
      // gating on the window meant it only ever got cleared by the one tick
      // that happened to cross the boundary. Anything that set the clock
      // another way kept its marks for good.
      if (f.since !== Infinity) {
        const wasFlash = flashAt(f.since);
        f.since += dt;
        // The flash is an animation: while it lasts, every frame differs.
        if (wasFlash > 0 || flashAt(f.since) > 0) redraw = true;
        // The marks sit still and then ramp out, so they are drawn in steps
        // and cost a frame only when a step is crossed.
        const step = markStep(f.since);
        if (step !== f.shownMark) {
          f.shownMark = step;
          redraw = true;
        }
        if (recent(f.since)) {
          ticking = true;
        } else if (f.state !== LineState.Unchanged && !f.change) {
          // The window is over, so the marks go. Without this a file touched
          // an hour ago lights up its old lines the moment it is touched
          // again, as if they had just changed.
          f.data.lineState.fill(LineState.Unchanged);
          f.state = LineState.Unchanged;
          f.since = Infinity;
          redraw = true;
        }
      }
      if (f.change) {
        // A change plays out over a fraction of a second and every frame of it
        // is different, so it both ticks and redraws.
        if (this.advanceChange(f, dt)) {
          ticking = true;
          changing = true;
        }
        redraw = true;
      }
    }
    // Reported apart from the glow, which also ticks but for ninety seconds:
    // `settling` means a motion is in progress, and something waiting for the
    // canvas to come to rest must not wait for a fade.
    this.changing = changing;
    if (this.animating) {
      ticking = true;
      redraw = true;
    }
    this.wasMoving = redraw;
    return { redraw, ticking };
  }

  render(cam: Camera, dt: number): void {
    const t0 = performance.now();
    const { gl } = this;
    const pxPerLine = metrics.lineHeight * cam.zoom;

    // A partition of one across the three representations; see lod.ts for why
    // that property is worth having a module and a test for.
    const w = lodWeights(pxPerLine);
    this.langTint = this.tintLanguages ? languageTint(pxPerLine) : 0;
    const overviewFade = w.overview;
    const spanFade = w.spans;
    const glyphFade = w.glyphs;

    cam.writeMatrix(this.view);
    const [vx0, vy0, vx1, vy1] = cam.visibleRect(64);

    this.bgRects.reset();
    this.fgRects.reset();
    this.spans.reset();
    this.glyphs.reset();
    this.imageDraws.length = 0;
    // The clock eviction order is measured in, and the device ratio the
    // picture resolution is asked for in; both are per frame. Whether the
    // camera moved into this frame goes with it: picture decoding waits for
    // the view to come to rest rather than chasing a pan.
    const moving =
      cam.x !== this.camWas.x || cam.y !== this.camWas.y || cam.zoom !== this.camWas.zoom;
    this.cameraStill = !moving;
    this.camWas.x = cam.x;
    this.camWas.y = cam.y;
    this.camWas.zoom = cam.zoom;
    this.media?.tick(moving);
    this.dpr = cam.dpr;
    for (const b of this.overviewByChunk.values()) b.reset();

    let stillAnimating = false;

    // Directory boxes. Already outermost first from the layout, so there is
    // nothing to copy or sort here.
    for (const d of this.layout.dirs) {
      this.tf = IDENTITY;
      const anim = this.dirAnims.get(d.path);
      if (anim) {
        anim.t += dt;
        if (finished(anim)) this.dirAnims.delete(d.path);
        else {
          stillAnimating = true;
          this.tf = transformFor(d, anim);
        }
      }
      const drawn = this.tf === IDENTITY ? d : applyTo(this.tf, d);
      if (
        drawn.x > vx1 || drawn.y > vy1
        || drawn.x + drawn.w < vx0 || drawn.y + drawn.h < vy0
      ) {
        continue;
      }
      // A directory with nothing matching inside it recedes with its files,
      // so the lit panels are not sitting in bright boxes.
      if (this.matched && !this.matchedDirs.has(d.path)) this.dim();
      this.pushDir(d, cam.zoom);
    }
    this.tf = IDENTITY;

    let visibleFiles = 0;
    for (const f of this.fileList) {
      const n = f.node;

      // Advance the settle animation and work out the transform before
      // culling, because a panel sliding in from off screen is visible at its
      // animated position while its target is not yet in view, and the other
      // way round on the way out.
      this.tf = IDENTITY;
      if (f.anim) {
        f.anim.t += dt;
        if (finished(f.anim)) {
          f.anim = null;
        } else {
          stillAnimating = true;
          this.tf = transformFor(n, f.anim);
        }
      }

      // The rect as it will actually be drawn.
      const drawn = this.tf === IDENTITY ? n : applyTo(this.tf, n);
      if (
        drawn.x > vx1 || drawn.y > vy1
        || drawn.x + drawn.w < vx0 || drawn.y + drawn.h < vy0
      ) {
        continue;
      }
      visibleFiles++;

      const hit = this.matched?.has(n.path) ?? true;
      if (!hit) this.dim();

      // A stub is a frame and a hatch, at every zoom level. It says the file
      // is there and stops: no overview texture, no tokens, no glyphs, and no
      // area proportional to its size. That is the whole point of the mode.
      if (f.node.stub) {
        this.pushStub(f, cam.zoom);
        continue;
      }

      this.pushPanel(f);
      if (f.node.media) this.pushMedia(f, cam.zoom);
      else this.pushColumnRules(f, cam.zoom);
      this.pushHeader(f, cam.zoom, f.node.path === this.hoveredPath);
      this.pushPanelBorder(f, this.matched !== null && hit);
      if (overviewFade > 0.004) this.pushOverview(f, overviewFade);
      if (spanFade > 0.004) this.pushSpans(f, spanFade, pxPerLine, vx0, vy0, vx1, vy1);
      if (glyphFade > 0.004) {
        this.pushGlyphs(f, glyphFade, vx0, vy0, vx1, vy1);
        this.pushLineNumbers(f, glyphFade, vx0, vy0, vx1, vy1);
      }
      if (spanFade > 0.004 || glyphFade > 0.004) {
        this.pushGutter(f, cam.zoom, vy0, vy1);
        this.pushChangeBands(f, vy0, vy1);
        this.pushHits(f, vy0, vy1);
      }
    }
    this.tf = IDENTITY;
    this.animating = stillAnimating;

    // Draw.
    const [br, bg, bb] = rgb(this.pal.surface.bg);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawRects(this.bgRects);
    this.drawOverview();
    this.drawImages();
    this.writeSpanFlat(glyphFade, spanBarHeight(pxPerLine));
    this.drawSpans();
    this.drawGlyphs(pxPerLine, cam.dpr);
    this.drawRects(this.fgRects);

    let overviewQuads = 0;
    for (const b of this.overviewByChunk.values()) overviewQuads += b.count;
    this.stats = {
      visibleFiles,
      overviewQuads,
      spanQuads: this.spans.count,
      glyphQuads: this.glyphs.count,
      rectQuads: this.bgRects.count + this.fgRects.count,
      pxPerLine,
      cpuMs: performance.now() - t0,
    };
  }

  /**
   * A directory box: a tinted frame and a label, both in world space.
   *
   * Alternating two shades by depth, which is what this did first, says
   * nothing about which directory you are looking at, and at four levels deep
   * the boxes were indistinguishable. A hue derived from the path gives each
   * directory a stable identity you can navigate by, and keeping it to the
   * frame and a wash rather than a fill leaves the code itself as the only
   * saturated thing on screen.
   */
  private pushDir(d: DirNode, zoom: number): void {
    // One of the theme's own hues, chosen by path hash, so a directory's
    // frame is a colour the scheme actually contains.
    const hue = this.pal.data[dirColourIndex(d.path, this.pal.data.length)];
    // Tint strength is a theme token: a monochrome palette sets it to zero and
    // gets depth from the wash alone, which is what it wants.
    const wash = this.pal.dirWash + 0.04 * (d.depth % 3);
    const tint = mixToward(this.pal.surface.dirBg, hue, wash);
    const edge = mixToward(this.pal.surface.borderStrong, hue, this.pal.dirTint);

    // Thicker the further out, so the nesting is readable at a glance. A
    // uniform hairline made a four-level tree look flat, and a border in world
    // units would vanish when zoomed out, so this is in device pixels and
    // clamped to at least one.
    const weight = Math.max(DIR_BORDER_MIN_PX, DIR_BORDER_PX - d.depth);
    // Fill behind everything, frame in front, for the same reason panels split
    // theirs: the children are drawn in between.
    this.pushRect(this.bgRects, d.x, d.y, d.w, d.h, tint, 1, 0, 0);
    this.pushRect(this.fgRects, d.x, d.y, d.w, d.h, tint, 0, edge, weight);

    // The label sits in the frame's own strip, so it never overlaps a panel.
    const px = metrics.dirLabelHeight * zoom;
    const fade = Math.min(1, Math.max(0, (px - 6) / 5));
    if (fade <= 0.004 || !d.name) return;
    const room = Math.floor((d.w - 2 * metrics.dirPad) / metrics.charWidth);
    if (room < 3) return;
    const shown = d.name.length <= room ? d.name : `${d.name.slice(0, Math.max(1, room - 2))}..`;
    this.pushText(
      shown, d.x + metrics.dirPad,
      this.chromeTop(d.y + metrics.dirPad - metrics.dirLabelHeight, metrics.dirLabelHeight),
      UiInk.DirLabel, fade, room,
    );
  }

  /**
   * Draw a string at a world position, one glyph per instance.
   *
   * Goes through the same pass as code, which is the point: header text lives
   * in world space and scales with its panel, instead of being a DOM label
   * blended over the canvas at its own independent size. The overlay it
   * replaces looked pasted on precisely because it did not share the panel's
   * transform.
   *
   * Returns the width drawn, so runs can be laid out one after another.
   */
  /**
   * Top of a glyph box for a line of chrome text centred in a bar `barH` tall.
   *
   * The box is 1.4 em, which at the size the chrome is drawn at is 16.3 world
   * units against a 14 unit title bar, and it is drawn downwards from the
   * position given. So a name with a descender in it, `simulation.py` among
   * them, had its tail land below the header's rule where the panel's own
   * content paints over it. Centring what is actually visible, cap height to
   * descender, puts it back inside the bar and reads better besides.
   */
  private chromeTop(top: number, barH: number): number {
    const em = metrics.charWidth / this.atlas.advanceRatio;
    const baseline = em * BASELINE_RATIO;
    const cap = baseline - em * this.atlas.capRatio;
    const tail = baseline + em * this.atlas.descenderRatio;
    return top + (barH - (tail - cap)) / 2 - cap;
  }

  /**
   * How far a line of text is lifted inside its row, in world units.
   *
   * A glyph box is 1.4 em tall against a 14 unit line and is drawn downwards
   * from the row's top, so a descender reaches past the row. On the last line
   * of a panel that is past the panel's own bottom edge, where the frame and
   * whatever is behind it cut it off. Lifted by exactly that overhang and no
   * more: centring the line the way a header is centred moves it 2.3 units up
   * in a 14 unit row, which reads as the text sitting in the wrong place and
   * measurably softens it.
   *
   * Every pass that draws inside a row uses this, the line numbers included.
   * They did not at first, which left the numbers a pixel below their code.
   */
  private lineLift(): number {
    const em = metrics.charWidth / this.atlas.advanceRatio;
    return -Math.max(0, em * (BASELINE_RATIO + this.atlas.descenderRatio) - metrics.lineHeight);
  }

  private pushText(
    str: string, x: number, y: number, ink: number, fade: number, maxChars: number,
  ): number {
    if (fade <= 0.004 || maxChars <= 0) return 0;
    const b = this.glyphs;
    const em = metrics.charWidth / this.atlas.advanceRatio;
    const n = Math.min(str.length, maxChars);
    for (let i = 0; i < n; i++) {
      const idx = GlyphAtlas.index(str.charCodeAt(i));
      if (idx < 0) continue;
      const o = b.alloc();
      const d = b.data;
      const tf = this.tf;
      d[o] = (x + i * metrics.charWidth) * tf.scale + tf.bx;
      d[o + 1] = y * tf.scale + tf.by;
      d[o + 2] = idx;
      d[o + 3] = ink;
      d[o + 4] = em * tf.scale;
      d[o + 5] = fade * tf.alpha;
    }
    return n * metrics.charWidth;
  }

  /**
   * The panel header: name, the directory it sits in, and its type.
   *
   * One line tall, laid out by what fits. The name always wins; the type badge
   * and then the path appear as the panel gets wider. Truncation is two dots
   * rather than an ellipsis because the glyph atlas is ASCII.
   */
  private pushHeader(f: SceneFile, zoom: number, hovered: boolean): void {
    const n = f.node;
    const px = metrics.titleHeight * zoom;
    // Below this the glyphs are noise and the bar alone reads as a header.
    const fade = Math.min(1, Math.max(0, (px - 5) / 4));

    this.pushRect(
      this.bgRects, n.x, n.y, n.w, metrics.titleHeight,
      hovered ? this.pal.surface.accent : this.pal.surface.panelBgAlt,
      hovered ? 0.3 : 1, 0, 0,
    );
    // Rule along the header's bottom edge, in the foreground pass so the code
    // below cannot paint over it. Same hairline as the border and the column
    // rules, so the header reads as part of the same frame.
    const rule = HAIRLINE_PX / Math.max(zoom, 1e-6);
    this.pushRect(
      this.fgRects, n.x, n.y + metrics.titleHeight - rule, n.w, rule,
      this.pal.surface.border, 1, 0, 0,
    );
    if (fade <= 0.004) return;

    const room = Math.floor((n.w - 2 * metrics.panelPadX) / metrics.charWidth);
    if (room <= 0) return;

    const x = n.x + metrics.panelPadX;
    const y = this.chromeTop(n.y, metrics.titleHeight);
    const dot = n.name.lastIndexOf('.');
    const ext = dot > 0 ? n.name.slice(dot + 1) : '';
    const dir = n.path.slice(0, Math.max(0, n.path.length - n.name.length - 1));
    // The live count, for the same reason: the header would otherwise keep
    // showing what the file had when it was laid out. A picture has no lines,
    // so it says what it is instead: pixels for an image, pages for a
    // document.
    const media = n.media;
    const lines = f.node.stub
      ? ''
      : media
        ? media.kind === 'document'
          ? `${media.pages > 0 ? compactCount(media.pages) : '?'}p`
          : `${media.w}x${media.h}`
        : compactCount(f.data.lineCount);

    // Right-aligned, in order: the type badge, then the line count. Both are
    // dropped before the name when space runs short, the badge first because
    // the extension is also visible in the name itself.
    let right = room;
    const badge = ext && room > n.name.length + ext.length + 3 ? ext : '';
    if (badge) {
      right -= badge.length;
      this.pushText(badge, x + right * metrics.charWidth, y, UiInk.Badge, fade, badge.length);
      right -= 1;
    }
    if (lines && right > n.name.length + lines.length + 3) {
      right -= lines.length;
      this.pushText(lines, x + right * metrics.charWidth, y, UiInk.Path, fade, lines.length);
    } else {
      right = room - (badge ? badge.length + 1 : 0);
    }

    // The path as it would be typed, directory and name in one run, the
    // directory dimmed. It used to be the name first and the directory after
    // it, which reads backwards: `simulation.py src/pathsim` is not where the
    // file is, it is two facts in the wrong order. The status bar already
    // wrote it this way, so now both do.
    const budget = Math.max(1, right - 2);
    const shownName =
      n.name.length <= budget ? n.name : `..${n.name.slice(-(Math.max(1, budget - 2)))}`;
    // Whatever is left in front of the name, cut from the front so the part
    // nearest the file survives.
    const dirRoom = budget - shownName.length;
    let shownDir = '';
    if (dir && dirRoom > 3) {
      const full = `${dir}/`;
      shownDir =
        full.length <= dirRoom ? full : `..${full.slice(full.length - (dirRoom - 2))}`;
    }
    if (shownDir) {
      this.pushText(shownDir, x, y, UiInk.Path, fade * 0.8, shownDir.length);
    }
    this.pushText(
      shownName, x + shownDir.length * metrics.charWidth, y, UiInk.Name, fade,
      shownName.length,
    );
  }

  /**
   * A stub panel: framed, filled flat, with a rule across it so it does not
   * read as an empty file.
   *
   * Grown to a floor of a pixel and a half on screen. A stub exists to say the
   * file is there, and a stub that vanishes when you zoom out has failed at
   * exactly the moment the overview matters. The floor is deliberately small:
   * any larger and stubs would out-shout the real files around them.
   */
  /**
   * The area a picture occupies, at the picture's own proportion.
   *
   * A placeholder, until the image itself is decoded and uploaded per level of
   * detail; see issue #20. Drawn rather than left blank because a panel with
   * nothing in it reads as a bug, which is exactly what an empty panel was
   * until an hour ago, and because the shape is already information: you can
   * see that a file is a wide plot or a portrait page before anything is
   * loaded.
   */
  private pushMedia(f: SceneFile, zoom: number): void {
    const n = f.node;
    const m = n.media;
    if (!m) return;
    const availW = n.w - 2 * metrics.panelPadX;
    const availH = n.h - metrics.titleHeight - 2 * metrics.panelPadY;
    if (availW <= 0 || availH <= 0 || availH * zoom < 2) return;
    const mw = m.w > 0 ? m.w : 595;
    const mh = m.h > 0 ? m.h : 842;
    // Contained, so the proportion is the picture's and the panel keeps its
    // padding whichever way the two disagree.
    const scale = Math.min(availW / mw, availH / mh);
    const w = mw * scale;
    const h = mh * scale;
    const x = n.x + metrics.panelPadX + (availW - w) / 2;
    const y = n.y + metrics.titleHeight + metrics.panelPadY + (availH - h) / 2;

    // The picture itself, at the resolution this size on screen needs, or the
    // area it will occupy while that is still being decoded. Asked for by
    // screen pixels, not by world units: the same panel needs eight times the
    // texture in a 4K export that it needs in the window.
    //
    // Below a certain size on screen it is not asked for at all. A panel 30
    // pixels across shows a smudge whatever is in it, and a project of 119
    // screenshots opened at the overview zoom is 119 source decodes, two
    // seconds of them, for 119 smudges. Whatever is already decoded keeps
    // being drawn, so zooming out never costs anything.
    const onScreen = w * zoom * this.dpr;
    const held =
      (w * zoom >= MEDIA_MIN_PX
        ? this.media?.want(n.path, onScreen, mw / mh, m.kind === 'image' ? mw : Infinity)
        : this.media?.have(n.path)) ?? null;

    // What goes under it. Most of what a repository holds in pictures is ink
    // with nothing behind it: a PDF page comes out of ImageIO as black type on
    // transparency (measured: 98 percent of a page is fully clear), and
    // pathsim's figures average an alpha of 6.6 of 255. On the canvas
    // background those are invisible, so anything that carries no background
    // of its own gets a sheet of paper instead. A document gets one before it
    // has loaded, since a document always needs one and the placeholder then
    // reads as a page.
    const paper = m.kind === 'document' || held?.translucent === true;
    const back = paper ? this.pal.surface.paper : this.pal.surface.reducedBg;
    this.pushRect(this.bgRects, x, y, w, h, back, 1, 0, 0);
    if (held) {
      this.imageDraws.push({ tex: held.tex, x, y, w, h, fade: this.tf.alpha });
      return;
    }
    if (h * zoom > 4) {
      this.pushRect(
        this.fgRects, x, y, w, h, back, 0,
        this.pal.surface.border, 1,
      );
    }
  }

  /** One draw call per picture; see shaders.ts for why it is not instanced. */
  private drawImages(): void {
    const { gl } = this;
    if (this.imageDraws.length === 0) return;
    gl.useProgram(this.progImage);
    gl.uniformMatrix3fv(this.uImage.uView, false, this.view);
    gl.uniform1i(this.uImage.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    quadAttrib(gl, this.progImage, this.quad);
    for (const d of this.imageDraws) {
      gl.bindTexture(gl.TEXTURE_2D, d.tex);
      gl.uniform4f(this.uImage.uRect, d.x, d.y, d.w, d.h);
      gl.uniform1f(this.uImage.uFade, d.fade);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  private pushStub(f: SceneFile, zoom: number): void {
    const n = f.node;
    const floor = STUB_MIN_PX / Math.max(zoom, 1e-6);
    const w = Math.max(n.w, floor * 4);
    const h = Math.max(n.h, floor);
    const flash = flashAt(f.since);
    const hot = flash > 0.02;
    // Below a couple of pixels a border would be the whole panel.
    const borderPx = h * zoom > 4 ? 1 : 0;
    this.pushRect(this.bgRects, n.x, n.y, w, h, this.pal.surface.reducedBg, 1, 0, 0);
    if (borderPx > 0) {
      this.pushRect(
        this.fgRects, n.x, n.y, w, h,
        this.pal.surface.reducedBg, 0,
        hot ? this.pal.surface.heat : this.pal.surface.border,
        borderPx,
      );
    }
    if (h * zoom < 5) return;
    const inset = metrics.panelPadX;
    const room = Math.floor((w - 2 * inset) / metrics.charWidth);
    // Its name, once there is room to read one. A chip used to be a box with a
    // line through it at every zoom, which says "a file is here" and stops:
    // with three hundred of them that is a striped field and no information.
    // The name is what makes a placeholder worth drawing.
    const px = metrics.titleHeight * zoom;
    const fade = Math.min(1, Math.max(0, (px - 5) / 4));
    if (fade > 0.004 && room >= 3) {
      const name = n.name.length <= room
        ? n.name
        // From the end, so the extension survives: `solver_esdirk43.py` says
        // more as `..dirk43.py` than as `solver_es..`.
        : `..${n.name.slice(-(room - 2))}`;
      this.pushText(
        name, n.x + inset, this.chromeTop(n.y, metrics.titleHeight),
        UiInk.Path, fade * 0.85, room,
      );
      return;
    }
    this.pushRect(
      this.fgRects, n.x + inset, n.y + h / 2 - 0.5, Math.max(0, w - 2 * inset), 1,
      this.pal.surface.reducedInk, 0.65, 0, 0,
    );
  }

  /**
   * A hairline down the middle of each gutter between code columns.
   *
   * A panel that wraps its lines into columns reads as one block of text
   * without them: the eye has no way to tell whether the next column continues
   * the file or starts something new, and at the zoom where the wrapping
   * matters the gutter alone is only a couple of pixels wide. The rule stops
   * short of the header so it does not cut through the file name.
   */
  private pushColumnRules(f: SceneFile, zoom: number): void {
    const g = f.node.geom;
    if (g.columns < 2) return;
    // Below this the rules would be denser than the content they separate.
    if (g.pitch * zoom < 24) return;

    const n = f.node;
    const top = n.y + textOriginY;
    // A world unit short of the bottom, so the rule reads as a separator
    // between columns rather than as part of the frame.
    const height = n.h - textOriginY - metrics.panelPadY - 1;
    if (height <= 0) return;
    // One device pixel whatever the zoom: a rule in world units would vanish
    // zoomed out and turn heavy zoomed in.
    const w = HAIRLINE_PX / Math.max(zoom, 1e-6);

    for (let c = 1; c < g.columns; c++) {
      // Centre of the gutter between column c-1 and column c.
      const x = n.x + textOriginX + c * g.pitch - COLUMN_GUTTER / 2 - w / 2;
      this.pushRect(this.bgRects, x, top, w, height, this.pal.surface.border, 1, 0, 0);
    }
  }

  /** Panel background. The border is a separate pass; see `pushPanelBorder`. */
  private pushPanel(f: SceneFile): void {
    const n = f.node;
    // A file written a moment ago gets its whole panel washed towards the
    // recency colour, not only its border.
    //
    // The border alone was the signal, and out at the zoom where a project
    // fits the window it is the *only* one, because the line bands come up
    // with the token geometry at about two pixels a line. A ten pixel panel
    // with a coloured outline reads as a box among a thousand boxes. The wash
    // is what makes "something happened over there" visible from across the
    // canvas, and it fades with the same glow.
    const flash = flashAt(f.since);
    const bg = flash > 0.004
      ? bandColour(this.pal.surface.panelBg, this.pal.surface.heat, FLASH_WASH * flash)
      : this.pal.surface.panelBg;
    this.pushRect(this.bgRects, n.x, n.y, n.w, n.h, bg, 1, 0, 0);
  }

  /**
   * The panel's border, drawn after its contents.
   *
   * Separate from the background because everything inside a panel is drawn
   * over that background: the header bar spans the full panel width and the
   * column rules run its full height, so both painted over the border and left
   * panels looking broken along their edges. A border that encloses its
   * contents has to be painted after them.
   */
  private pushPanelBorder(f: SceneFile, found: boolean): void {
    const n = f.node;
    // Two signals, deliberately different in strength.
    //
    // `heat` is recency: someone wrote this file a moment ago. It warms the
    // border fully and thickens it, and it fades.
    //
    // `state` is standing: this file differs from the baseline. It only tints
    // the border, at hairline width, because it does not fade and should not
    // shout. This was left out at first on the assumption that nearly every
    // file differs from the baseline, which measurement contradicted: on a
    // 1063 file project one commit touches 0.4% of files, five touch 1.5% and
    // twenty touch 8.5%. Uncommitted work is a handful of files, which is
    // exactly the thing worth seeing from the outermost zoom.
    // One signal now, not two: a panel is warm for a while after it was
    // written and cools off. The standing "differs from a baseline" tint went
    // with the baseline itself, since changes are shown per save.
    //
    // A search match takes the accent and the extra weight for as long as the
    // query stands. It reads as one of the same family of signals rather than
    // a mode of its own, and it outranks recency while it is on: someone who
    // typed a name is looking for that file, not for the last thing written.
    const flash = flashAt(f.since);
    const hot = flash > 0.02;
    const border = found
      ? this.pal.surface.accent
      : hot ? this.pal.surface.heat : this.pal.surface.border;
    const borderPx = found ? HAIRLINE_PX + 2 : hot ? HAIRLINE_PX + 2 * flash : HAIRLINE_PX;
    // Transparent fill, so this draws only the outline over what is there.
    this.pushRect(this.fgRects, n.x, n.y, n.w, n.h, this.pal.surface.panelBg, 0, border, borderPx);
  }

  private overviewBuffer(classIdx: number, chunkIdx: number): InstanceBuffer {
    const key = `${classIdx}:${chunkIdx}`;
    let b = this.overviewByChunk.get(key);
    if (!b) {
      b = new InstanceBuffer(this.gl, OVERVIEW_STRIDE, 1024);
      this.overviewByChunk.set(key, b);
    }
    return b;
  }

  private pushOverview(f: SceneFile, fade: number): void {
    const { node: n, slot } = f;
    const g = n.geom;
    const b = this.overviewBuffer(slot.classIdx, slot.chunkIdx);
    const vTotal = this.textures.vExtent(slot);
    const pitch = columnPitch(g);
    const colW = columnWidth(g);
    const colHeight = g.linesPerColumn * metrics.lineHeight;
    // Screen rows, wrapped lines included, which is what the texture holds
    // and what the columns are filled with.
    //
    // Off the data rather than off the node: the node carries the line count
    // the layout was built from, and a file that has since lost lines has a
    // shorter `rows`, so indexing it with the node's count read past the end.
    // That is `undefined`, every number derived from it became NaN, and the
    // panel drew nothing at all -- for good, not just for the animation. An
    // edit that removed lines made its file disappear from the overview,
    // which is the zoom this whole app is meant to be watched at.
    const totalRows = f.rows[f.data.lineCount];

    for (let c = 0; c < g.columns; c++) {
      const first = c * g.linesPerColumn;
      if (first >= totalRows) break;
      const last = Math.min(totalRows, first + g.linesPerColumn);
      // The texture holds the file as a single column, so each code column
      // samples its own slice of the v range.
      const v0 = (first / totalRows) * vTotal;
      const v1 = (last / totalRows) * vTotal;
      const h = ((last - first) / g.linesPerColumn) * colHeight;

      const o = b.alloc();
      const d = b.data;
      const tf = this.tf;
      d[o] = (n.x + textOriginX + c * pitch + textIndent(g)) * tf.scale + tf.bx;
      d[o + 1] = (n.y + textOriginY) * tf.scale + tf.by;
      d[o + 2] = colW * tf.scale;
      d[o + 3] = h * tf.scale;
      d[o + 4] = 0; d[o + 5] = v0; d[o + 6] = 1; d[o + 7] = v1;
      d[o + 8] = slot.layer;
      d[o + 9] = fade * tf.alpha;
      d[o + 10] = f.family;
    }
  }

  private drawOverview(): void {
    const { gl } = this;
    let any = false;
    for (const b of this.overviewByChunk.values()) if (b.count > 0) any = true;
    if (!any) return;

    gl.useProgram(this.progOverview);
    gl.uniformMatrix3fv(this.uOverview.uView, false, this.view);
    gl.uniform1i(this.uOverview.uTex, 0);
    gl.uniform1f(this.uOverview.uSharp, this.sharpen ? 1 : 0);
    gl.uniform1f(this.uOverview.uLangTint, this.langTint);
    gl.uniform3fv(this.uOverview['uFamily[0]'], this.familyFlat);
    gl.activeTexture(gl.TEXTURE0);

    for (const [key, b] of this.overviewByChunk) {
      if (b.count === 0) continue;
      const [ci, chi] = key.split(':').map(Number);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures.texture(ci, chi));
      gl.uniform1f(this.uOverview.uTexRows, HEIGHT_CLASSES[ci]);
      b.upload();
      quadAttrib(gl, this.progOverview, this.quad);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      instanceAttribs(gl, this.progOverview, OVERVIEW_STRIDE, [
        ['aRect', 4, 0], ['aUv', 4, 4], ['aMeta', 3, 8],
      ]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    }
  }

  /** Which lines of which code columns of this file are on screen. */
  /**
   * Which lines of which code columns of this file are on screen.
   *
   * `colX` is where the column's text begins, past the line-number margin.
   * The margin is part of the layout, so every pass that draws into a column
   * has to skip it, and having `visibleRuns` return the text origin rather
   * than the column origin means none of them can forget.
   */
  /**
   * Which screen rows of which code columns of this file are on screen.
   *
   * Rows rather than source lines, because a wrapped line occupies several
   * rows and the passes lay out by row. `colX` is where the column's text
   * begins, past the line-number margin, so no pass can forget the margin.
   */
  /** Reused by `visibleRuns`, which yields it rather than a fresh tuple: the
   *  consumers destructure it immediately and none of them keeps it. */
  private runTuple: [number, number, number, number] = [0, 0, 0, 0];

  private *visibleRuns(
    f: SceneFile, vx0: number, vy0: number, vx1: number, vy1: number,
  ): Generator<[column: number, colX: number, firstRow: number, lastRow: number]> {
    const g = f.node.geom;
    const pitch = columnPitch(g);
    const colW = columnWidth(g);
    const yBase = f.node.y + textOriginY;
    const indent = textIndent(g);
    const totalRows = f.rows[f.data.lineCount];

    for (let c = 0; c < g.columns; c++) {
      const colX = f.node.x + textOriginX + c * pitch + indent;
      if (colX > vx1 || colX + colW < vx0) continue;
      const rowFrom = Math.max(0, Math.floor((vy0 - yBase) / metrics.lineHeight));
      const rowTo = Math.min(
        g.linesPerColumn - 1,
        Math.ceil((vy1 - yBase) / metrics.lineHeight),
      );
      if (rowTo < rowFrom) continue;
      const first = c * g.linesPerColumn + rowFrom;
      const last = Math.min(totalRows - 1, c * g.linesPerColumn + rowTo);
      if (last < first) continue;
      const t = this.runTuple;
      t[0] = c;
      t[1] = colX;
      t[2] = first;
      t[3] = last;
      yield t;
    }
  }

  /**
   * The source line and wrap index at a screen row, and the row's y offset
   * within its column.
   */
  /**
   * Source line, wrapped row within it, and world y for a screen row.
   *
   * Written into fields rather than returned as an object. This is called once
   * per visible row per drawing pass, so at the readable zoom it runs
   * thousands of times a frame, and an object per call is an object per row
   * per pass for the garbage collector to take back.
   */
  private riLine = 0;
  private riWrap = 0;
  private riY = 0;

  private rowInfo(f: SceneFile, row: number, column: number): void {
    const line = lineAtRow(f.rows, row);
    this.riLine = line;
    this.riWrap = row - f.rows[line];
    this.riY =
      f.node.y + textOriginY + (row - column * f.node.geom.linesPerColumn) * metrics.lineHeight;
  }

  private pushSpans(
    f: SceneFile, fade: number, pxPerLine: number,
    vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.spans;
    const d0 = f.data;
    const g = f.node.geom;
    const cols = g.cols;
    const h = metrics.lineHeight * spanBarHeight(pxPerLine);
    const yOff = (metrics.lineHeight - h) * 0.5;
    // Hoisted out of the inner loop, which runs once per token on screen and
    // reached thirty thousand a frame: a property load on `this`, on the
    // transform and on the metrics module is not free at that rate, and
    // neither is reading `b.data` after every allocation. Measured: 1.40 ms a
    // frame down to 1.23 at the zoom where the bars are the picture.
    //
    // The span accessors stay as calls. Inlining their bit arithmetic here
    // measured another ten percent and puts the wire format's field layout in
    // two places, where a change to one is silent in the other. Ten percent of
    // one zoom level, on a renderer that only draws when something changed, is
    // not worth that.
    const cw = metrics.charWidth;
    const scale = this.tf.scale;
    const bx = this.tf.bx;
    const by = this.tf.by;
    const alpha = fade * this.tf.alpha;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      // Upper bound on the quads this run can produce: every span of every
      // line it touches, plus one per row for a span split across a wrap.
      // Spans do not overlap, so at most one can cross any one boundary.
      const firstLine = lineAtRow(f.rows, firstRow);
      const lastLine = lineAtRow(f.rows, lastRow);
      const rows = lastRow - firstRow + 1;
      b.reserve(d0.spanStart[lastLine + 1] - d0.spanStart[firstLine] + rows);
      const dd = b.data;
      let o = b.count * SPAN_STRIDE;

      for (let row = firstRow; row <= lastRow; row++) {
        this.rowInfo(f, row, c);
        const line = this.riLine;
        const y = this.riY + yOff;
        // The character range of the source line that lands on this row.
        const from = this.riWrap * cols;
        const to = from + cols;
        const s0 = d0.spanStart[line];
        const s1 = d0.spanStart[line + 1];
        for (let s = s0; s < s1; s++) {
          const p = d0.spans[s];
          const col = spanCol(p);
          const end = col + spanLen(p);
          // Clip the span to this row's slice rather than to the column: a
          // span that starts before the slice continues into it.
          if (end <= from || col >= to) continue;
          const lo = col > from ? col : from;
          const hi = end < to ? end : to;
          dd[o] = (colX + (lo - from) * cw) * scale + bx;
          dd[o + 1] = y * scale + by;
          dd[o + 2] = (hi - lo) * cw * scale;
          dd[o + 3] = h * scale;
          dd[o + 4] = spanKind(p);
          dd[o + 5] = alpha;
          o += SPAN_STRIDE;
        }
      }
      b.count = o / SPAN_STRIDE;
    }
  }


  private drawSpans(): void {
    if (this.spans.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.progSpan);
    gl.uniformMatrix3fv(this.uSpan.uView, false, this.view);
    gl.uniform3fv(this.uSpan['uKind[0]'], this.spanFlat);
    this.spans.upload();
    quadAttrib(gl, this.progSpan, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spans.buf);
    instanceAttribs(gl, this.progSpan, SPAN_STRIDE, [['aRect', 4, 0], ['aKindFade', 2, 4]]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spans.count);
  }

  /**
   * Line numbers down the left of each code column.
   *
   * Only once text is readable, and only where the column is wide enough that
   * the gutter is not eating the code: a number costs four to six characters
   * of a column that may only have thirty, so below a threshold the code is
   * worth more than knowing which line it is.
   *
   * Right-aligned in the gutter, in the faint ink, so they read as a margin
   * rather than as content. They sit in the column's own gutter space, which
   * is why they do not shift the text: the gutter exists between columns
   * anyway and the first column's is the panel padding.
   */
  private pushLineNumbers(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const g = f.node.geom;
    // The layout decides whether there is a margin at all; see numberColsFor.
    if (g.numberCols === 0) return;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        this.rowInfo(f, row, c);
        const line = this.riLine;
        const wrap = this.riWrap;
        const y = this.riY + this.lineLift();
        // Continuation rows carry no number: the number belongs to the source
        // line, and repeating it would claim there are more lines than there
        // are.
        if (wrap !== 0) continue;
        const label = String(line + 1);
        // Right-aligned against the text, inside the reserved margin.
        const x = colX - (label.length + 1) * metrics.charWidth;
        this.pushText(label, x, y, UiInk.Path, fade * 0.7, label.length);
      }
    }
  }

  private pushGlyphs(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.glyphs;
    const g = f.node.geom;
    const cols = g.cols;
    const d0 = f.data;
    // Hoisted for the same reason as in `pushSpans`: this runs once per
    // character on screen, which is tens of thousands a frame at the readable
    // zoom, and everything constant across it is read once.
    const cw = metrics.charWidth;
    const scale = this.tf.scale;
    const bx = this.tf.bx;
    const by = this.tf.by;
    const em = (metrics.charWidth / this.atlas.advanceRatio) * scale;
    const alpha = fade * this.tf.alpha;
    // A glyph box is 1.4 em tall against a 14 unit line and is drawn downwards
    // from the row's top, so a descender reaches a little past the row. On the
    // last line of a panel that is past the panel's bottom edge, where the
    // frame and whatever is behind it cut it off.
    //
    // Lifted by exactly that overhang and no more. Centring the line the way
    // the header is centred moves it 2.3 units up in a 14 unit row, which
    // reads as the text sitting in the wrong place and measurably softens it:
    // glyph-check lost every character and text-check went from 24.6 to 42.7
    // percent half-tone.
    const lift = this.lineLift() * scale;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      // One quad per character at most, over the rows this run covers.
      b.reserve((lastRow - firstRow + 1) * cols);
      const dd = b.data;
      let o = b.count * GLYPH_STRIDE;

      for (let row = firstRow; row <= lastRow; row++) {
        this.rowInfo(f, row, c);
        const line = this.riLine;
        const y = this.riY * scale + by + lift;
        const text = this.text.lineText(f.node.path, line);
        if (!text) continue;
        const from = this.riWrap * cols;
        const to = Math.min(from + cols, text.length);
        const s0 = d0.spanStart[line];
        const s1 = d0.spanStart[line + 1];

        // Over the columns, with a cursor into the spans, rather than over the
        // spans.
        //
        // Iterating the spans drew only what they covered, and about a tenth
        // of the characters in real code are in no span: the coverage report
        // puts Rust at 88 percent and JSON at 74, and the rest simply went
        // missing. On screen that read as stray spaces inside words, and where
        // a word straddled the boundary, as neighbouring letters in two
        // slightly different greys, since one half took its span's colour and
        // the other fell through to nothing.
        //
        // Walking the columns draws every character exactly once, and the
        // first span that covers a column decides its colour; anything
        // uncovered is plain text, which is what it is. Measured over 300,427
        // spans of a real project, none of them overlap, so first-wins is a
        // rule for the arithmetic rather than a policy about precedence.
        let cursor = s0;
        for (let k = from; k < to; k++) {
          const idx = GlyphAtlas.index(text.charCodeAt(k));
          if (idx < 0) continue;
          // Advance past spans that end before this column. They are sorted by
          // column, so this walks each span at most once per row.
          while (cursor < s1 && spanCol(d0.spans[cursor]) + spanLen(d0.spans[cursor]) <= k) {
            cursor++;
          }
          const p = cursor < s1 ? d0.spans[cursor] : 0;
          const covers = cursor < s1 && spanCol(p) <= k;
          dd[o] = (colX + (k - from) * cw) * scale + bx;
          dd[o + 1] = y;
          dd[o + 2] = idx;
          dd[o + 3] = covers ? spanKind(p) : Kind.Plain;
          dd[o + 4] = em;
          dd[o + 5] = alpha;
          o += GLYPH_STRIDE;
        }
      }
      b.count = o / GLYPH_STRIDE;
    }
  }


  private drawGlyphs(pxPerLine: number, dpr: number): void {
    if (this.glyphs.count === 0) return;
    const { gl } = this;
    const em = (metrics.charWidth / this.atlas.advanceRatio) * (pxPerLine / metrics.lineHeight);
    // While the camera is moving, one of the fixed levels: rasterising a new
    // atlas per zoom step would be a canvas of 95 glyphs every frame. Once it
    // is still, the exact size, which is what makes the text sharp.
    const exact = this.cameraStill && this.exactGlyphAtlas;
    const level = this.atlas.pick(em * dpr, exact);

    gl.useProgram(this.progGlyph);
    gl.uniformMatrix3fv(this.uGlyph.uView, false, this.view);
    gl.uniform3fv(this.uGlyph['uKind[0]'], this.kindFlat);
    gl.uniform1i(this.uGlyph.uAtlas, 0);
    gl.uniform2f(
      this.uGlyph.uCell,
      level.cellW / level.texW,
      level.cellH / level.texH,
    );
    // The cell in device pixels, and the world-space em that stands for it:
    // a glyph asking for that em is drawn as the cell, texel on pixel, and one
    // asking for less, in a panel still animating in, is scaled down with it.
    //
    // For an exact atlas that em is the one every panel at rest asks for, not
    // the size the atlas was built at. The two differ by the rounding to a
    // whole pixel, and scaling by that difference is what made a third of all
    // zoom levels soft: an atlas built at 12 for an em of 11.63 came out 16
    // pixels tall from a cell of 17, so every row of every glyph was
    // resampled. Rounded, the glyph is up to half a pixel larger or smaller
    // than the em, which nobody can see; resampled, it is soft, which anybody
    // can. Measured over twenty zoom levels from 8 to 29 pixels per line, as
    // the share of edge pixels in mid-ramp, mean and worst:
    //
    //                                  dpr 1         dpr 2
    //   scaled by the rounding       16.6  30.7    12.4  15.6
    //   atlas at the fractional em   15.2  21.8    12.0  16.0
    //   rounded, drawn 1:1           13.9  17.3    11.8  13.6
    const scalePx = (pxPerLine / metrics.lineHeight) * dpr;
    gl.uniform2f(this.uGlyph.uBoxPx, level.cellW, level.cellH);
    gl.uniform1f(
      this.uGlyph.uEmWorld,
      exact
        ? metrics.charWidth / this.atlas.advanceRatio
        : level.size / Math.max(1e-6, scalePx),
    );
    gl.uniform1f(this.uGlyph.uGridCols, GlyphAtlas.gridCols);
    gl.uniform2f(this.uGlyph.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, level.tex);

    this.glyphs.upload();
    quadAttrib(gl, this.progGlyph, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphs.buf);
    instanceAttribs(gl, this.progGlyph, GLYPH_STRIDE, [
      ['aPosGlyph', 4, 0], ['aSizeFade', 2, 4],
    ]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glyphs.count);
  }

  /**
   * Changed lines, as a band across the line plus a marker in the margin, and
   * removals as a crack between two lines.
   *
   * The band is what says *which* lines: a marker in the margin tells you a
   * line changed and a band tells you which of the lines in front of you it
   * was, without having to look away from the code to the edge of the panel.
   * It sits behind the text at low alpha so the code stays the readable thing.
   *
   * A removal is the one case a band gets wrong. There is no line left to
   * mark, so the mark goes on the line next to the gap, and banding that line
   * says it changed when it did not: it is the same line it always was, it
   * only moved. So a gap is drawn as a crack across the boundary the removed
   * lines used to occupy, which is where they were and is not a line.
   *
   * During a change the alpha is driven by the animation instead, and the rows
   * come from the diff rather than from git: see `pushChangeBands`.
   */
  private pushGutter(f: SceneFile, zoom: number, vy0: number, vy1: number): void {
    if (f.state === LineState.Unchanged) return;
    const w = Math.max(2, metrics.charWidth * 0.4);
    const [vx0, vx1] = [-Infinity, Infinity];
    const colW = columnWidth(f.node.geom);
    // The marks fade out with the panel's glow rather than standing forever:
    // a change is worth seeing for a while after the save and not beyond it.
    const fade = f.shownMark;
    if (fade <= 0.02) return;

    // A crack sits between two lines, so unlike a band it has no height of its
    // own to take from the layout. A fraction of the line height keeps it in
    // proportion when the text is large, and the floor in screen pixels keeps
    // it visible when the text is small, which is where the gutter marks come
    // up at all.
    const thick = Math.max(GAP_PX / zoom, metrics.lineHeight * GAP_OF_LINE);

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        this.rowInfo(f, row, c);
        const line = this.riLine;
        const wrap = this.riWrap;
        const y = this.riY;
        const st = f.data.lineState[line];
        if (st === LineState.Unchanged) continue;
        const color = this.changeColour(st);

        if (st === LineState.GapAbove || st === LineState.GapBelow) {
          // On the row that carries the edge in question: the first row of the
          // line for a gap above it, the last for a gap below it. A wrapped
          // line has several rows and the gap is at one boundary, not at each.
          const below = st === LineState.GapBelow;
          const rows = f.rows[line + 1] - f.rows[line];
          if (below ? wrap !== rows - 1 : wrap !== 0) continue;
          const edge = below ? y + metrics.lineHeight : y;
          // Through the margin as well, so it reads as a cut across the column
          // rather than as an underline belonging to the code.
          this.pushRect(
            this.fgRects, colX - w - 1, edge - thick / 2, colW + w + 1, thick,
            color, 0.9 * fade, 0, 0,
          );
          continue;
        }

        // The band covers every row a wrapped line occupies: the change is the
        // whole line, however many rows it takes to show it.
        this.pushRect(
          this.bgRects, colX, y, colW, metrics.lineHeight,
          bandColour(this.pal.surface.panelBg, color, BAND_MIX * fade), 1, 0, 0,
        );

        // One marker per source line, on its first row: a wrapped line is one
        // change, not three.
        if (wrap !== 0) continue;
        this.pushRect(
          this.fgRects, colX - w - 1, y, w, metrics.lineHeight, color, 0.85 * fade, 0, 0,
        );
      }
    }
  }

  /**
   * The lines a content search found, as a band each.
   *
   * The same shape as a changed line's band, in the accent rather than a
   * change colour, because they are the same kind of statement about a line
   * and reading them as one vocabulary is the point. The line the camera is
   * on is drawn at full strength and the others at a third, so stepping
   * through hits inside one file is visible without leaving the panel.
   */
  private pushHits(f: SceneFile, vy0: number, vy1: number): void {
    const at = this.hits.get(f.node.path);
    if (!at || at.length === 0) return;
    const [vx0, vx1] = [-Infinity, Infinity];
    const colW = columnWidth(f.node.geom);
    const g = f.node.geom;
    const here = this.current?.path === f.node.path ? this.current.line : -1;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let k = 0; k < at.length; k += 2) {
        const line = at[k];
        if (line >= f.data.lineCount) continue;
        const from = f.rows[line];
        const to = line + 1 <= f.data.lineCount ? f.rows[line + 1] : from + 1;
        const mix = line === here ? HIT_MIX_CURRENT : HIT_MIX;
        const band = bandColour(this.pal.surface.panelBg, this.pal.surface.accent, mix);
        for (let row = from; row < to; row++) {
          if (row < firstRow || row > lastRow) continue;
          const y = f.node.y + textOriginY + (row - c * g.linesPerColumn) * metrics.lineHeight;
          this.pushRect(this.bgRects, colX, y, colW, metrics.lineHeight, band, 1, 0, 0);
        }
      }
    }
  }

  /** The colour a line state is drawn in. */
  private changeColour(st: number): number {
    if (st === LineState.Added) return this.pal.surface.added;
    if (st === LineState.Modified) return this.pal.surface.modified;
    return this.pal.surface.deleted;
  }

  /**
   * The bands of a change in progress, over the top of the persistent ones.
   *
   * Two phases, in order: the lines that are going away are shown in the
   * deleted colour and fade out, then the content is swapped and the lines
   * that arrived are shown in the added colour and fade down to their resting
   * alpha. Taking away before putting back is what makes it read as an edit
   * rather than as a flicker.
   *
   * The rows come from a diff of the two versions rather than from git,
   * because git answers a different question: it says how the file differs
   * from a baseline, which after a commit is nothing at all while the file on
   * screen has just been rewritten.
   */
  private pushChangeBands(f: SceneFile, vy0: number, vy1: number): void {
    const ch = f.change;
    if (!ch) return;
    const [vx0, vx1] = [-Infinity, Infinity];
    const colW = columnWidth(f.node.geom);
    const g = f.node.geom;

    const removing = ch.phase === 'remove';
    const rows = removing ? ch.removedRows : ch.addedRows;
    if (rows.length === 0) return;
    const colour = removing ? this.pal.surface.deleted : this.pal.surface.added;
    const e = Math.min(1, ch.t / (removing ? timing.changeOut : timing.changeIn));
    // Out: full strength back to the panel. In: full strength down to the
    // standing band, so the line stays marked afterwards rather than going
    // blank the moment it arrives.
    const mix = removing
      ? CHANGE_MIX * (1 - e)
      : BAND_MIX + (CHANGE_MIX - BAND_MIX) * (1 - e);
    const band = bandColour(this.pal.surface.panelBg, colour, mix);

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (const line of rows) {
        // Every screen row this source line occupies.
        const from = f.rows[line];
        const to = line + 1 <= f.data.lineCount ? f.rows[line + 1] : from + 1;
        for (let row = from; row < to; row++) {
          if (row < firstRow || row > lastRow) continue;
          const y = f.node.y + textOriginY + (row - c * g.linesPerColumn) * metrics.lineHeight;
          // Background, not foreground: the band belongs behind the code, and
          // pushed after the standing bands so a change overrides one.
          this.pushRect(this.bgRects, colX, y, colW, metrics.lineHeight, band, 1, 0, 0);
        }
      }
    }
  }

}
