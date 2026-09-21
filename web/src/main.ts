// Entry point for the renderer spike. Generates a synthetic repository, lays
// it out and drives the canvas. The Tauri backend will replace `synthRepo`
// with a real scan and keep everything below it untouched.

import { Camera } from './camera';
import { computeLayout, layoutStats } from './layout/tree';
import { synthRepo } from './data/synth';
import { decodeFile, type FileData } from './data/wire';
import { PseudoText } from './data/pseudotext';
import { Scene } from './renderer/scene';
import { createContext } from './renderer/gl';
import { Labels } from './labels';
import { css, lodThresholds, metrics, palette } from './tokens';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = params.get(k);
  return v === null ? d : Number(v);
};

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const progress = document.getElementById('progress') as HTMLDivElement;

const gl = createContext(canvas);
const cam = new Camera();

progress.textContent = 'generating repository...';

const repo = synthRepo({
  fileCount: num('files', 400),
  seed: num('seed', 7),
  medianLines: num('lines', 180),
  changedFraction: num('changed', 0.03),
});
const layoutStart = performance.now();
const layout = computeLayout(repo.entries);
const layoutMs = performance.now() - layoutStart;
{
  const st = layoutStats(layout);
  console.log(
    `layout: fill ${(st.fill * 100).toFixed(1)}% · aspect ${st.aspect.toFixed(2)} · ` +
    `${st.dirCount} dirs · overflow ${(st.overflow * 100).toFixed(2)}% · ` +
    `overlaps ${st.overlaps} · mean panel aspect ${st.meanAspect.toFixed(2)} · ` +
    `${layoutMs.toFixed(0)} ms`,
  );
}

const decoded = new Map<string, FileData>();
for (const [path, buf] of repo.payloads) decoded.set(path, decodeFile(buf));

const scene = new Scene(gl, layout, new PseudoText(decoded));
const labels = new Labels(overlay, layout);

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  cam.vw = w;
  cam.vh = h;
  cam.dpr = dpr;
}
const ro = new ResizeObserver(resize);
ro.observe(canvas);
resize();
cam.fit(...layout.bounds);

// Texture upload is spread across frames with a time budget. The same shape of
// loop will drive incremental updates from the watcher later.
const pending = [...layout.files];
let uploaded = 0;
function uploadBudget(ms: number): void {
  if (pending.length === 0) return;
  const t0 = performance.now();
  while (pending.length > 0 && performance.now() - t0 < ms) {
    const node = pending.pop()!;
    const data = decoded.get(node.path);
    if (data) scene.addFile(node, data);
    uploaded++;
  }
  scene.finalizeTextures();
  progress.textContent = pending.length
    ? `indexing ${uploaded} / ${layout.files.length}`
    : '';
  if (!pending.length) progress.style.opacity = '0';
}

// Input.
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging) cam.panBy(e.movementX, e.movementY);
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) {
      const r = canvas.getBoundingClientRect();
      cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
    }
  },
  { passive: false },
);

// A benchmark sweep: pans and zooms through the whole repo and reports the
// frame time distribution, so the performance claim is measured rather than
// eyeballed.
let bench: { cpu: number[]; wall: number[]; t: number } | null = null;
addEventListener('keydown', (e) => {
  if (e.key === 'f') cam.fit(...layout.bounds);
  if (e.key === 'b') bench = { cpu: [], wall: [], t: 0 };
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  uploadBudget(6);

  if (bench) {
    // Sweep from fully zoomed out to readable text and back, panning along.
    bench.t += dt / 12;
    if (bench.t >= 1) {
      const pct = (xs: number[], p: number) => {
        const f = xs.slice().sort((a, b) => a - b);
        return f[Math.min(f.length - 1, Math.floor(f.length * p))];
      };
      const fmt = (xs: number[]) =>
        `median ${pct(xs, 0.5).toFixed(2)} p95 ${pct(xs, 0.95).toFixed(2)} ` +
        `p99 ${pct(xs, 0.99).toFixed(2)} max ${pct(xs, 1).toFixed(2)}`;
      console.log(
        `bench over ${bench.cpu.length} frames | cpu ms: ${fmt(bench.cpu)} | ` +
        `frame ms: ${fmt(bench.wall)}`,
      );
      bench = null;
    } else {
      const s = Math.sin(bench.t * Math.PI);
      const fitZoom = Math.min(cam.vw / layout.root.w, cam.vh / layout.root.h);
      cam.zoom = fitZoom * (1 - s) + 1.6 * s;
      cam.x = layout.root.w * (0.15 + 0.7 * bench.t);
      cam.y = layout.root.h * (0.2 + 0.6 * Math.sin(bench.t * Math.PI * 2) ** 2);
    }
  }

  const t0 = performance.now();
  scene.render(cam, dt);
  labels.update(cam);
  const total = performance.now() - t0;
  if (bench) {
    bench.cpu.push(total);
    bench.wall.push(dt * 1000);
  }

  const s = scene.stats;
  const tex = scene.textures.stats();
  const lod =
    s.pxPerLine >= lodThresholds.glyphs ? 'text'
      : s.pxPerLine >= lodThresholds.texture ? 'tokens'
        : s.pxPerLine >= lodThresholds.block ? 'overview'
          : 'structure';
  hud.innerHTML = [
    `${layout.files.length} files &middot; ${layout.totalLines.toLocaleString('en-US')} lines`,
    `${s.visibleFiles} visible &middot; lod <b>${lod}</b> &middot; ${s.pxPerLine.toFixed(2)} px/line`,
    `quads: ${s.overviewQuads} ov &middot; ${s.spanQuads} tok &middot; ${s.glyphQuads} glyph &middot; ${s.rectQuads} rect`,
    `cpu ${total.toFixed(2)} ms &middot; vram ${(tex.bytes / 1048576).toFixed(0)} MB / ${tex.layers} layers`,
    `<span class="hint">drag to pan &middot; wheel to zoom &middot; f fit &middot; b benchmark</span>`,
  ].join('<br>');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handle for the screenshot and benchmark driver in scripts/shot.mjs. Keeping
// it here rather than in a test harness means the thing being measured is
// exactly the thing that ships.
interface SanityHandle {
  cam: Camera;
  scene: Scene;
  bounds: [number, number, number, number];
  /** Zoom to a level of detail while staying centred on the same content. */
  zoomTo(zoom: number): void;
}
(window as unknown as { __sanity: SanityHandle }).__sanity = {
  cam,
  scene,
  bounds: layout.bounds,
  zoomTo(zoom: number) {
    cam.zoom = zoom;
    cam.x = layout.root.w * 0.5;
    cam.y = layout.root.h * 0.35;
  },
};

document.body.style.background = css(palette.bg);
document.documentElement.style.setProperty('--ink', css(palette.ink));
document.documentElement.style.setProperty('--dim', css(palette.inkDim));
document.documentElement.style.setProperty('--line-height', `${metrics.lineHeight}px`);
