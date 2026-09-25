// Assembles the npm packages from the app the release built.
//
//   node scripts/npm-packages.mjs --version 1.10.0 --out dist/npm \
//     --mac path/to/sanity.app --win path/to/sanity.exe
//
// Three packages, the way esbuild and Biome ship native binaries: one per
// platform with the app in it, restricted by `os` and `cpu` so npm installs
// only the one that fits, and `@milanofthe/sanity`, which has the `sanity`
// command and lists the others as optional dependencies. See npm/sanity/bin.
//
// A platform left out is left out of the main package's list too, which is
// only for trying it locally: a release publishes all of them.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    out: { type: 'string', default: 'dist/npm' },
    mac: { type: 'string' },
    win: { type: 'string' },
  },
});
const root = resolve(import.meta.dirname, '..');
const version = values.version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const out = resolve(values.out);
rmSync(out, { recursive: true, force: true });

const common = {
  version,
  license: 'MIT',
  author: 'Milan Rother',
  homepage: 'https://sanity.milanrother.com',
  repository: { type: 'git', url: 'git+https://github.com/milanofthe/sanity.git' },
};

const platforms = [
  { id: 'darwin-universal', from: values.mac, as: 'sanity.app', os: ['darwin'], cpu: ['x64', 'arm64'], what: 'macOS, Intel and Apple Silicon' },
  { id: 'win32-x64', from: values.win, as: 'sanity.exe', os: ['win32'], cpu: ['x64'], what: 'Windows x64' },
];

const included = [];
for (const p of platforms) {
  if (!p.from) continue;
  if (!existsSync(p.from)) throw new Error(`${p.from} does not exist`);
  const name = `@milanofthe/sanity-${p.id}`;
  const dir = join(out, `sanity-${p.id}`);
  mkdirSync(dir, { recursive: true });
  // `cp -R` keeps the modes, which is what keeps the app executable.
  cpSync(p.from, join(dir, p.as), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    ...common,
    description: `sanity for ${p.what}. Installed by @milanofthe/sanity; use that one.`,
    os: p.os,
    cpu: p.cpu,
    files: [p.as],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nThe app for ${p.what}. Install [@milanofthe/sanity](https://www.npmjs.com/package/@milanofthe/sanity), which picks this one when it fits.\n`);
  included.push(name);
}

const main = join(out, 'sanity');
cpSync(join(root, 'npm/sanity'), main, { recursive: true });
writeFileSync(join(main, 'package.json'), `${JSON.stringify({
  name: '@milanofthe/sanity',
  ...common,
  description: 'Every file of a repository on one canvas, live and back through its git history',
  keywords: ['repository', 'visualization', 'code', 'git', 'history', 'treemap', 'monitor'],
  bin: { sanity: 'bin/sanity.js' },
  files: ['bin', 'README.md'],
  engines: { node: '>=18' },
  optionalDependencies: Object.fromEntries(included.map((n) => [n, version])),
}, null, 2)}\n`);

console.log(`npm packages ${version} in ${out}: @milanofthe/sanity, ${included.join(', ') || 'no platforms'}`);
