// Opens a real repository through the Tauri backend.
//
// The scan result comes back as JSON because it is small and structured. The
// payloads come back as one raw byte blob with a JSON index in front of it,
// because the default IPC would base64 several megabytes of typed arrays and
// copy them twice. See `repo_payloads` in src-tauri/src/lib.rs.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { CanvasApp } from '$lib/canvas/app';
import type { FileHits } from '$lib/canvas/content';
import { expandLines } from '$lib/canvas/data/tabs';
import type { MediaSize } from '$lib/canvas/layout/tree';
import { decodeFile, type FileData } from '$lib/canvas/data/wire';
import type { TextSource } from '$lib/canvas/renderer/scene';
import { project, type FileGroup } from '$lib/state/project.svelte';
import { unpack } from './payload.ts';
import { THUMB_MAX, unpackThumbs } from './thumbs.ts';

/** True inside the Tauri window, false in a plain browser tab. */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ScanFile {
  path: string;
  lineCount: number;
  maxCols: number;
  clipCols?: number;
  /** Present when the file is a picture; see `sanity_core::media`. */
  media?: MediaSize;
}

interface ScanResult {
  root: string;
  files: ScanFile[];
  groups: Omit<FileGroup, 'mode'>[];
  binary: number;
  elapsedMs: number;
}

/** What the watcher reports, after the backend has filtered it. */
interface ChangeBatch {
  changed: string[];
  removed: string[];
}

let scan: ScanResult | null = null;
let payloads = new Map<string, ArrayBuffer>();
let decoded = new Map<string, FileData>();

/**
 * Reads file text on demand, and only for the handful of files that are
 * actually readable on screen.
 *
 * The glyph pass needs a line synchronously, so a miss returns null and the
 * line is skipped for that frame; the fetch fills the cache and the next frame
 * draws it. At the zoom level where text appears, only two or three files are
 * in view, so the cache stays small without eviction.
 */
class BackendText implements TextSource {
  private lines = new Map<string, string[]>();
  private pending = new Set<string>();
  private inflight = new Set<Promise<unknown>>();
  /** Called when a file's text has arrived, so the frame that was missing it
   *  can be drawn again. The loop parks when nothing moves, so without this
   *  the text of a panel appeared on the next pan rather than when it
   *  loaded. */
  onLoad: (() => void) | null = null;

  lineText(path: string, line: number): string | null {
    const hit = this.lines.get(path);
    if (hit) return line < hit.length ? hit[line] : '';
    if (!this.pending.has(path)) {
      this.pending.add(path);
      const p = invoke<string>('file_text', { path })
        // Expanded here, once per file, rather than per frame: a column in a
        // span is a column with tabs expanded, so the text has to be too.
        .then((text) => this.lines.set(path, expandLines(text)))
        .catch(() => this.lines.set(path, []))
        .finally(() => {
          this.pending.delete(path);
          this.inflight.delete(p);
          this.onLoad?.();
        });
      this.inflight.add(p);
    }
    return null;
  }

  /** Resolves once the text asked for so far is in. An export renders a frame
   *  at a size where files that were bars on screen are readable, and their
   *  text is requested by that frame; without waiting, the image would be the
   *  empty panels. */
  ready(): Promise<void> {
    return Promise.all([...this.inflight]).then(() => undefined);
  }

  invalidate(path: string): void {
    this.lines.delete(path);
  }
}

const text = new BackendText();

/**
 * Search every file in the open folder, in the backend.
 *
 * The backend has the bytes and the frontend does not: measured on a real
 * repository, 18.6 MB over 1062 files, reading and scanning the whole tree
 * takes 7 to 8 milliseconds across eight cores, which is inside a keystroke.
 * Sending the text here instead so it could be searched in the webview would
 * cost more memory than the renderer uses.
 */
async function find(query: string, capPerFile: number): Promise<FileHits[]> {
  const res = await invoke<{ files: FileHits[]; shown: number; total: number; elapsedMs: number }>(
    'find_text',
    { query, cap: capPerFile },
  );
  return res.files;
}

/**
 * Put a line where a terminal can see it.
 *
 * The webview console does not reach stdout, so the live update path, whose
 * whole point is that it happens without anyone asking, would otherwise be
 * unobservable. Costs one IPC call per batch and prints nothing unless
 * `SANITY_WATCH_LOG` is set.
 */
export function uiLog(message: string): void {
  console.log(message);
  if (inTauri()) void invoke('log_line', { message }).catch(() => {});
}

/**
 * Send frontend errors to the terminal as well as the console.
 *
 * Without this, a throw inside the window is invisible: there is no console to
 * look at, and the symptom is a feature that simply does not happen. That is
 * exactly how the watch wiring failed silently the first time.
 */
export function bridgeErrors(): void {
  if (!inTauri()) return;
  window.addEventListener('error', (e) => uiLog(`error: ${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) =>
    uiLog(`unhandled rejection: ${e.reason instanceof Error ? e.reason.stack : e.reason}`),
  );
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    warn(...args);
    uiLog(`warn: ${args.map(String).join(' ')}`);
  };
  const err = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    err(...args);
    uiLog(`error: ${args.map(String).join(' ')}`);
  };
}

/** Open a file in the user's editor. Returns the command that handled it. */
export async function openInEditor(path: string): Promise<string> {
  return invoke<string>('open_in_editor', { path });
}

export interface Startup {
  repo?: string;
  lod?: string;
}

/** Startup wishes from the command line and the environment. */
export async function startup(): Promise<Startup> {
  if (!inTauri()) return {};
  try {
    return await invoke<Startup>('startup');
  } catch {
    return {};
  }
}

/** Ask for a folder. Returns null when the dialog was dismissed. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: 'Open a repository' });
  return typeof picked === 'string' ? picked : null;
}

/** Scan a folder and hand the result to the picker. */
export async function loadRepo(path: string): Promise<void> {
  scan = await invoke<ScanResult>('scan_repo', { path });
  const blob = await invoke<ArrayBuffer>('repo_payloads');
  payloads = unpack(blob);
  decoded = new Map();
  thumbs = new Map();
  project.load(scan.root, scan.groups, false);
}

/** The small version of each picture, by path; see sources/thumbs.ts. */
let thumbs = new Map<string, ArrayBuffer>();

/**
 * Ask the backend for every picture's thumbnail, in batches.
 *
 * In batches because the first one should be on the canvas while the rest are
 * still being decoded, and because a folder of a thousand pictures should not
 * be one reply of a hundred megabytes. `onBatch` wakes the render loop, which
 * parks as soon as the scene is still.
 */
async function loadThumbs(paths: string[], onBatch: () => void): Promise<void> {
  const BATCH = 48;
  for (let i = 0; i < paths.length; i += BATCH) {
    const slice = paths.slice(i, i + BATCH);
    try {
      const reply = await invoke<ArrayBuffer>('thumbs', { paths: slice });
      for (const [path, bytes] of unpackThumbs(reply)) thumbs.set(path, bytes);
      onBatch();
    } catch {
      return;
    }
  }
}

/** Build the scene from the loaded scan and the current view modes. */
export function openLoaded(app: CanvasApp, keepView = false): void {
  if (!scan) return;
  const entries = scan.files
    .map((f) => ({
      path: f.path,
      lineCount: f.lineCount,
      maxCols: f.maxCols,
      clipCols: f.clipCols,
      media: f.media,
      stub: project.modeForPath(f.path) === 'reduced',
    }))
    .filter((e) => project.modeForPath(e.path) !== 'off');

  text.onLoad = () => app.invalidate();
  // Pictures first at thumbnail size, in the background: the canvas opens on
  // the placeholders and fills in as the batches land.
  const pictures = entries.filter((e) => e.media && e.media.kind === 'image').map((e) => e.path);
  if (pictures.length > 0) void loadThumbs(pictures, () => app.invalidate());
  app.open(
    {
      entries,
      payload: (p) => payloads.get(p),
      text,
      find,
      ready: () => text.ready(),
      // Up to a thumbnail's size, the thumbnail: that is the whole of the
      // usual case, and it costs neither a megabyte across the boundary nor a
      // multi-megapixel decode in the window. Past it, the source, which is
      // read as it is for an image and rasterised by the platform for a
      // document, first page only. See `thumbs` and `pdf_page`.
      imageBytes: (path: string, level: number) => {
        if (level <= THUMB_MAX) {
          const held = thumbs.get(path);
          if (held) return Promise.resolve(held);
        }
        return (
          path.toLowerCase().endsWith('.pdf')
            ? invoke<ArrayBuffer>('pdf_page', { path, width: level })
            : invoke<ArrayBuffer>('file_bytes', { path })
        ).catch(() => null);
      },
    },
    keepView,
  );
}

export function loadedRoot(): string | null {
  return scan?.root ?? null;
}

/**
 * Re-read the given files and put them on the canvas.
 *
 * Returns true when the geometry has to be recomputed. Most saves do not
 * need that: a file whose wrapped rows still fit its panel is updated by
 * rewriting one texture layer, which costs a fraction of a millisecond and
 * leaves every other panel exactly where it was. A relayout is only for a
 * file that outgrew its panel, or one that appeared or disappeared, because
 * those change what the treemap has to divide up.
 */
async function readFresh(paths: string[]): Promise<Map<string, FileData>> {
  const out = new Map<string, FileData>();
  if (paths.length === 0) return out;
  const blob = await invoke<ArrayBuffer>('refresh_files', { paths });
  for (const [path, buf] of unpack(blob)) {
    payloads.set(path, buf);
    const data = decodeFile(buf);
    decoded.set(path, data);
    text.invalidate(path);
    out.set(path, data);
  }
  return out;
}

/** Forget files that are gone. Always structural: the treemap loses a leaf. */
async function forget(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) {
    payloads.delete(path);
    decoded.delete(path);
    text.invalidate(path);
  }
  await invoke('drop_files', { paths });
}

/**
 * Pick up the index after a structural change, then lay out again.
 *
 * The index comes from held backend state rather than a fresh scan, so a new
 * file costs one read instead of the four seconds a large project takes.
 */
async function restructure(app: CanvasApp): Promise<void> {
  scan = await invoke<ScanResult>('repo_index');
  project.refreshGroups(scan.groups);
  openLoaded(app, true);
}

/**
 * Watch the open repository and keep the canvas in step.
 *
 * The debouncing happens in the backend, so one batch here is one save or one
 * checkout, never a stream of duplicates. Batches are serialised: a checkout
 * can produce a second batch while the first is still decoding, and running
 * two relayouts at once would leave the scene describing neither state.
 */
export async function watchRepo(app: CanvasApp): Promise<UnlistenFn> {
  let busy: Promise<void> = Promise.resolve();
  project.watching = true;

  const unlisten = await listen<ChangeBatch>('sanity://changed', (event) => {
    const batch = event.payload;
    busy = busy
      .then(async () => {
        await forget(batch.removed);
        const fresh = await readFresh(batch.changed);
        const structural = await app.applyBatch(
          fresh, batch.removed, () => restructure(app), true,
        );

        // From the scene rather than from a local tally: the scene has every
        // drawn file's state, and counting only the files this session has
        // refreshed would report one when five differ.
        project.changed = app.changedCount();
        project.sawChanges(project.changed);
        uiLog(
          `batch: ${batch.changed.length} changed, ${batch.removed.length} removed` +
            `${structural ? ' (relayout)' : ' (in place)'} · ${project.changed} marked, ` +
            `${app.recentCount()} just changed`,
        );
      })
      // A failed batch must not stop the ones after it, and the next save
      // re-reads the file anyway.
      .catch((e) => uiLog(`batch failed: ${e}`));
  });

  return unlisten;
}

/** Stop watching. */
/**
 * Write a rendered PNG, asking where through the native dialog.
 *
 * Two calls, because of how the bytes travel. A 4K image is a few megabytes,
 * and the default IPC would turn them into a string of decimal numbers six
 * times that size, so they go over as the raw request body instead. A raw
 * body carries no arguments and its headers are ASCII only, while a path is
 * neither, so the path is handed over first in a call of its own and the
 * backend holds it for the write that follows.
 *
 * The dialog itself is the same one the folder picker uses, which is the part
 * of this that has been working since the first day.
 *
 * Returns the path written, or null if the dialog was dismissed.
 */
export async function savePng(bytes: Uint8Array, name: string): Promise<string | null> {
  const path = await save({
    defaultPath: name,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!path) return null;
  await invoke('stage_save', { path });
  return invoke<string>('save_png', new Uint8Array(bytes));
}

export async function stopWatching(): Promise<void> {
  if (!inTauri()) return;
  project.watching = false;
  try {
    await invoke('stop_watch');
  } catch {
    // Nothing was being watched.
  }
}
