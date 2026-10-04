// Cut a release: set the version, push it, publish the release with its notes.
//
//   npm run release -- 1.13.2 notes.md             does it
//   npm run release -- 1.13.2 notes.md --dry-run   shows the release, changes nothing
//
// notes.md is what changed, as it should read on the release page, usually a
// list. "Changes since" goes above it and .github/release-install.md below.
// Publishing the release is what starts .github/workflows/release.yml, which
// builds the installers and attaches them to it about fifteen minutes later.
//
// The release is made here rather than by the workflow because GITHUB_TOKEN
// stopped being allowed to create releases in this repository, and because a
// release made first goes out with its notes instead of having them added
// once the build is done.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [version, notesPath] = args.filter((a) => a !== '--dry-run');

const run = (cmd, ...rest) => execFileSync(cmd, rest, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !notesPath) {
  fail('usage: npm run release -- <x.y.z> <notes.md> [--dry-run]');
}
if (!existsSync(notesPath)) fail(`no notes at ${notesPath}`);
const notes = readFileSync(notesPath, 'utf8').trim();
if (!notes) fail(`${notesPath} is empty`);

// The version every file carries is the workspace's.
const file = (name) => join(root, name);
const cargoToml = readFileSync(file('Cargo.toml'), 'utf8');
const current = cargoToml.match(/\[workspace\.package\][^[]*?version = "([^"]+)"/)?.[1];
if (!current) fail('no [workspace.package] version in Cargo.toml');
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, current)) fail(`${version} is not after ${current}`);

// From main as it is on GitHub, so the commit the release points at is the
// one everybody has. A dry run only warns, so notes can be looked at from a
// branch.
const tag = `v${version}`;
const refuse = dry ? (msg) => console.warn(`warning: ${msg}`) : fail;
run('git', 'fetch', '-q', 'origin', 'main');
if (run('git', 'rev-parse', '--abbrev-ref', 'HEAD') !== 'main') refuse('not on main');
if (run('git', 'status', '--porcelain')) refuse('the working tree has changes');
if (run('git', 'rev-parse', 'HEAD') !== run('git', 'rev-parse', 'origin/main')) {
  refuse('HEAD is not where origin/main is');
}
if (run('git', 'ls-remote', '--tags', 'origin', tag)) fail(`${tag} exists already`);

// None of the builds are signed: there is no Apple Developer certificate and
// no Windows code signing certificate behind this repository. So every
// release says what a first launch looks like instead of leaving people at a
// dialog with no button; see issue #22.
const install = readFileSync(file('.github/release-install.md'), 'utf8').trim();
const body = `Changes since ${current}:\n\n${notes}\n\n---\n\n${install}\n`;

/** Each edit with how often it has to match, so a file that has moved on
 *  stops the release instead of being half changed. The lockfile holds the
 *  version once per workspace crate, the ones without a `source`. */
const crates = (cargoToml.match(/members = \[([^\]]*)\]/)?.[1].match(/"/g)?.length ?? 0) / 2;
const edits = [
  ['Cargo.toml', /(\[workspace\.package\][^[]*?version = ")[^"]+(")/, 1],
  ['package.json', /^(\s*"version": ")[^"]+(")/m, 1],
  ['src-tauri/tauri.conf.json', /^(\s*"version": ")[^"]+(")/m, 1],
  ['Cargo.lock', new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "[^"]+"\\r?\\nversion = ")${current.replace(/\./g, '\\.')}("\\r?\\n(?!source))`, 'g'), crates],
];
const changed = edits.map(([name, re, want]) => {
  const before = readFileSync(file(name), 'utf8');
  const hits = before.match(re.global ? re : new RegExp(re.source, re.flags + 'g'))?.length ?? 0;
  if (hits !== want) fail(`${name}: the version matched ${hits} times, expected ${want}`);
  return [name, before.replace(re, `$1${version}$2`)];
});

console.log(`${current} -> ${version}, ${changed.map(([n]) => n).join(', ')}\n`);
console.log(body);
if (dry) process.exit(0);

for (const [name, text] of changed) writeFileSync(file(name), text);
// Whether the lockfile still agrees with the manifests, before anything leaves
// this machine.
execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { cwd: root, stdio: 'ignore' });
run('git', 'commit', '-q', '-m', tag, '--', ...changed.map(([n]) => n));
run('git', 'push', '-q', 'origin', 'main');

const bodyFile = join(tmpdir(), `sanity-${tag}.md`);
writeFileSync(bodyFile, body);
try {
  const url = run('gh', 'release', 'create', tag, '--target', run('git', 'rev-parse', 'HEAD'),
    '--title', `sanity ${tag}`, '--notes-file', bodyFile);
  console.log(`${url}\nThe installers follow from the Release workflow: gh run list --workflow release.yml`);
} finally {
  rmSync(bodyFile, { force: true });
}
