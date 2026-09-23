// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  branchHues, labelAlpha, labelAt, placeLabels, type Box, type ScreenDir,
} from './dirlabels.ts';
import type { DirNode } from './layout/tree.ts';

const OPTS = { vw: 1400, vh: 900, advance: 0.6, dpr: 2 };

const dir = (path: string, depth: number, x: number, y: number, w: number, h: number): ScreenDir => ({
  path, name: path.split('/').pop()!, depth, x, y, w, h,
});

const apart = (a: Box, b: Box) =>
  a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

test('a directory is named once it is large enough, and more so the larger', () => {
  let last = 0;
  for (const side of [100, 150, 160, 170, 300]) {
    const b = { x: 0, y: 0, w: side, h: side };
    const a = labelAlpha(b, b, 6, 0.6);
    assert.ok(a >= last, `${side} px: ${a} after ${last}`);
    last = a;
  }
  assert.equal(labelAlpha({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }, 6, 0.6), 0);
  assert.equal(last, 1);
});

test('a directory too small for its name gets none', () => {
  const b = { x: 0, y: 0, w: 60, h: 400 };
  assert.equal(labelAlpha(b, b, 20, 0.6), 0);
  const flat = { x: 0, y: 0, w: 900, h: 40 };
  assert.equal(labelAlpha(flat, flat, 4, 0.6), 0);
});

test('labels sit in their corner, never overlap and stay inside', () => {
  // A parent with children tiled inside it, the first one in its corner.
  const dirs = [
    dir('a', 1, 0, 0, 700, 900),
    dir('b', 1, 700, 0, 700, 900),
    dir('a/x', 2, 2, 4, 340, 440),
    dir('a/y', 2, 350, 4, 340, 440),
    dir('a/z', 2, 2, 450, 690, 440),
    dir('b/w', 2, 702, 4, 690, 880),
  ];
  const p = placeLabels(dirs, OPTS);
  // a/x and b/w are in their parents' corners.
  assert.deepEqual(p.labels.map((l) => l.path), ['a', 'b', 'a/y', 'a/z']);
  for (let i = 0; i < p.labels.length; i++) {
    const l = p.labels[i];
    const d = dirs.find((x) => x.path === l.path)!;
    assert.equal(l.plate.x, d.x, `${l.path} across`);
    assert.equal(l.plate.y, d.y, `${l.path} down`);
    assert.ok(l.plate.x + l.plate.w <= d.x + d.w && l.plate.y + l.plate.h <= d.y + d.h, `${l.path} inside`);
    for (let j = 0; j < i; j++) assert.ok(apart(l.plate, p.labels[j].plate), `${l.path} on ${p.labels[j].path}`);
  }
  // The child in its parent's corner is left out rather than moved away
  // from its own.
  assert.ok(!p.labels.some((l) => l.path === 'a/x'));
});

test('the directories the view is inside of become the breadcrumb', () => {
  // Zoomed into a/x: both reach past the top left of the screen.
  const dirs = [
    dir('a', 1, -3000, -2000, 6000, 5000),
    dir('a/x', 2, -1000, -500, 3000, 2000),
    dir('a/x/k', 3, 100, 300, 500, 400),
  ];
  const p = placeLabels(dirs, OPTS);
  assert.deepEqual(p.crumb?.crumbs.map((c) => c.path), ['a', 'a/x']);
  assert.deepEqual(p.labels.map((l) => l.path), ['a/x/k']);
  for (const l of p.labels) assert.ok(apart(l.plate, p.crumb!.plate));
  // And a click on a crumb lands on its directory.
  const c = p.crumb!.crumbs[1].box;
  assert.equal(labelAt(p, c.x + 1, c.y + c.h / 2), 'a/x');
  assert.equal(labelAt(p, 1300, 850), null);
});

test('a directory whose corner is off screen keeps its label in view', () => {
  // Not holding the centre, so not in the breadcrumb.
  const dirs = [dir('side', 1, -500, -200, 900, 1000)];
  const p = placeLabels(dirs, OPTS);
  assert.equal(p.crumb, null);
  assert.equal(p.labels.length, 1);
  assert.deepEqual([p.labels[0].plate.x, p.labels[0].plate.y], [0, 0]);
});

test('a corner between device pixels is snapped the way the frame is', () => {
  const p = placeLabels([dir('a', 1, 10.3, 20.8, 600, 600)], OPTS);
  assert.deepEqual([p.labels[0].plate.x, p.labels[0].plate.y], [10.5, 21]);
});

test('a breadcrumb wider than the view drops from the front', () => {
  const long = 'a'.repeat(60);
  const dirs = [0, 1, 2, 3].map((i) =>
    dir([long, long, long, long].slice(0, i + 1).join('/'), i + 1, -100 - i, -100 - i, 3000, 3000));
  const p = placeLabels(dirs, { ...OPTS, vw: 800 });
  const c = p.crumb!;
  assert.ok(c.plate.x + c.plate.w <= 800, `${c.plate.x + c.plate.w} wide`);
  assert.equal(c.crumbs[c.crumbs.length - 1].path, dirs[3].path);
  assert.equal(c.seps[0].text.startsWith('..'), true);
});

const node = (path: string, area: number, children: DirNode[] = []): DirNode => ({
  kind: 'dir', name: path.split('/').pop()!, path, children, depth: path ? path.split('/').length : 0,
  area, minW: 1, minH: 1, maxAspect: 1, x: 0, y: 0, w: 0, h: 0,
});

test('branches take hues in turn, below the trunk, and pass them down', () => {
  const root = node('', 100, [
    node('src', 90, [
      node('src/core', 50, [node('src/core/deep', 20)]),
      node('src/ui', 30),
      node('src/cli', 5),
    ]),
  ]);
  const hues = branchHues(root, 6);
  // src holds nearly all of the project, so it is trunk, not a branch.
  assert.equal(hues.get(''), -1);
  assert.equal(hues.get('src'), -1);
  const core = hues.get('src/core')!;
  assert.ok(core >= 0);
  assert.equal(hues.get('src/core/deep'), core);
  const three = new Set([core, hues.get('src/ui'), hues.get('src/cli')]);
  assert.equal(three.size, 3);
});

test('a theme with fewer hues cycles through them', () => {
  const root = node('', 100, [node('a', 40), node('b', 30), node('c', 20)]);
  const hues = branchHues(root, 2);
  assert.ok([...hues.values()].every((h) => h < 2));
  assert.equal(hues.get('a'), hues.get('c'));
});
