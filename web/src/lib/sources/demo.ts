// The repositories baked into the web build.
//
// A demo of this app cannot be a screenshot. What it does is let you hold a
// whole repository in view and see where things are, and that is a thing you
// have to move around in before it means anything. So the web version is the
// app itself with real repositories in it, read over HTTP instead of from
// disk: scripts/demo.mjs dumps each one into web/public/demo/<id> in the
// fixture format, and from there the same decode, layout and render path runs
// that the desktop app runs.
//
// What the demo cannot do is watch, since a dump is a snapshot of a head and
// there is no folder behind it. Everything else works, search included.

/** One entry of public/demo/index.json, written by scripts/demo.mjs. */
export interface DemoRepo {
  id: string;
  label: string;
  /** One line on what the project is, for the menu. */
  about: string;
  /** Where to clone it, so a visitor can open the real thing. */
  url: string;
  files: number;
  lines: number;
}

let repos: DemoRepo[] = [];

/**
 * Read the index, or return an empty list when this build has no demo in it.
 *
 * Empty is the normal case for the desktop app and for a dev server that has
 * not run `npm run demo`, so a missing index is not an error: the caller falls
 * back to generated data the same way it always did.
 */
export async function loadDemoIndex(): Promise<DemoRepo[]> {
  repos = await fetch('/demo/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<DemoRepo[]>) : []))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => []);
  return repos;
}

/** The repository asked for in the query string, if it is one we have. */
export function demoName(): string | null {
  const want = new URLSearchParams(location.search).get('demo');
  return want && repos.some((r) => r.id === want) ? want : null;
}

/** Put the open repository in the address bar, so the view can be linked to.
 *  Replaces rather than pushes: picking another one is not a navigation. */
export function rememberDemo(id: string): void {
  const url = new URL(location.href);
  url.searchParams.set('demo', id);
  history.replaceState(null, '', url);
}
