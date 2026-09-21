// Opens a real repository through the Tauri backend.
//
// The scan result comes back as JSON because it is small and structured. The
// payloads come back as one raw byte blob with a JSON index in front of it,
// because the default IPC would base64 several megabytes of typed arrays and
// copy them twice. See `repo_payloads` in src-tauri/src/lib.rs.

import { invoke } from '@tauri-apps/api/core';
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
  artefact?: string;
}

interface ScanResult {
  root: string;
  files: ScanFile[];
  groups: Omit<FileGroup, 'mode'>[];
  binary: number;
  elapsedMs: number;
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

/** Open a file in the user's editor. Returns the command that handled it. */
export async function openInEditor(path: string): Promise<string> {
  return invoke<string>('open_in_editor', { path });
}

/** A folder passed on the command line or in SANITY_OPEN, if any. */
export async function initialRepo(): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return (await invoke<string | null>('initial_repo')) ?? null;
  } catch {
    return null;
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
}

/** Build the scene from the loaded scan and the current view modes. */
export function openLoaded(app: CanvasApp): void {
  if (!scan) return;
  const entries = scan.files
    .map((f) => ({
      path: f.path,
      lineCount: f.lineCount,
      maxCols: f.maxCols,
      stub: project.modeForPath(f.path) === 'reduced',
    }))
    .filter((e) => project.modeForPath(e.path) !== 'off');

  app.open({
    entries,
    payload: (p) => payloads.get(p),
    text,
  });
}

export function loadedRoot(): string | null {
  return scan?.root ?? null;
}

/** Re-read one file after the watcher reports it changed. */
export async function refreshFile(app: CanvasApp, path: string): Promise<void> {
  text.invalidate(path);
  const buf = payloads.get(path);
  if (!buf) return;
  const data = decoded.get(path) ?? decodeFile(buf);
  app.touch(path, data);
}
