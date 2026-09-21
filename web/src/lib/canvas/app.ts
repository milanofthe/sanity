// Lifecycle of the canvas: context, camera, scene, input, frame loop.
//
// Owns everything that is not Svelte. The chrome talks to it through a small
// surface (open a repo, switch theme, read stats) and never touches WebGL, and
// this file never touches the DOM outside its own canvas and label host.

import { Camera } from '$lib/canvas/camera';
import {
  computeLayout, layoutStats, passesUsed, type FileEntry, type FileNode, type Layout,
} from '$lib/canvas/layout/tree';
import { decodeFile, type FileData } from '$lib/canvas/data/wire';
import { createContext } from '$lib/canvas/renderer/gl';
import { Scene, type TextSource } from '$lib/canvas/renderer/scene';
import { metrics } from '$lib/metrics';
import { bandsFromQuery, lodBands, lodName, setBands, type LodName } from '$lib/canvas/lod';
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
}

/** What the chrome has to supply to open a repository. */
export interface RepoSource {
  entries: FileEntry[];
  /** Payload per path, in the wire format. */
  payload(path: string): ArrayBuffer | undefined;
  text: TextSource;
}

const UPLOAD_BUDGET_MS = 6;

export class CanvasApp {
  readonly cam = new Camera();
  private gl: WebGL2RenderingContext;
  private scene: Scene | null = null;
  private layout: Layout | null = null;
  private pal: Palette;

  private pending: string[] = [];
  private decoded = new Map<string, FileData>();
  private uploaded = 0;

  private raf = 0;
  private lastFrame = performance.now();
  private observer: ResizeObserver;
  private dragging = false;
  /** Set on pointerdown, cleared once the pointer has moved: a drag must not
   *  also count as a click on whatever was under the cursor. */
  private moved = false;
  private hovered: FileNode | null = null;

  /** Called when a panel header is clicked. */
  onOpenFile: ((path: string) => void) | null = null;
  /** Called on right click, with the file under the pointer if there was one. */
  onContextMenu: ((at: { x: number; y: number; path: string | null }) => void) | null = null;

  private fill = 0;
  private frameMs = 16.7;
  stats: CanvasStats = {
    files: 0, totalLines: 0, visibleFiles: 0, lod: 'structure', pxPerLine: 0,
    quads: 0, cpuMs: 0, frameMs: 0, vramMb: 0, fill: 0, indexing: 0, bands: '',
  };

  /** Called after each frame so the chrome can render the status bar. */
  onStats: ((s: CanvasStats) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    this.pal = readPalette();
    const override = bandsFromQuery(location.search);
    if (override) setBands(override);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.attachInput();
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
      },
      bench: (seconds = 12) => this.bench(seconds),
    };
  }

  private resize(): void {
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
  open(source: RepoSource): void {
    this.scene = null;
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
    this.layout = computeLayout(
      source.entries.map((e) => ({ ...e, lineCols: this.decoded.get(e.path)?.lineCols })),
    );
    const st = layoutStats(this.layout);
    this.fill = st.fill;
    // Logged rather than hidden: fill, overlaps and off-grid edges are the
    // three numbers that say whether the layout is doing its job, and they
    // are what scripts/layout-check.mjs asserts on.
    console.log(
      `layout: fill ${(st.fill * 100).toFixed(1)}% · aspect ${st.aspect.toFixed(2)} · ` +
      `${st.dirCount} dirs · misfits ${st.misfits} · unusable ${st.unusable} · ` +
      `overflowing ${st.overflowing} · ` +
      `overlaps ${st.overlaps} · ` +
      `offgrid ${st.offGrid} · mean aspect ${st.meanAspect.toFixed(2)} · ` +
      `mean cols ${st.meanCols.toFixed(1)} · passes ${passesUsed} · ${(performance.now() - t0).toFixed(0)} ms` +
      (st.overlaps > 0
        ? ` · worst ${st.worstOverlap.path} ${st.worstOverlap.children} kids in ` +
          `${st.worstOverlap.cellsW}x${st.worstOverlap.cellsH} cells`
        : ''),
    );

    this.scene = new Scene(this.gl, this.layout, source.text, this.pal);
    this.pending = this.layout.files.map((f) => f.path);
    this.uploaded = 0;
    this.fit();
  }

  /** Fit the whole project. Animated unless asked otherwise. */
  fit(seconds = 0.45): void {
    if (!this.layout) return;
    if (seconds <= 0) this.cam.fit(...this.layout.bounds);
    else this.cam.flyToRect(...this.layout.bounds, seconds);
  }

  /** Fit one file, at a zoom where its text is readable if it will fit. */
  focusFile(path: string, seconds = 0.5): void {
    const node = this.layout?.files.find((f) => f.path === path);
    if (!node) return;
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

  /** Re-read the palette from CSS and push it into the scene. */
  refreshTheme(): void {
    this.pal = readPalette();
    this.scene?.setPalette(this.pal);
  }

  /** Mark a file as changed on disk; drives the recency glow. */
  touch(path: string, data?: FileData): void {
    this.scene?.touch(path, data);
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
        return;
      }
      const hit = this.headerAt(...local(e));
      if (hit !== this.hovered) {
        this.hovered = hit;
        if (this.scene) this.scene.hoveredPath = hit?.path ?? null;
        c.style.cursor = hit ? 'pointer' : '';
      }
    });
    c.addEventListener('pointerleave', () => {
      this.hovered = null;
      if (this.scene) this.scene.hoveredPath = null;
      c.style.cursor = '';
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
      if (node && data) this.scene.addFile(node, data);
      this.uploaded++;
    }
    this.scene.finalizeTextures();
  }

  private frame = (now: number): void => {
    this.cam.update(now);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.frameMs = (now - this.lastFrame) * 0.15 + this.frameMs * 0.85;
    this.lastFrame = now;

    this.uploadBudget();

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
        vramMb: tex.bytes / 1048576,
        fill: this.fill,
        indexing: this.pending.length ? this.uploaded / this.layout.files.length : 0,
        bands:
          `${lodBands.tokensFrom}-${lodBands.tokensTo}/` +
          `${lodBands.textFrom}-${lodBands.textTo}`,
      };
      this.onStats?.(this.stats);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

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
        cpu.push(this.stats.cpuMs);
        wall.push(this.stats.frameMs);
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
