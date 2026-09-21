// Opens a real repository through the Tauri backend.
//
// The scan result comes back as JSON because it is small and structured. The
// payloads come back as one raw byte blob with a JSON index in front of it,
// because the default IPC would base64 several megabytes of typed arrays and
// copy them twice. See `repo_payloads` in src-tauri/src/lib.rs.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { CanvasApp } from '$lib/canvas/app';
import { decodeFile, type FileData } from '$lib/canvas/data/wire';
import type { TextSource } from '$lib/canvas/renderer/scene';
import { project, type FileGroup } from '$lib/state/project.svelte';
import { unpack } from './payload.ts';

/** True inside the Tauri window, false in a plain browser tab. */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ScanFile {
  path: string;
  lineCount: number;
  maxCols: number;
  clipCols?: number;
  artefact?: string;
}

interface ScanResult {
  root: string;
  files: ScanFile[];
  groups: Omit<FileGroup, 'mode'>[];
  binary: number;
  /** Files with at least one line changed against the baseline. */
  changed: number;
  /** Which baseline the change state was computed against. */
  baseline: string;
  elapsedMs: number;
}

/** What the watcher reports, after the backend has filtered it. */
interface ChangeBatch {
  changed: string[];
  removed: string[];
  headMoved: boolean;
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

  lineText(path: string, line: number): string | null {
    const hit = this.lines.get(path);
    if (hit) return line < hit.length ? hit[line] : '';
    if (!this.pending.has(path)) {
      this.pending.add(path);
      invoke<string>('file_text', { path })
        .then((text) => this.lines.set(path, text.split('\n')))
        .catch(() => this.lines.set(path, []))
        .finally(() => this.pending.delete(path));
    }
    return null;
  }

  invalidate(path: string): void {
    this.lines.delete(path);
  }
}

const text = new BackendText();

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
  project.load(scan.root, scan.groups, false);
  project.baseline = scan.baseline === 'branch' ? 'branch' : 'head';
  project.changed = scan.changed;
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
      stub: project.modeForPath(f.path) === 'reduced',
    }))
    .filter((e) => project.modeForPath(e.path) !== 'off');

  app.open(
    {
      entries,
      payload: (p) => payloads.get(p),
      text,
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
async function applyChanged(app: CanvasApp, paths: string[], warm: boolean): Promise<boolean> {
  if (paths.length === 0) return false;
  const blob = await invoke<ArrayBuffer>('refresh_files', { paths });
  const fresh = unpack(blob);
  let structural = false;

  for (const [path, buf] of fresh) {
    const known = payloads.has(path);
    payloads.set(path, buf);
    const data = decodeFile(buf);
    decoded.set(path, data);
    text.invalidate(path);

    if (!known || !app.fitsInPlace(path, data)) {
      structural = true;
      continue;
    }
    app.touch(path, data, warm);
  }
  return structural;
}

/** Forget files that are gone. Always structural: the treemap loses a leaf. */
async function applyRemoved(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  for (const path of paths) {
    payloads.delete(path);
    decoded.delete(path);
    text.invalidate(path);
  }
  await invoke('drop_files', { paths });
  return true;
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
  project.changed = scan.changed;
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
        let structural = await applyRemoved(batch.removed);
        structural = (await applyChanged(app, batch.changed, true)) || structural;

        if (batch.headMoved) {
          // A commit or a checkout moves the baseline for files nobody wrote,
          // so every held file has to be asked again. These arrive cold: the
          // glow means "someone just changed this", and a commit is the
          // opposite of that.
          const blob = await invoke<ArrayBuffer>('refresh_changes');
          for (const [path, buf] of unpack(blob)) {
            payloads.set(path, buf);
            const data = decodeFile(buf);
            decoded.set(path, data);
            if (app.fitsInPlace(path, data)) app.touch(path, data, false);
            else structural = true;
          }
        }

        if (structural) await restructure(app);
        // From the scene rather than from a local tally: the scene has every
        // drawn file's state, and counting only the files this session has
        // refreshed would report one when five differ.
        else project.changed = app.changedCount();
        project.sawChanges(project.changed);
        uiLog(
          `batch: ${batch.changed.length} changed, ${batch.removed.length} removed` +
            `${batch.headMoved ? ', head moved' : ''}` +
            `${structural ? ' (relayout)' : ' (in place)'} · ${project.changed} files differ`,
        );
      })
      // A failed batch must not stop the ones after it, and the next save
      // re-reads the file anyway.
      .catch((e) => uiLog(`batch failed: ${e}`));
  });

  return unlisten;
}

/**
 * Switch what the change state is measured against, and repaint.
 *
 * A baseline change touches every file's state at once, so it goes through the
 * same cold path a commit does: the highlighting moves, the recency glow does
 * not, because nothing was written.
 */
export async function setBaseline(app: CanvasApp, baseline: 'head' | 'branch'): Promise<void> {
  const blob = await invoke<ArrayBuffer>('refresh_changes', { baseline });
  for (const [path, buf] of unpack(blob)) {
    payloads.set(path, buf);
    const data = decodeFile(buf);
    decoded.set(path, data);
    app.touch(path, data, false);
  }
  project.baseline = baseline;
  project.changed = app.changedCount();
}

/** Stop watching. */
export async function stopWatching(): Promise<void> {
  if (!inTauri()) return;
  project.watching = false;
  try {
    await invoke('stop_watch');
  } catch {
    // Nothing was being watched.
  }
}
