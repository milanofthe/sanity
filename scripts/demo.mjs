// Bake a few public repositories into the web demo.
//
//   node scripts/demo.mjs            clones what is missing, dumps everything
//   node scripts/demo.mjs --local    uses the clones in ../ when they exist
//
// The demo is the app's own fixture path, one directory per repository under
// web/public/demo, plus an index the Project menu reads. Nothing about the
// canvas is special-cased for it: what a visitor sees is the same decode,
// layout and render the desktop app runs, which is the only way a demo is
// worth anything as a demo.
//
// Generated rather than committed. The dumps are megabytes of somebody else's
// source, they go stale the moment those repositories move, and the workflow
// that deploys the site runs this first, so the site is always built from the
// heads of the four repositories rather than from whatever was checked in.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web', 'public', 'demo');
// Not under target/: Swatinem/rust-cache walks that tree in the workflow and
// reported a failure for every directory of a clone it had listed and then not
// found, which is noise on a green run.
const work = join(root, '.demo-src');

/**
 * The four, in the order the menu shows them.
 *
 * Every one is public, which is the whole selection rule: a demo has to be
 * something a visitor could clone and open themselves, or the picture proves
 * nothing. Between them they cover the range the layout has to hold up in,
 * from a project that is one file to one of 478, and four languages.
 */
const REPOS = [
  {
    id: 'pathsim',
    label: 'pathsim',
    repo: 'pathsim/pathsim',
    about: 'Python. Block-based time-domain system simulation.',
  },
  {
    id: 'rslab',
    label: 'rslab',
    repo: 'milanofthe/rslab',
    about: 'Rust. Sparse direct solver, LDL and LU.',
  },
  {
    id: 'rapidfem',
    label: 'rapidfem',
    repo: 'milanofthe/rapidfem',
    about: 'Rust, Python and Svelte. Electromagnetic FEM solver.',
  },
  {
    id: 'nanospice',
    label: 'nanospice',
    repo: 'milanofthe/nanospice',
    about: 'Rust. A SPICE circuit simulator in one file.',
  },
];

const local = process.argv.includes('--local');

/** A checkout to dump: a sibling clone when asked for and present, otherwise
 *  a shallow clone of the head. */
function sourceFor(entry) {
  const sibling = join(root, '..', entry.id);
  if (local && existsSync(sibling)) return sibling;
  const dir = join(work, entry.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  console.log(`cloning ${entry.repo}`);
  execFileSync(
    'git',
    ['clone', '--depth', '1', '--quiet', `https://github.com/${entry.repo}.git`, dir],
    { stdio: 'inherit' },
  );
  return dir;
}

mkdirSync(out, { recursive: true });
const index = [];

for (const entry of REPOS) {
  const src = sourceFor(entry);
  const dir = join(out, entry.id);
  const t0 = Date.now();
  execFileSync(
    'cargo',
    ['run', '--release', '-q', '-p', 'sanity-core', '--example', 'dump', '--', src, dir],
    { cwd: root, stdio: 'inherit' },
  );
  const scan = JSON.parse(readFileSync(join(dir, 'scan.json'), 'utf8'));
  const lines = scan.files.reduce((n, f) => n + f.lineCount, 0);
  index.push({
    id: entry.id,
    label: entry.label,
    about: entry.about,
    url: `https://github.com/${entry.repo}`,
    files: scan.files.length,
    lines,
  });
  console.log(
    `${entry.id}: ${scan.files.length} files, ${lines.toLocaleString('en-US')} lines, ` +
      `${Math.round((Date.now() - t0) / 1000)} s`,
  );
}

writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`\nwrote ${index.length} repositories to web/public/demo`);
