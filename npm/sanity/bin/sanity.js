#!/usr/bin/env node
// The `sanity` command, as npm installs it.
//
// The app itself is in one of this package's optional dependencies, one per
// platform, of which npm installs the one that fits the machine: the way
// esbuild and Biome ship their binaries, so nothing is downloaded at install
// time and nothing needs a postinstall script. This finds that one and starts
// the app on a folder, the one given or the one it is run in, and returns, as
// `code .` does: the app is a window, not a process to wait on.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Where the app is in each platform's package. */
const PLATFORMS = {
  darwin: { pkg: '@milanofthe/sanity-darwin-universal', bin: 'sanity.app/Contents/MacOS/sanity' },
  'win32-x64': { pkg: '@milanofthe/sanity-win32-x64', bin: 'sanity.exe' },
};

const USAGE = `usage: sanity [folder] [--wait]

Opens the folder, or the current one, in sanity.
  --wait    stay attached until the window is closed, and show its log`;

function fail(message) {
  process.stderr.write(`sanity: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${require('../package.json').version}\n`);
  process.exit(0);
}
const wait = args.includes('--wait');
const folder = path.resolve(args.find((a) => !a.startsWith('-')) ?? '.');
if (!fs.existsSync(folder)) fail(`no such folder: ${folder}`);

// A Mac is one build for Intel and Apple Silicon both.
const platform = PLATFORMS[process.platform] ?? PLATFORMS[`${process.platform}-${process.arch}`];
if (!platform) {
  fail(
    `there is no build for ${process.platform} ${process.arch} yet.\n` +
      'The website runs anywhere: https://sanity.milanrother.com\n' +
      'Or build it from source: https://github.com/milanofthe/sanity',
  );
}

let binary;
try {
  binary = path.join(path.dirname(require.resolve(`${platform.pkg}/package.json`)), platform.bin);
} catch {
  fail(
    `${platform.pkg} is not installed. It is an optional dependency, so an install ` +
      'with --no-optional or --omit=optional leaves it out; install again without it.',
  );
}
if (!fs.existsSync(binary)) fail(`the app is missing from ${platform.pkg}: ${binary}`);
// Kept executable, in case whatever unpacked the package did not keep the
// mode it was packed with.
try {
  fs.accessSync(binary, fs.constants.X_OK);
} catch {
  try {
    fs.chmodSync(binary, 0o755);
  } catch {
    // Reported by the spawn below if it matters.
  }
}

const child = spawn(binary, [folder], {
  cwd: folder,
  detached: !wait,
  stdio: wait ? 'inherit' : 'ignore',
  windowsHide: false,
});
child.on('error', (e) => fail(`could not start the app: ${e.message}`));
if (wait) {
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  child.unref();
}
