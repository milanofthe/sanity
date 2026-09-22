// Loads a scan dumped to disk by `cargo run -p sanity-core --example dump`.
//
// Exists because the Tauri window cannot be screenshotted without screen
// recording permission, so this is the only way to check what real code looks
// like on the canvas. It goes through the same decode and layout path as the
// live backend, so what it renders is what the app renders.
//
// Enabled with ?fixture=<name>, expecting web/public/<name>/{scan.json,
// payloads.bin,texts.json}.

import type { CanvasApp } from '$lib/canvas/app';
import { findInTexts, type FileHits } from '$lib/canvas/content';
import { expandLines } from '$lib/canvas/data/tabs';
import type { TextSource } from '$lib/canvas/renderer/scene';
import { project, type FileGroup } from '$lib/state/project.svelte';
import { unpack } from './payload.ts';

interface FixtureScan {
  root: string;
  files: {
    path: string;
    lineCount: number;
    maxCols: number;
    clipCols?: number;
  }[];
  groups: Omit<FileGroup, 'mode'>[];
}

let scan: FixtureScan | null = null;
let payloads = new Map<string, ArrayBuffer>();
let texts: Record<string, string[]> = {};

class FixtureText implements TextSource {
  lineText(path: string, line: number): string | null {
    const lines = texts[path];
    if (!lines) return null;
    return line < lines.length ? lines[line] : '';
  }
}

const text = new FixtureText();

/**
 * Search the fixture's own text, in the browser.
 *
 * The backend does this for a real folder; a fixture has no backend and
 * already holds every line, so the same definition of a hit is applied here
 * instead. Both implementations are tested against the same cases; see
 * canvas/content.ts.
 */
async function find(query: string, capPerFile: number): Promise<FileHits[]> {
  return findInTexts(
    Object.entries(texts).map(([path, lines]) => [path, lines.join('\n')] as [string, string]),
    query,
    capPerFile,
  );
}

/** The fixture named in the query string, if any. */
export function fixtureName(): string | null {
  return new URLSearchParams(location.search).get('fixture');
}

export async function loadFixture(name: string): Promise<void> {
  const base = `/${name}`;
  const [s, blob, t] = await Promise.all([
    fetch(`${base}/scan.json`).then((r) => r.json() as Promise<FixtureScan>),
    fetch(`${base}/payloads.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/texts.json`)
      .then((r) => r.json() as Promise<Record<string, string>>)
      .catch(() => ({}) as Record<string, string>),
  ]);
  scan = s;
  payloads = unpack(blob);
  texts = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, expandLines(v)]));
  project.load(s.root, s.groups, false);
}

export function openFixture(app: CanvasApp, keepView = false): void {
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
  app.open({ entries, payload: (p) => payloads.get(p), text, find }, keepView);
}

export function fixtureLoaded(): boolean {
  return scan !== null;
}
