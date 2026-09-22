// Lifecycle of the canvas: context, camera, scene, input, frame loop.
//
// Owns everything that is not Svelte. The chrome talks to it through a small
// surface (open a repo, switch theme, read stats) and never touches WebGL, and
// this file never touches the DOM outside its own canvas and label host.

import { Camera } from '$lib/canvas/camera';
import {
  computeLayout, layoutStats, passesUsed,
  type FileEntry, type FileNode, type Layout,
} from '$lib/canvas/layout/tree';
import { decodeFile, type FileData } from '$lib/canvas/data/wire';
import { createContext } from '$lib/canvas/renderer/gl';
import { MediaTextures } from '$lib/canvas/renderer/mediatex';
import { Scene, type TextSource } from '$lib/canvas/renderer/scene';
import { metrics } from '$lib/metrics';
import {
  bandsFromQuery, lodBands, lodName, lodWeights, setBands, type LodName,
} from '$lib/canvas/lod';
import { rank, type Ranked } from '$lib/canvas/search';
import { flashAt, markAt } from '$lib/canvas/recency';
import { countHits, type FileHits } from '$lib/canvas/content';
import { readPalette, type Palette } from '$lib/theme';

export type { LodName };

export interface CanvasStats {
  files: number;
  totalLines: number;
  visibleFiles: number;
  lod: LodName;
  pxPerLine: number;
  quads: number;
  cpuMs: number;
  frameMs: number;
  vramMb: number;
  /** Fraction of the canvas covered by panels, from the layout pass. */
  fill: number;
  indexing: number;
  /** Active hand-over points, so the status bar can show what is in effect. */
  bands: string;
  /** True while at least one panel is still settling into place.
   *
   *  Reported because the checks screenshot as soon as the scan is done, and
   *  a frame caught mid-animation is a different picture. They wait on this.
   *  It is also the signal an adaptive frame rate would need: a settled canvas
   *  that nobody is panning has nothing to redraw. */
  settling: boolean;
}

/** What the chrome has to supply to open a repository. */
export interface RepoSource {
  entries: FileEntry[];
  /** Payload per path, in the wire format. */
  payload(path: string): ArrayBuffer | undefined;
  text: TextSource;
  /**
   * Search the text of every file, or absent when the source cannot.
   *
   * A capability of the source rather than a method here, because where the
   * text is decides where the search happens: a real folder is searched in
   * Rust, which has the bytes and reads 18 megabytes in 7 milliseconds, while
   * a fixture is searched in the browser, which already holds them.
   */
  find?: (query: string, capPerFile: number) => Promise<FileHits[]>;
  /**
   * Resolves when whatever the source loads in the background has arrived, or
   * absent when there is nothing to wait for.
   *
   * A fixture fetches its text after its structure, so the canvas is up and
   * drawing panels before there is a character to put in them. A check that
   * screenshots the moment the scan is done would be looking at the gap; it
   * awaits this through the debug handle, see scripts/browser.mjs.
   */
  ready?: () => Promise<void>;
  /**
   * Raw bytes of one file, for a picture the renderer is about to decode, or
   * absent when the source has no way to hand them over.
   *
   * Bytes rather than a decoded image: the resolution a picture is decoded at
   * follows the zoom, and only the renderer knows that. See
   * renderer/mediatex.ts.
   */
  imageBytes?: (path: string, level: number) => Promise<ArrayBuffer | null>;
}

const UPLOAD_BUDGET_MS = 6;

/**
 * Hits reported per file, and the shortest query that searches text at all.
 *
 * The cap is per file rather than overall so one enormous file cannot crowd
 * out every other: what the canvas needs is where the hits are, and past a
 * few dozen in one file the panel is marked either way. The floor on the
 * query is there because two characters match half a repository, which is a
 * lot of reading for an answer nobody can use.
 */
const HITS_PER_FILE = 64;
const MIN_CONTENT_QUERY = 3;

/** Lines of context kept around a hit the camera flies to. */
const LINE_CONTEXT = 14;

export interface ContentResult {
  /** Files with at least one hit. */
  files: number;
  /** Hits reported, and hits there are, which differ once the cap bites. */
  shown: number;
  total: number;
  /** True when a newer query overtook this one, so the caller ignores it. */
  stale: boolean;
}

/** What a PNG export asks for. */
export interface ImageRequest {
  /**
   * Largest image wanted, in pixels. The one produced fits inside this box at
   * the aspect of what is being framed, so nothing is padded and nothing is
   * cut: a wide project comes out 3840 by 2021 rather than 3840 by 2160 with
   * a strip of background at the top and bottom.
   */
  width: number;
  height: number;
  /** What to frame: what is on screen, or the whole project. */
  region: 'view' | 'project';
}

/**
 * Largest edge an export will ask the GPU for.
 *
 * Both the driver's viewport limit and the browser's canvas limit sit above
 * this on every machine that can run the app at all, and a bound of our own
 * means a request that is too big comes back smaller rather than blank: a
 * canvas past its limit does not throw, it loses its context.
 */
const MAX_IMAGE_EDGE = 8192;

export class CanvasApp {
  readonly cam = new Camera();
  private gl: WebGL2RenderingContext;
  private scene: Scene | null = null;
  /** Held here rather than on the scene, which is replaced on every open. */
  private languageTint = false;
  private layout: Layout | null = null;
  private pal: Palette;

  private pending: string[] = [];
  private decoded = new Map<string, FileData>();
  private uploaded = 0;

  private raf = 0;
  /**
   * Set when the picture would come out different from the one on screen.
   *
   * The renderer draws on demand rather than every frame. A canvas nobody is
   * touching has nothing to redraw, and redrawing it anyway costs a
   * millisecond of CPU and a few thousand quads of GPU work sixty times a
   * second for the length of time the window is open, which is the whole day.
   *
   * Set explicitly by everything that changes the picture rather than inferred
   * from input: a flash fading, a texture arriving, a watcher batch and a theme
   * switch all change it without anyone touching the mouse, and a missed one
   * shows up as a frozen canvas.
   */
  private dirty = true;
  /**
   * Whether a frame is scheduled.
   *
   * The loop stops when there is nothing left to draw rather than running at
   * sixty frames a second deciding not to draw. That matters because this is
   * meant to sit in the background while something else works: a callback per
   * frame plus a composite of a canvas that has not changed measured 4.7
   * percent of a core with the window doing nothing at all.
   *
   * Everything that changes the picture calls `invalidate`, which starts it
   * again. A missed call shows up as a frozen canvas, which is why the input
   * paths and the idle behaviour are both checked in
   * scripts/idle-check.mjs.
   */
  private running = false;
  /** Frames drawn and frames skipped, so the saving can be measured. */
  drawn = 0;
  skipped = 0;
  /**
   * Camera as of the frame on screen.
   *
   * Compared against this rather than against the camera at the top of the
   * current frame: a drag moves the camera between frames, so by the time the
   * frame runs the change has already happened and comparing with the start of
   * it finds nothing. Panning drew no frames at all.
   */
  private shownAt = { x: 0, y: 0, zoom: 0 };
  private lastFrame = performance.now();
  private observer: ResizeObserver;
  private dragging = false;
  /** Set on pointerdown, cleared once the pointer has moved: a drag must not
   *  also count as a click on whatever was under the cursor. */
  private moved = false;
  private hovered: FileNode | null = null;
  /** Path under the pointer, header or body; see `onHover`. */
  private hoverPath: string | null = null;

  /** Called when a panel header is clicked. */
  onOpenFile: ((path: string) => void) | null = null;
  /** Called on right click, with the file under the pointer if there was one. */
  onContextMenu: ((at: { x: number; y: number; path: string | null }) => void) | null = null;

  private fill = 0;
  private frameMs = 16.7;
  stats: CanvasStats = {
    files: 0, totalLines: 0, visibleFiles: 0, lod: 'structure', pxPerLine: 0,
    quads: 0, cpuMs: 0, frameMs: 0, vramMb: 0, fill: 0, indexing: 0, bands: '',
    settling: false,
  };

  /** Called after each frame so the chrome can render the status bar. */
  onStats: ((s: CanvasStats) => void) | null = null;
  /** The file under the pointer, for the breadcrumb in the status bar. Null
   *  when the pointer is over background. */
  onHover: ((path: string | null) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    this.pal = readPalette();
    const override = bandsFromQuery(location.search);
    if (override) setBands(override);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.attachInput();
    this.watchContext();
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);

    // Handle for scripts/shot.mjs, which captures one screenshot per level of
    // detail and runs the frame benchmark. Keeping it on the shipping object
    // means the thing measured is the thing that ships.
    (window as unknown as { __sanity: unknown }).__sanity = {
      app: this,
      zoomTo: (zoom: number) => {
        this.cam.zoom = zoom;
        if (this.layout) {
          this.cam.x = this.layout.root.w * 0.5;
          this.cam.y = this.layout.root.h * 0.35;
        }
        this.invalidate();
      },
      bench: (seconds = 12) => this.bench(seconds),
      relayout: () => {
        if (this.lastSource) this.open(this.lastSource);
      },
      // The layout as a pure function, for measuring it without going through
      // a scene: scripts/stability-check.mjs asks it the same question twice
      // with one file changed.
      computeLayout,
      // Decoded payloads, which is where the per-line widths live. The layout
      // needs them and the entries do not carry them.
      decoded: () => this.decoded,
      // The level-of-detail weights and their hand-over points. Exposed so a
      // measurement can hold the zoom still and switch representation, which
      // is the only way to compare two of them: changing the zoom changes how
      // much of a panel fills the screen and moves the numbers on its own.
      lodWeights,
      setBands,
      lodBands,
      // The recency curves, so a check can read what the renderer draws from
      // rather than restating them.
      flashAt,
      markAt,
      // Whether the open source has finished loading, so a check can wait for
      // the text rather than race it.
      ready: () => this.lastSource?.ready?.() ?? Promise.resolve(),
    };
  }

  private resize(): void {
    this.invalidate();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cam.vw = w;
    this.cam.vh = h;
    this.cam.dpr = dpr;
  }

  /** Replace the whole scene. Layout runs synchronously, texture upload is
   *  spread across frames so opening a large repo does not lock the window. */
  open(source: RepoSource, keepView = false): void {
    // Reusing the scene is the difference between a relayout being free and
    // costing what a first load costs; see Scene.relayout. Only possible when
    // the view is being kept, which is also the only time it matters.
    const reuse = keepView && this.scene !== null;
    this.invalidate();
    this.lastSource = source;
    if (!reuse) this.scene = null;
    this.hovered = null;
    this.decoded.clear();

    // Decode first: the layout needs each file's line widths to work out how
    // many screen rows it takes once its long lines wrap, and wrapping is what
    // decides a panel's height.
    for (const e of source.entries) {
      const buf = source.payload(e.path);
      if (buf) this.decoded.set(e.path, decodeFile(buf));
    }

    const t0 = performance.now();
    // The canvas takes the window's proportions, so fitting it leaves no
    // screen unused; see rootAspect.
    this.layout = computeLayout(
      source.entries.map((e) => ({ ...e, lineCols: this.decoded.get(e.path)?.lineCols })),
      { w: this.cam.vw, h: this.cam.vh },
    );
    const st = layoutStats(this.layout);
    this.fill = st.fill;
    // Logged rather than hidden: fill, overlaps and off-grid edges are the
    // three numbers that say whether the layout is doing its job, and they
    // are what scripts/layout-check.mjs asserts on.
    console.log(
      `layout: fill ${(st.fill * 100).toFixed(1)}% · aspect ${st.aspect.toFixed(2)} · ` +
      `${st.dirCount} dirs · misfits ${st.misfits} · unusable ${st.unusable} · ` +
      `overflowing ${st.overflowing} · hidden ${st.hiddenStubs} · ` +
      `escapes ${st.escapes} · ` +
      `overlaps ${st.overlaps} · ` +
      `offgrid ${st.offGrid} · mean aspect ${st.meanAspect.toFixed(2)} · ` +
      `mean cols ${st.meanCols.toFixed(1)} · ` +
      `bloat p95 ${st.bloatP95.toFixed(2)} · bloat max ${st.bloatMax.toFixed(2)} · ` +
      `passes ${passesUsed} · ${(performance.now() - t0).toFixed(0)} ms` +
      (st.overlaps > 0
        ? ` · worst ${st.worstOverlap.path} ${st.worstOverlap.children} kids in ` +
          `${st.worstOverlap.cellsW}x${st.worstOverlap.cellsH} cells`
        : ''),
    );

    if (reuse && this.scene) {
      // Only the panels whose texture content actually changed come back, and
      // on the common edit that is none of them. A relayout while someone is
      // working must not move the view either, so the camera keeps its world
      // coordinates; issue #8 covers anchoring on a file.
      this.pending = this.scene.relayout(this.layout);
    } else {
      // Every panel settles in as it arrives, staggered outward from the
      // centre. That is the load animation.
      this.scene = new Scene(this.gl, this.layout, source.text, this.pal);
      this.scene.tintLanguages = this.languageTint;
      // Pictures, when the source can hand their bytes over. Held by the
      // scene because it knows what is on screen and at what size, and it
      // wakes the loop when one arrives: the loop parks when nothing moves.
      if (source.imageBytes) {
        this.scene.media = new MediaTextures(
          this.gl,
          source.imageBytes,
          () => this.invalidate(),
        );
      }
      this.pending = this.layout.files.map((f) => f.path);
      this.fit();
    }
    this.uploaded = 0;
  }

  /**
   * Apply a batch of new file contents, and say whether the geometry moved.
   *
   * Per file there are three cases, and telling them apart is this method's
   * whole job:
   *
   *   fits          rewrite one texture layer and play the change in place.
   *                 A fraction of a millisecond, every other panel untouched.
   *   outgrew it    the panel cannot hold the new content, so the treemap has
   *                 to divide the canvas again. The change is *deferred* and
   *                 replayed once the new geometry is in, so it still shows.
   *   new file      no panel yet; after the relayout it arrives marked as
   *                 added in full, and glowing.
   *
   * The middle case is why this exists. It used to be decided in the source,
   * which had no way to replay anything, so a relayout swallowed the signal
   * whole: measured on a real project, inserting eight lines into a 2263 line
   * file, and even an edit that added four characters to one wrapped line,
   * both went through the relayout path and showed nothing at all. Which is
   * the opposite of the point: the changes that restructure a project are the
   * ones worth seeing.
   *
   * `relayout` is a callback because only the source can produce the new file
   * index. It is called at most once per batch, however many files moved.
   */
  async applyBatch(
    fresh: Iterable<[string, FileData]>,
    removed: string[],
    relayout: () => Promise<void>,
    warm = true,
  ): Promise<boolean> {
    const deferred: [string, FileData][] = [];
    const created: string[] = [];

    for (const [path, data] of fresh) {
      if (!this.scene?.has(path)) {
        created.push(path);
        continue;
      }
      if (!this.fitsInPlace(path, data)) {
        deferred.push([path, data]);
        continue;
      }
      this.touch(path, data, warm);
    }

    const structural = created.length > 0 || deferred.length > 0 || removed.length > 0;
    if (!structural) return false;

    await relayout();
    // The scene kept the version on screen through the relayout, so the diff
    // these produce is the same one an in-place update would have made.
    for (const [path, data] of deferred) this.touch(path, data, warm);
    if (warm) this.scene?.markCreated(created);
    this.invalidate();
    return true;
  }

  /**
   * Re-lay out the current source without moving the view.
   *
   * Used when a watched file no longer fits its panel, or when a file
   * appeared or disappeared: the geometry has to be recomputed, but the
   * recency glow and the camera should survive it.
   */
  relayout(source?: RepoSource): void {
    const use = source ?? this.lastSource;
    if (use) this.open(use, true);
  }

  /**
   * Whether the picture is still changing on its own.
   *
   * Live rather than read off the last frame's stats, because the moment that
   * matters is right after `open`, when no frame has run yet and the stats
   * still describe the previous scene. Three sources: panels still arriving,
   * panels still settling into place, and the camera still flying.
   *
   * This is also the signal an adaptive frame rate needs: a settled canvas
   * that nobody is touching has nothing to redraw.
   */
  settling(): boolean {
    return (
      this.pending.length > 0
      || (this.scene?.animating ?? false)
      || (this.scene?.changing ?? false)
      || this.cam.flying
    );
  }

  /** Files that differ from the baseline, as the scene has them. */
  changedCount(): number {
    return this.scene?.changedCount() ?? 0;
  }

  /** Files inside their change window: flashing, or still marked. Counted
   *  apart from the marked ones because a file can be inside the window with
   *  nothing marked, which is what a deletion at the end of a file leaves. */
  recentCount(): number {
    return this.scene?.recentCount() ?? 0;
  }

  /**
   * Whether a file still fits the panel it has, so the caller can update in
   * place instead of relaying out the whole project.
   */
  fitsInPlace(path: string, data: FileData): boolean {
    return this.scene?.fits(path, data) ?? false;
  }

  /** Fit the whole project. Animated unless asked otherwise. */
  /** Last opened source, so a measurement script can re-lay it out. */
  lastSource: RepoSource | null = null;

  fit(seconds = 0.45): void {
    if (!this.layout) return;
    this.invalidate();
    if (seconds <= 0) this.cam.fit(...this.layout.bounds);
    else this.cam.flyToRect(...this.layout.bounds, seconds);
  }

  /** Fit one file, at a zoom where its text is readable if it will fit. */
  /**
   * Filter by a typed query: matches stay lit, everything else dims.
   *
   * Returns the matches, best first, so the chrome can say how many there are
   * and the camera can be sent to one. The scene is told about the set rather
   * than the query, because matching is a question about paths and belongs in
   * a pure function with tests, not in the renderer.
   */
  search(query: string): Ranked[] {
    const q = query.trim();
    if (!this.layout || !this.scene) return [];
    this.current = null;
    if (!q) {
      this.matches = [];
      this.hitFiles = [];
      this.findToken++;
      this.scene.setHits(new Map(), null);
      this.scene.setSearch(null);
      this.invalidate();
      return [];
    }
    this.matches = rank(q, this.layout.files.map((f) => f.path));
    this.applyLit();
    return this.matches;
  }

  /**
   * Ask the source to search the text of every file.
   *
   * Separate from `search` and asynchronous because it is a different kind of
   * question: a path match is arithmetic on a list the frontend already has,
   * while a content hit means reading the repository. Measured in Rust on a
   * real project, 18.6 MB over 1062 files, that read and scan is 7 to 8
   * milliseconds, so it runs per keystroke behind a short debounce rather
   * than on a button.
   *
   * The stale-result guard matters more than it looks: a slow query typed one
   * character further arrives after the fast one, and without the check the
   * canvas would end up lit for a query nobody is looking at.
   */
  async findText(query: string, capPerFile = HITS_PER_FILE): Promise<ContentResult> {
    const q = query.trim();
    const token = ++this.findToken;
    if (!this.lastSource?.find || q.length < MIN_CONTENT_QUERY) {
      this.hitFiles = [];
      this.applyLit();
      return { files: 0, shown: 0, total: 0, stale: false };
    }
    let files: FileHits[] = [];
    try {
      files = await this.lastSource.find(q, capPerFile);
    } catch {
      files = [];
    }
    if (token !== this.findToken) return { files: 0, shown: 0, total: 0, stale: true };
    // In the order the panels are laid out in, so stepping through hits walks
    // the project rather than jumping by whatever order the backend produced.
    const order = new Map(this.layout?.files.map((f, i) => [f.path, i]) ?? []);
    files.sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9));
    this.hitFiles = files;
    this.applyLit();
    const { shown, total } = countHits(files);
    return { files: files.length, shown, total, stale: false };
  }

  /** Hits of the current query, flattened in the order they are stepped. */
  get hits(): { path: string; line: number; col: number }[] {
    const out: { path: string; line: number; col: number }[] = [];
    for (const f of this.hitFiles) {
      for (let k = 0; k < f.at.length; k += 2) {
        out.push({ path: f.path, line: f.at[k], col: f.at[k + 1] });
      }
    }
    return out;
  }

  /**
   * Everything the current query found, in the order Enter walks it: the files
   * whose names match, then the lines whose text matches.
   *
   * Names first because a name is the stronger claim. Typing "scene" in a
   * project with a scene.ts means that file, and flying to the sixth mention
   * of the word in a comment somewhere else is not the answer, however
   * correct it is. The text hits are right behind it, so the same keystroke
   * keeps going.
   */
  get steps(): { path: string; line: number | null }[] {
    const out: { path: string; line: number | null }[] = [];
    for (const m of this.matches) out.push({ path: m.path, line: null });
    for (const h of this.hits) out.push({ path: h.path, line: h.line });
    return out;
  }

  /**
   * Fly to the nth thing the query found, wrapping around.
   *
   * Wrapping rather than stopping at the end, because with a common word there
   * are hundreds of hits and stepping through them in a loop is how you read
   * them.
   */
  focusMatch(index: number): string | null {
    const steps = this.steps;
    if (steps.length === 0) return null;
    const at = ((index % steps.length) + steps.length) % steps.length;
    const step = steps[at];
    if (step.line === null) {
      this.current = null;
      this.applyLit();
      this.focusFile(step.path);
    } else {
      this.current = { path: step.path, line: step.line };
      this.applyLit();
      this.focusLine(step.path, step.line);
    }
    return step.path;
  }

  /**
   * Put one line of one file in the middle of the window, at a zoom where it
   * can be read.
   *
   * Flying to the panel and leaving the reader to find the line is what this
   * did first, and in a file of two thousand lines that is not an answer. The
   * zoom is the one where glyphs are fully up, so what arrives is text.
   */
  focusLine(path: string, line: number): void {
    const rect = this.scene?.lineRect(path, line);
    if (!rect) {
      this.focusFile(path);
      return;
    }
    const [x, y, w] = rect;
    // A window of lines around it, so the hit has context rather than filling
    // the screen on its own.
    const half = metrics.lineHeight * LINE_CONTEXT;
    this.invalidate();
    this.cam.flyToRect(x, y - half, x + w, y + metrics.lineHeight + half, 0.5);
  }

  /** Matches of the current query, best first. */
  private matches: Ranked[] = [];
  /** Files with content hits, in layout order. */
  private hitFiles: FileHits[] = [];
  /** The hit the camera was last sent to. */
  private current: { path: string; line: number } | null = null;
  /** Guards against a slow query landing after a newer one. */
  private findToken = 0;

  /** Hand the scene what is lit: path matches, files with hits, and where the
   *  camera is. */
  private applyLit(): void {
    if (!this.scene) return;
    const lit = new Set<string>();
    for (const m of this.matches) lit.add(m.path);
    const hits = new Map<string, number[]>();
    for (const f of this.hitFiles) {
      lit.add(f.path);
      hits.set(f.path, f.at);
    }
    this.scene.setHits(hits, this.current);
    this.scene.setSearch(this.matches.length > 0 || this.hitFiles.length > 0 ? lit : null);
    this.invalidate();
  }

  focusFile(path: string, seconds = 0.5): void {
    const node = this.layout?.files.find((f) => f.path === path);
    if (!node) return;
    this.invalidate();
    // A little margin so the panel does not touch the window edge.
    const pad = metrics.lineHeight * 2;
    this.cam.flyToRect(
      node.x - pad, node.y - pad, node.x + node.w + pad, node.y + node.h + pad, seconds,
    );
  }

  /** The panel under a screen position, header or body. */
  fileAt(sx: number, sy: number): FileNode | null {
    if (!this.layout) return null;
    const [wx, wy] = this.cam.screenToWorld(sx, sy);
    for (const f of this.layout.files) {
      if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h) return f;
    }
    return null;
  }

  /**
   * Survive a lost WebGL context.
   *
   * A driver can take the context away at any time: a GPU reset, a laptop
   * switching cards, a Windows TDR under a large window. Everything on the
   * GPU is gone with it, which on a canvas that draws a whole repository from
   * textures means panels that are simply empty, with nothing saying why. The
   * browser only attempts to restore a context if the loss event is cancelled,
   * which is what the first listener is for; the second rebuilds the scene
   * from the source it was opened from, since every texture, buffer and
   * program has to be made again.
   */
  private watchContext(): void {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.onContext?.(true);
      console.warn('webgl context lost, waiting for it to come back');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContext?.(false);
      console.warn('webgl context restored, rebuilding the scene');
      this.scene = null;
      this.resize();
      if (this.lastSource) this.open(this.lastSource, true);
      this.running = true;
      this.raf = requestAnimationFrame(this.frame);
    });
  }

  /** True while the GPU has taken the context away. */
  contextLost = false;
  /** Told when that changes, so the status bar can say so rather than leaving
   *  an empty canvas to be read as a bug in the layout. */
  onContext: ((lost: boolean) => void) | null = null;

  /**
   * What this machine is drawing with, for a report from a screen I do not
   * have. Everything here has been the cause of a rendering difference at
   * some point: the ANGLE backend, the device pixel ratio, the size of the
   * drawing buffer, and the limits a layered texture has to fit inside.
   *
   * Reached from the console as `__sanity.app.diagnostics()`. It had a button
   * in the View menu for a while, which is one more thing in a menu than a
   * once-in-a-while question is worth.
   */
  diagnostics(): string {
    const gl = this.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const lines = [
      `sanity ${location.href}`,
      `renderer   ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'}`,
      `vendor     ${dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown'}`,
      `window     ${window.innerWidth}x${window.innerHeight} css at dpr ${window.devicePixelRatio}`,
      `drawing    ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      `limits     texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}, `
        + `array layers ${gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)}, `
        + `units ${gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)}, `
        + `uniform vectors ${gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)}`,
      `context    ${this.contextLost ? 'LOST' : 'ok'}`,
      `scene      ${this.stats.files} files, ${this.stats.visibleFiles} visible, `
        + `${this.stats.lod} at ${this.stats.pxPerLine.toFixed(2)} px/line`,
      `frame      ${this.stats.quads} quads, ${this.stats.cpuMs.toFixed(2)} ms cpu, `
        + `${this.stats.frameMs.toFixed(1)} ms, ${this.stats.vramMb.toFixed(0)} MB`,
    ];
    return lines.join('\n');
  }

  /** Redraw, starting the loop again if it had stopped. */
  invalidate(): void {
    this.dirty = true;
    if (!this.running) {
      this.running = true;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  /**
   * Colour the outermost zoom by language family, or stop doing that.
   *
   * A method rather than a public field on the scene: the scene is rebuilt
   * whenever a project opens, so the switch has to be held here and applied
   * to whatever scene is current.
   */
  setLanguageTint(on: boolean): void {
    this.languageTint = on;
    if (this.scene) this.scene.tintLanguages = on;
    this.invalidate();
  }

  /** Re-read the palette from CSS and push it into the scene. */
  refreshTheme(): void {
    this.invalidate();
    this.pal = readPalette();
    this.scene?.setPalette(this.pal);
  }

  /**
   * Mark a file as changed on disk; drives the recency glow.
   *
   * `warm` is false when only the change state moved, not the file: see
   * Scene.touch.
   */
  touch(path: string, data?: FileData, warm = true): void {
    this.invalidate();
    this.scene?.touch(path, data, warm);
  }

  /**
   * The panel whose header is under a screen position, if any.
   *
   * Linear over the visible files. At the zoom where a header can be hit it is
   * at least a few pixels tall, so only a handful of panels qualify, and a
   * spatial index would be machinery for a case that cannot get hot.
   */
  private headerAt(sx: number, sy: number): FileNode | null {
    if (!this.layout) return null;
    // A header shorter than this cannot be aimed at, so treat it as absent
    // rather than letting a stray click open a file.
    if (metrics.titleHeight * this.cam.zoom < 6) return null;
    const [wx, wy] = this.cam.screenToWorld(sx, sy);
    for (const f of this.layout.files) {
      if (f.stub) continue;
      if (wx < f.x || wx > f.x + f.w) continue;
      if (wy < f.y || wy > f.y + metrics.titleHeight) continue;
      return f;
    }
    return null;
  }

  private attachInput(): void {
    const c = this.canvas;
    const local = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.moved = false;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointerup', (e) => {
      const wasDrag = this.moved;
      this.dragging = false;
      c.releasePointerCapture(e.pointerId);
      if (wasDrag) return;
      const hit = this.headerAt(...local(e));
      if (hit) this.onOpenFile?.(hit.path);
    });
    c.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        // A pointer that barely twitches is still a click, not a drag.
        if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.moved = true;
        this.cam.panBy(e.movementX, e.movementY);
        this.invalidate();
        return;
      }
      const hit = this.headerAt(...local(e));
      if (hit !== this.hovered) {
        this.invalidate();
        this.hovered = hit;
        if (this.scene) this.scene.hoveredPath = hit?.path ?? null;
        c.style.cursor = hit ? 'pointer' : '';
      }
      // The panel body, not just its header: the breadcrumb answers "what am
      // I looking at", and at the outer zoom levels the header is a hairline
      // while the panel is the size of a stamp. Directory labels vanish out
      // there too, so this is the only thing that still says where you are.
      const over = this.fileAt(...local(e));
      if (over?.path !== this.hoverPath) {
        this.hoverPath = over?.path ?? null;
        this.onHover?.(this.hoverPath);
      }
    });
    c.addEventListener('pointerleave', () => {
      this.invalidate();
      this.hovered = null;
      if (this.scene) this.scene.hoveredPath = null;
      c.style.cursor = '';
      if (this.hoverPath !== null) {
        this.hoverPath = null;
        this.onHover?.(null);
      }
    });

    // Double click fits: on a panel, that panel; on the background, the whole
    // project. The single-click handler already returns early on a drag, and a
    // double click also fires two pointerups, so a header double click opens
    // the file and then fits it, which is the useful reading of both.
    c.addEventListener('dblclick', (e) => {
      const [sx, sy] = [
        e.clientX - c.getBoundingClientRect().left,
        e.clientY - c.getBoundingClientRect().top,
      ];
      const hit = this.fileAt(sx, sy);
      if (hit) this.focusFile(hit.path);
      else this.fit();
    });

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      this.onContextMenu?.({
        x: e.clientX,
        y: e.clientY,
        path: this.fileAt(sx, sy)?.path ?? null,
      });
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
        this.invalidate();
      },
      { passive: false },
    );
  }

  private uploadBudget(): void {
    if (!this.scene || !this.layout || this.pending.length === 0) return;
    const t0 = performance.now();
    const byPath = new Map(this.layout.files.map((f) => [f.path, f]));
    while (this.pending.length > 0 && performance.now() - t0 < UPLOAD_BUDGET_MS) {
      const path = this.pending.pop()!;
      const node = byPath.get(path);
      const data = this.decoded.get(path);
      // `ensure` rather than `addFile`: after a relayout the path may already
      // be in the scene and only need its texture written again.
      if (node && data) this.scene.ensure(node, data);
      this.uploaded++;
    }
    this.scene.finalizeTextures();
  }

  private frame = (now: number): void => {
    this.cam.update(now);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.frameMs = (now - this.lastFrame) * 0.15 + this.frameMs * 0.85;
    this.lastFrame = now;

    const uploaded = this.pending.length;
    this.uploadBudget();

    // Advance first, draw second, and only draw if that changed the picture.
    // A fading glow ticks for ninety seconds and is worth drawing thirty
    // times; the difference used to be 5400 frames.
    const state = this.scene?.advance(dt) ?? { redraw: false, ticking: false };

    // Everything that can change the picture without anyone asking.
    if (
      this.dirty
      || uploaded !== this.pending.length
      || this.cam.x !== this.shownAt.x
      || this.cam.y !== this.shownAt.y
      || this.cam.zoom !== this.shownAt.zoom
      || state.redraw
    ) {
      this.invalidate();
    }

    if (!this.dirty) {
      this.skipped++;
      if (state.ticking) {
        // Still in flight, so keep asking. A decay measured in wall-clock time
        // needs a clock, and stopping here froze a ninety second fade at
        // whatever it had reached: the loop parked, no frames, no dt.
        this.raf = requestAnimationFrame(this.frame);
        return;
      }
      // Nothing to draw and nothing that will change on its own, so the loop
      // stops here. `invalidate` starts it again.
      this.running = false;
      return;
    }
    this.dirty = false;
    this.drawn++;
    this.shownAt.x = this.cam.x;
    this.shownAt.y = this.cam.y;
    this.shownAt.zoom = this.cam.zoom;

    const t0 = performance.now();
    if (this.scene && this.layout) {
      this.scene.render(this.cam, dt);
      const s = this.scene.stats;
      const tex = this.scene.textures.stats();
      this.stats = {
        files: this.layout.files.length,
        totalLines: this.layout.totalLines,
        visibleFiles: s.visibleFiles,
        lod: lodName(s.pxPerLine),
        pxPerLine: s.pxPerLine,
        quads: s.overviewQuads + s.spanQuads + s.glyphQuads + s.rectQuads,
        cpuMs: performance.now() - t0,
        frameMs: this.frameMs,
        // Code textures and pictures together: two budgets in one number,
        // because what matters is what the process holds.
        vramMb: (tex.bytes + (this.scene.media?.stats().bytes ?? 0)) / 1048576,
        fill: this.fill,
        indexing: this.pending.length ? this.uploaded / this.layout.files.length : 0,
        bands:
          `${lodBands.tokensFrom}-${lodBands.tokensTo}/` +
          `${lodBands.textFrom}-${lodBands.textTo}`,
        settling: this.settling(),
      };
      this.onStats?.(this.stats);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * Render one frame at an arbitrary size and hand back a PNG.
   *
   * A screenshot of the window is capped at the window: a thousand panels in
   * 1440 pixels means a file is a line and a line is less than a pixel. This
   * renders the same scene into a bigger frame instead, which is not an
   * upscale of that picture but a different one, because every level of detail
   * here follows from pixels per line. At 3840 across, a panel that was eight
   * pixels wide on screen is twenty and has its tokens in it.
   *
   * Done by lending the camera a viewport rather than by rendering to a
   * texture: the whole pipeline already takes its size from the camera and
   * the drawing buffer, so there is nothing to special-case. The loop is
   * stopped for the duration, since it would otherwise draw the window with
   * the export's camera, and the state is put back in `finally` whatever
   * happens, because leaving the camera on a 4K viewport would leave the
   * window showing a corner of itself.
   */
  async renderToBlob(req: ImageRequest): Promise<Blob> {
    if (!this.scene || !this.layout) throw new Error('nothing to render');
    const [maxW, maxH] = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const boxW = Math.max(64, Math.min(req.width, maxW, MAX_IMAGE_EDGE));
    const boxH = Math.max(64, Math.min(req.height, maxH, MAX_IMAGE_EDGE));

    // What to frame, exactly: the project's own bounds or what the window
    // shows. No margin either way, and the image takes the rect's aspect
    // instead of the rect being widened to the image's, since a fixed 16:9
    // frame around a project that is not 16:9 is a border on two sides of it.
    const [rx0, ry0, rx1, ry1] =
      req.region === 'project' ? this.layout.bounds : this.cam.visibleRect();
    const cx = (rx0 + rx1) / 2;
    const cy = (ry0 + ry1) / 2;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    const scale = Math.min(boxW / rw, boxH / rh);
    const width = Math.max(64, Math.round(rw * scale));
    const height = Math.max(64, Math.round(rh * scale));

    const keep = { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom };
    cancelAnimationFrame(this.raf);
    this.running = false;

    try {
      this.canvas.width = width;
      this.canvas.height = height;
      this.cam.vw = width;
      this.cam.vh = height;
      // One world unit per image pixel at zoom 1, so the atlas is asked for
      // the level this size of text actually needs.
      this.cam.dpr = 1;
      this.cam.stop();
      this.cam.zoom = scale;
      this.cam.x = cx;
      this.cam.y = cy;

      // Panels arriving, panels settling and text being fetched all need
      // frames, so this draws until the picture is done rather than once.
      // Two settled frames rather than one: at this size files that were bars
      // on screen are readable, and their text is requested *by* the frame
      // that needs it, so the first pass is what asks for it and the second
      // is the one that has it.
      const done = () => this.pending.length === 0 && !this.settling();
      let last = performance.now();
      let stable = 0;
      for (let i = 0; i < 600 && stable < 2; i++) {
        this.uploadBudget();
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        this.scene.advance(dt);
        this.scene.render(this.cam, dt);
        await this.lastSource?.ready?.();
        // And for the pictures this frame asked for at this size: an export
        // that wrote the placeholders would be the one picture of the project
        // that is wrong.
        await this.scene.media?.settled();
        if (done()) {
          stable++;
          continue;
        }
        stable = 0;
        await new Promise((r) => requestAnimationFrame(r));
      }

      // preserveDrawingBuffer is on, see renderer/gl.ts, so the frame just
      // drawn is still there to be read.
      const blob = await new Promise<Blob | null>((resolve) => {
        this.canvas.toBlob((b) => resolve(b), 'image/png');
      });
      if (blob && blob.size > 0) return blob;
      // Some webviews hand back null for a canvas this size. A data URL is the
      // same encoder by a slower road, and slower is better than an export
      // that fails on one platform and works on the other.
      const url = this.canvas.toDataURL('image/png');
      const comma = url.indexOf(',');
      if (!url.startsWith('data:image/png') || comma < 0) {
        throw new Error('the image could not be encoded');
      }
      const raw = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      if (bytes.length === 0) throw new Error('the image came out empty');
      return new Blob([bytes], { type: 'image/png' });
    } finally {
      // resize() puts the canvas and the camera's viewport back from the
      // element's own size, which is the one thing that must not be guessed.
      this.resize();
      this.cam.x = keep.x;
      this.cam.y = keep.y;
      this.cam.zoom = keep.zoom;
      // Left false so `invalidate` schedules a frame: the loop was cancelled
      // above, and claiming it is running is how a canvas ends up frozen.
      this.running = false;
      this.invalidate();
    }
  }

  /** World-space line height, for anything outside that needs the scale. */
  get lineHeight(): number {
    return metrics.lineHeight;
  }

  /** Sweep from fully zoomed out to readable text and back, reporting the
   *  frame time distribution. Measured rather than eyeballed. */
  bench(seconds = 12): Promise<string> {
    return new Promise((resolve) => {
      const cpu: number[] = [];
      const wall: number[] = [];
      let seen = this.drawn;
      let last = 0;
      const t0 = performance.now();
      const fitZoom = this.layout
        ? Math.min(this.cam.vw / this.layout.root.w, this.cam.vh / this.layout.root.h)
        : 0.01;
      const step = () => {
        const t = (performance.now() - t0) / (seconds * 1000);
        if (t >= 1) {
          const pct = (xs: number[], q: number) => {
            const f = xs.slice().sort((a, b) => a - b);
            return f[Math.min(f.length - 1, Math.floor(f.length * q))];
          };
          const fmt = (xs: number[]) =>
            `median ${pct(xs, 0.5).toFixed(2)} p95 ${pct(xs, 0.95).toFixed(2)} ` +
            `p99 ${pct(xs, 0.99).toFixed(2)} max ${pct(xs, 1).toFixed(2)}`;
          const line =
            `bench over ${cpu.length} frames | cpu ms: ${fmt(cpu)} | frame ms: ${fmt(wall)}`;
          console.log(line);
          resolve(line);
          return;
        }
        const s = Math.sin(t * Math.PI);
        this.cam.zoom = fitZoom * (1 - s) + 1.6 * s;
        if (this.layout) {
          this.cam.x = this.layout.root.w * (0.15 + 0.7 * t);
          this.cam.y = this.layout.root.h * (0.2 + 0.6 * Math.sin(t * Math.PI * 2) ** 2);
        }
        // The loop draws on demand and parks when the picture holds still, and
        // whether it sees this camera move depends on which callback the
        // browser runs first. Without asking for the frame the benchmark
        // measured the last frame before it started, over and over: 480 frames
        // of identical numbers.
        this.invalidate();
        // Only frames that were actually drawn: a skipped frame keeps the
        // previous timings, and counting those turns any pause into a run of
        // whatever came before it.
        if (this.drawn !== seen) {
          seen = this.drawn;
          cpu.push(this.stats.cpuMs);
          // The gap since the frame before, raw. `stats.frameMs` is smoothed
          // over the last frames, so one long pause before the sweep starts
          // decays through thirty of its samples and shows up as a p99 that
          // never happened.
          const now = performance.now();
          if (last > 0) wall.push(now - last);
          last = now;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }
}
