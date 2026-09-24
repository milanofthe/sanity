// Loads a scan dumped to disk by `cargo run -p sanity-core --example dump`.
//
// Exists because the Tauri window cannot be screenshotted without screen
// recording permission, so this is the only way to check what real code looks
// like on the canvas. It goes through the same decode and layout path as the
// live backend, so what it renders is what the app renders.
//
// Enabled with ?fixture=<name>, expecting web/public/<name>/{scan.json,
// payloads.bin,texts.json}. The web demo is the same thing under
// public/demo/<repo>; see sources/demo.ts.

import type { CanvasApp } from "$lib/canvas/app";
import { findInTexts, type FileHits } from "$lib/canvas/content";
import { expandLines } from "$lib/canvas/data/tabs";
import type { MediaSize } from "$lib/canvas/layout/tree";
import type { TextSource } from "$lib/canvas/renderer/scene";
import { ui } from "$lib/state/ui.svelte";
import { project, type FileGroup } from "$lib/state/project.svelte";
import { unpack } from "./payload.ts";
import { THUMB_MAX } from "./thumbs.ts";
import { parseMediaKey } from '$lib/canvas/mediakey';

interface FixtureScan {
  root: string;
  files: {
    path: string;
    lineCount: number;
    maxCols: number;
    clipCols?: number;
    media?: MediaSize;
  }[];
  groups: Omit<FileGroup, "mode">[];
}

let scan: FixtureScan | null = null;
/** Which fixture is loaded, for the media URLs. */
let loaded = "";
/** Paths that are documents rather than images, which arrive as a rendered
 *  page instead of as the file itself. */
let documents = new Set<string>();
let payloads = new Map<string, ArrayBuffer>();
let texts: Record<string, string[]> = {};
/** Resolves when texts.json has arrived, so anything that needs the text can
 *  wait for it instead of finding nothing. */
let textsReady: Promise<void> = Promise.resolve();
/** Thumbnails by path, from thumbs.bin; see `openFixtureNamed`. */
let thumbs = new Map<string, ArrayBuffer>();
let thumbsReady: Promise<void> = Promise.resolve();
/** Tells the canvas to draw again once the text is in. The render loop parks
 *  when nothing moves, so without this the glyphs would appear on the next
 *  pan rather than when they load. */
let onTexts: (() => void) | null = null;

class FixtureText implements TextSource {
  lineText(path: string, line: number): string | null {
    const lines = texts[path];
    if (!lines) return null;
    return line < lines.length ? lines[line] : "";
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
  await textsReady;
  return findInTexts(
    Object.entries(texts).map(
      ([path, lines]) => [path, lines.join("\n")] as [string, string],
    ),
    query,
    capPerFile,
  );
}

/** The fixture named in the query string, if any. */
export function fixtureName(): string | null {
  return new URLSearchParams(location.search).get("fixture");
}

/**
 * Fetch a dump and hand it to the project state.
 *
 * The structure is awaited and the text is not. texts.json is the bulk of a
 * dump, 7.5 of pathsim's 8.9 megabytes, and the first thing anyone sees is
 * the whole repository at a zoom where a line is a pixel and there is no text
 * to draw. So the canvas comes up on scan.json plus the payloads, about a
 * fifth of the transfer, and the text lands while it is already usable.
 *
 * `as.root` replaces the root the dump was made from, which for the demo is
 * whatever path the build machine cloned into and has no business being in
 * the window title.
 */
const base = (name: string) => `/${name}`;

export async function loadFixture(
  name: string,
  as: { root?: string; demo?: boolean } = {},
): Promise<void> {
  loaded = name;
  const base = `/${name}`;
  texts = {};
  const [s, blob] = await Promise.all([
    fetch(`${base}/scan.json`).then((r) => r.json() as Promise<FixtureScan>),
    fetch(`${base}/payloads.bin`).then((r) => r.arrayBuffer()),
  ]);
  scan = s;
  payloads = unpack(blob);
  // Every thumbnail in one file, in the same container as the payloads. One
  // request rather than one per picture: on a folder of 116 the separate
  // requests were most of the time the canvas took to fill in, and the app
  // never had that problem because its backend answers in batches.
  thumbs = new Map();
  thumbsReady = fetch(`${base}/thumbs.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((bin) => {
      if (bin) thumbs = unpack(bin);
      onTexts?.();
    })
    .catch(() => {});
  documents = new Set(
    s.files.filter((f) => f.media?.kind === "document").map((f) => f.path),
  );
  textsReady = fetch(`${base}/texts.json`)
    .then((r) => r.json() as Promise<Record<string, string>>)
    .then((t) => {
      texts = Object.fromEntries(
        Object.entries(t).map(([k, v]) => [k, expandLines(v)]),
      );
      onTexts?.();
    })
    .catch(() => {
      texts = {};
    });
  project.load(as.root ?? s.root, s.groups, false, as.demo ?? false);
}

export function openFixture(app: CanvasApp, keepView = false): void {
  if (!scan) return;
  onTexts = () => app.invalidate();
  const entries = scan.files
    .map((f) => ({
      path: f.path,
      lineCount: f.lineCount,
      maxCols: f.maxCols,
      clipCols: f.clipCols,
      // A document shows every page when the option is on; see `pageGrid`.
      media: f.media && f.media.kind === 'document' && ui.expandDocuments
        ? { ...f.media, expanded: true }
        : f.media,
      stub: project.modeForPath(f.path) === "reduced",
    }))
    .filter((e) => project.modeForPath(e.path) !== "off");
  const source = {
    entries,
    payload: (p: string) => payloads.get(p),
    text,
    find,
    ready: () => Promise.all([textsReady, thumbsReady]).then(() => undefined),
    // The dump copies pictures in under media/ and their thumbnails under
    // thumbs/, so a fetch is all it takes. Up to a thumbnail's size that is
    // what is fetched, which is the same rule the app follows against its
    // backend, and it keeps the demo from pulling megabytes for panels a
    // hundred pixels wide. A document is there as its pages, rendered by the
    // dump with the renderer the app uses: `.png` after its own name for the
    // first, `.p<n>.png` for the rest, asked for by page; see
    // canvas/mediakey.ts and examples/dump.rs.
    imageBytes: async (key: string, level: number) => {
      const { path, page } = parseMediaKey(key);
      if (page !== undefined) {
        const url = `${base(loaded)}/media/${path}${page === 0 ? '.png' : `.p${page}.png`}`;
        return fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      }
      const doc = documents.has(path);
      // Up to a thumbnail's size, the thumbnail, which is already here: one
      // file carried all of them when the repository opened.
      if (!doc && level <= THUMB_MAX) {
        await thumbsReady;
        const held = thumbs.get(path);
        if (held) return held;
        // Not every picture has one: an SVG is a picture the dump's decoder
        // does not read and the browser reads fine, so a miss falls through
        // to the source rather than marking the file broken.
      }
      const full = `${base(loaded)}/media/${path}${doc ? '.png' : ''}`;
      return fetch(full)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
    },
  };
  app.open(source, keepView);
}

export function fixtureLoaded(): boolean {
  return scan !== null;
}
