// Opens a real repository through the Tauri backend.
//
// The scan result comes back as JSON because it is small and structured. The
// payloads come back as one raw byte blob with a JSON index in front of it,
// because the default IPC would base64 several megabytes of typed arrays and
// copy them twice. See `scan_next` in src-tauri/src/scanjob.rs.

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
import { history, type Commit } from '$lib/state/history.svelte';
import { ui } from '$lib/state/ui.svelte';
import type { StreamTargetChunk } from 'mediabunny';
import type { ReplaySource, VideoSink } from '$lib/video';
import { mediaKey, parseMediaKey } from '$lib/canvas/mediakey';
import { unpack } from './payload.ts';
import { THUMB_MAX, unpackThumbs } from './thumbs.ts';

/** True inside the Tauri window, false in a plain browser tab. */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ScanFile {
  path: string;
  /** Set when git ignores it: listed, never read, drawn as a placeholder. */
  ignored?: boolean;
  lineCount: number;
  maxCols: number;
  clipCols?: number;
  /** Present when the file is a picture; see `sanity_core::media`. */
  media?: MediaSize;
  /** Which version of a picture this is; see canvas/mediakey.ts. */
  version?: string;
  /** Line widths sampled from a file not read yet; see `sampleCols` in
   *  src-tauri/src/lib.rs and `lineColsFrom`. */
  sampleCols?: number[];
}

interface ScanResult {
  root: string;
  files: ScanFile[];
  groups: Omit<FileGroup, 'mode'>[];
  binary: number;
  /** How many files git ignores in the folder, and how many of those this
   *  scan took; see `scan_start`. */
  ignoredTotal: number;
  ignoredShown: number;
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
  /** The commit the canvas shows, or null for the working tree: in the
   *  history, a file's text is read as it was there. */
  at: string | null = null;
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
      const p = invoke<string>('file_text', { path, at: this.at })
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

  /** Forget every file's text, for a step to another commit. Only the few
   *  files readable on screen are held, so they are read again at once. */
  clear(): void {
    this.lines.clear();
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

/** Counts the fills, so one for a folder that has since been replaced stops. */
let filling = 0;

/**
 * Open a folder, first stage: every file listed and estimated from its size
 * and first few kilobytes, which is milliseconds, so the whole project can be
 * laid out at once. `fillRepo` is the second stage. See src-tauri/src/scanjob.rs.
 */
export async function loadRepo(path: string): Promise<void> {
  filling++;
  scan = await invoke<ScanResult>('scan_start', {
    path,
    includeIgnored: project.includeIgnored,
  });
  payloads = new Map();
  decoded = new Map();
  thumbs = new Map();
  project.reading = { read: 0, total: scan.files.filter((f) => !f.ignored).length };
  project.load(scan.root, scan.groups, false);
  project.setIgnoredCounts(scan.ignoredTotal, scan.ignoredShown);
}

/** How often the window collects what has been read. */
const COLLECT_MS = 50;
/** Least time between two relayouts while files arrive, and at least this
 *  many times what the last one took, so a large project spends most of its
 *  time reading rather than laying out what it has read so far. */
const RELAYOUT_MS = 400;
const RELAYOUT_SHARE = 6;

/** A reply of `scan_next`: rows, dropped paths, progress and payloads. */
function readScanBatch(reply: ArrayBuffer): {
  rows: ScanFile[]; dropped: string[]; read: number; total: number; done: boolean;
  parts: [string, ArrayBuffer][];
} {
  const headerLen = new DataView(reply).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(reply, 4, headerLen))) as {
    rows: ScanFile[]; dropped: string[]; read: number; total: number; done: boolean;
  };
  return { ...header, parts: [...unpack(reply.slice(4 + headerLen))] };
}

/** Whether a row differs from another in anything the layout sizes by. */
const resized = (a: ScanFile | undefined, b: ScanFile): boolean =>
  !a || a.lineCount !== b.lineCount || a.maxCols !== b.maxCols || a.clipCols !== b.clipCols
  || JSON.stringify(a.media ?? null) !== JSON.stringify(b.media ?? null);

/**
 * Open a folder, second stage: collect the files as they are read and fill
 * their panels in. A file whose real size differs from its estimate is laid
 * out again, carried over from the layout on screen, gathered rather than
 * once per file. Resolves true once every file is in, false when another
 * folder was opened meanwhile.
 */
export async function fillRepo(app: CanvasApp): Promise<boolean> {
  const mine = ++filling;
  const t0 = performance.now();
  let layouts = 0;
  let batches = 0;
  let lastLayout = -Infinity;
  let cost = 0;
  let relayout = false;
  for (;;) {
    const batch = readScanBatch(await invoke<ArrayBuffer>('scan_next'));
    if (mine !== filling || !scan) return false;
    const rows = new Map(scan.files.map((f) => [f.path, f]));
    for (const row of batch.rows) {
      if (resized(rows.get(row.path), row)) relayout = true;
      rows.set(row.path, row);
    }
    for (const path of batch.dropped) {
      rows.delete(path);
      relayout = true;
    }
    if (batch.rows.length > 0 || batch.dropped.length > 0) scan = { ...scan, files: [...rows.values()] };
    const arrived: string[] = [];
    for (const [path, buf] of batch.parts) {
      payloads.set(path, buf);
      arrived.push(path);
    }
    project.reading = batch.done ? null : { read: batch.read, total: batch.total };
    const now = performance.now();
    if (relayout && (batch.done || now - lastLayout > Math.max(RELAYOUT_MS, RELAYOUT_SHARE * cost))) {
      openLoaded(app, true, !batch.done);
      app.followFit();
      layouts++;
      cost = performance.now() - now;
      lastLayout = now;
      relayout = false;
    }
    if (arrived.length > 0) app.fillIn(arrived);
    batches++;
    if (batch.done) {
      uiLog(
        `read ${batch.total} files in ${(performance.now() - t0).toFixed(0)} ms after the layout, ` +
          `${batches} batches, laid out again ${layouts} times`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, COLLECT_MS));
  }
  // The index as it now stands, for the picker's counts, which were
  // estimates until now.
  scan = await invoke<ScanResult>('repo_index');
  project.refreshGroups(scan.groups);
  return mine === filling;
}

/** The small version of each picture, by its key; see sources/thumbs.ts and
 *  canvas/mediakey.ts. */
let thumbs = new Map<string, ArrayBuffer>();

/**
 * Ask the backend for every picture's thumbnail, in batches.
 *
 * In batches because the first one should be on the canvas while the rest are
 * still being decoded, and because a folder of a thousand pictures should not
 * be one reply of a hundred megabytes. `onBatch` wakes the render loop, which
 * parks as soon as the scene is still.
 */
async function loadThumbs(pictures: { path: string; version?: string }[], onBatch: () => void): Promise<void> {
  const BATCH = 48;
  // Only what is not held: a step through the history lays the canvas out
  // again, and asking for every picture's thumbnail on each step was asking
  // for all of them again.
  const todo = pictures.filter((p) => !thumbs.has(mediaKey(p.path, p.version)));
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    try {
      const reply = await invoke<ArrayBuffer>('thumbs', {
        paths: slice.map((p) => p.path),
        versions: slice.map((p) => p.version ?? null),
      });
      // By path, which a batch holds once each: the reply leaves out the
      // pictures it could not make a thumbnail of.
      const got = unpackThumbs(reply);
      for (const p of slice) {
        const bytes = got.get(p.path);
        if (bytes) thumbs.set(mediaKey(p.path, p.version), bytes);
      }
      onBatch();
    } catch {
      return;
    }
  }
}

/**
 * Line widths for a file estimated but not read: its sample, repeated over
 * as many lines as it is estimated to have. The layout sizes a panel by the
 * rows its lines take once long ones wrap, and every line at the typical
 * width wraps none: a netlist whose lines run from a few characters to four
 * thousand came out two and a half times its size that way.
 */
function lineColsFrom(sample: number[], lineCount: number): Uint16Array {
  const out = new Uint16Array(Math.max(1, lineCount));
  if (sample.length === 0) return out.fill(1);
  for (let i = 0; i < out.length; i++) out[i] = sample[i % sample.length];
  return out;
}

/** Build the scene from the loaded scan and the current view modes. */
export function openLoaded(app: CanvasApp, keepView = false, filling = false): void {
  if (!scan) return;
  // In the history, the files as they are at the commit shown: laid out for
  // that commit alone, so nothing leaves an empty place behind.
  const files = shownRows ? [...shownRows.values()] : scan.files;
  const entries = files
    .map((f) => ({
      path: f.path,
      lineCount: f.lineCount,
      // A file not read yet is laid out from its sample, so its long lines
      // wrap as the real ones will; see `lineColsFrom`.
      ...(f.sampleCols ? { lineCols: lineColsFrom(f.sampleCols, f.lineCount) } : {}),
      maxCols: f.maxCols,
      clipCols: f.clipCols,
      // A document shows every page when the option is on; see `pageGrid`.
      media: f.media && {
        ...f.media,
        ...(f.media.kind === 'document' && ui.expandDocuments ? { expanded: true } : {}),
        ...(f.version ? { version: f.version } : {}),
      },
      // A file git ignores is a placeholder whatever its type is set to: its
      // contents were never read, so there is nothing to draw in it.
      stub: f.ignored === true || project.modeForPath(f.path) === 'reduced',
    }))
    .filter((e) => project.modeForPath(e.path) !== 'off');

  text.onLoad = () => app.invalidate();
  // Pictures first at thumbnail size, in the background: the canvas opens on
  // the placeholders and fills in as the batches land.
  const pictures = entries
    .filter((e) => e.media && e.media.kind === 'image')
    .map((e) => ({ path: e.path, version: e.media?.version }));
  if (pictures.length > 0) void loadThumbs(pictures, () => app.invalidate());
  app.open(
    {
      entries,
      payload: (p) => (shownRows ? shownPayloads.get(p) : undefined) ?? payloads.get(p),
      text,
      find,
      ready: () => text.ready(),
      // Up to a thumbnail's size, the thumbnail: that is the whole of the
      // usual case, and it costs neither a megabyte across the boundary nor a
      // multi-megapixel decode in the window. Past it, the source, which is
      // read as it is for an image and rasterised by the platform for a
      // document, first page only. See `thumbs` and `pdf_page`.
      // The version in the key says where the bytes are: the disk, or a
      // blob when the canvas shows a commit. See canvas/mediakey.ts.
      imageBytes: (key: string, level: number) => {
        const { path, version = null, page } = parseMediaKey(key);
        if (page !== undefined) {
          return invoke<ArrayBuffer>('pdf_page', { path, width: level, page, version })
            .catch(() => null);
        }
        if (level <= THUMB_MAX) {
          const held = thumbs.get(key);
          if (held) return Promise.resolve(held);
        }
        return (
          path.toLowerCase().endsWith('.pdf')
            ? invoke<ArrayBuffer>('pdf_page', { path, width: level, version })
            : invoke<ArrayBuffer>('file_bytes', { path, version })
        ).catch(() => null);
      },
    },
    keepView,
    filling,
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
        // Showing the history: the live state is kept current and the canvas
        // is left alone. Coming back to the present is one step from the
        // commit to the working tree as it then is, this batch included.
        if (inHistory()) {
          scan = await invoke<ScanResult>('repo_index');
          project.refreshGroups(scan.groups);
          return;
        }
        let structural = await app.applyBatch(
          fresh, batch.removed, () => restructure(app), true,
        );
        // A picture that changed is a new version, which is in the index
        // rather than in the payload: without it the picture keeps its key
        // and is drawn as it was. See canvas/mediakey.ts.
        const pictures = new Set(scan?.files.filter((f) => f.media).map((f) => f.path));
        if (!structural && batch.changed.some((p) => pictures.has(p))) {
          await restructure(app);
          structural = true;
        }

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

// --- The history ticker ----------------------------------------------------

/** Commits loaded for the ticker. A slider with fifty thousand stops is not
 *  a control, and this is years of most projects. */
const HISTORY_PAGE = 1000;

/** What the canvas lays out while it shows a commit: the files as they are
 *  there, and the payloads of the ones that differ from the working tree.
 *  Null in the present. */
let shownRows: Map<string, ScanFile> | null = null;
const shownPayloads = new Map<string, ArrayBuffer>();
/** A step is being played; the next waits for it. */
let stepping = false;

/** Whether the canvas shows anything other than the working tree, or is on
 *  its way to. */
const inHistory = (): boolean => history.at >= 0 || history.target >= 0 || stepping;

/** Read the commits of the open folder, and start from the present. */
export async function loadHistory(): Promise<void> {
  history.commits = await invoke<Commit[]>('history_log', { skip: 0, limit: HISTORY_PAGE })
    .catch(() => []);
  history.at = -1;
  history.target = -1;
  shownRows = null;
  shownPayloads.clear();
  text.at = null;
}

/** A reply of `history_step`: rows, removed paths and payloads. */
function readStep(reply: ArrayBuffer): { rows: ScanFile[]; removed: string[]; parts: [string, ArrayBuffer][] } {
  const headerLen = new DataView(reply).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(reply, 4, headerLen))) as {
    rows: ScanFile[];
    removed: string[];
  };
  return { ...header, parts: [...unpack(reply.slice(4 + headerLen))] };
}

/**
 * Send the ticker to commit `index`, -1 for the working tree.
 *
 * The canvas catches up from whatever it shows, straight to the latest target:
 * clicks that arrive while a step plays are not queued, they move the target,
 * and the next step goes there directly. Going backwards is a step like any
 * other, and plays backwards because the diff does: what the commit added
 * goes, what it removed comes back.
 */
export function historyGo(app: CanvasApp, index: number): void {
  history.target = Math.max(-1, Math.min(history.commits.length - 1, index));
  void catchUp(app);
}

async function catchUp(app: CanvasApp): Promise<void> {
  if (stepping) return;
  stepping = true;
  try {
    while (history.target !== history.at) await stepTo(app, history.target);
  } catch (e) {
    uiLog(`history step failed: ${e}`);
    history.target = history.at;
  } finally {
    stepping = false;
  }
}

async function stepTo(app: CanvasApp, index: number, fit = true): Promise<void> {
  if (!scan) return;
  const from = history.at >= 0 ? history.commits[history.at].sha : null;
  const to = index >= 0 ? history.commits[index].sha : null;
  const header = readStep(await invoke<ArrayBuffer>('history_step', { from, to }));
  // Into the history from the working tree as it was scanned.
  const rows = (shownRows ??= new Map(scan.files.map((f) => [f.path, f])));

  const fresh = new Map<string, FileData>();
  for (const path of header.removed) {
    rows.delete(path);
    shownPayloads.delete(path);
  }
  for (const row of header.rows) rows.set(row.path, row);
  for (const [path, buf] of header.parts) {
    shownPayloads.set(path, buf);
    fresh.set(path, decodeFile(buf));
  }
  history.at = index;
  text.at = to;
  text.clear();
  if (index < 0) {
    // Back in the present: laid out from the working tree again, which the
    // watcher kept current while the history was shown.
    shownRows = null;
    shownPayloads.clear();
  }
  await app.applyBatch(fresh, header.removed, async () => openLoaded(app, true), true);
  // The whole project, which is what a step can have moved: a commit that
  // adds or removes files is laid out again, and its panels slide to their
  // new places.
  if (fit && ui.historyFollow) app.fit();
  uiLog(
    `history: ${to ? to.slice(0, 8) : 'working tree'}, ` +
      `${header.rows.length} changed, ${header.removed.length} removed`,
  );
}

// --- The history as a video ------------------------------------------------

/**
 * The history, played for a video: straight to each commit it is asked for,
 * as the ticker goes, but without the ticker's own fit, since the video
 * frames the project itself and on its own clock.
 *
 * The ticker is held while it runs, so a click or an arrow key cannot step
 * the canvas somewhere between two frames; `release` lets go of it and sends
 * the canvas back to where the ticker was.
 */
export function historyReplay(app: CanvasApp): ReplaySource & { release(): void } {
  const was = history.target;
  stepping = true;
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return {
    async go(index) {
      history.target = index;
      await stepTo(app, index, false);
    },
    caption(index) {
      const c = history.commits[index];
      if (!c) return { meta: '', subject: 'working tree' };
      return { meta: `${day(c.time)}  ${c.sha.slice(0, 7)}`, subject: c.subject };
    },
    release() {
      stepping = false;
      historyGo(app, was);
    },
  };
}

/**
 * Ask where a video goes and open the file, or null when that was cancelled.
 *
 * The muxer's pieces go over as they come, each with the offset it belongs
 * at, as a raw body like an image's bytes; see src-tauri/src/video.rs.
 */
export async function openVideoSink(name: string): Promise<VideoSink | null> {
  const path = await save({
    defaultPath: name,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (!path) return null;
  await invoke('stage_save', { path });
  await invoke('video_open');
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      const piece = new Uint8Array(8 + chunk.data.byteLength);
      new DataView(piece.buffer).setBigUint64(0, BigInt(chunk.position), true);
      piece.set(chunk.data, 8);
      await invoke('video_write', piece);
    },
  });
  return {
    writable,
    close: (keep) => invoke<string | null>('video_close', { keep }),
  };
}
