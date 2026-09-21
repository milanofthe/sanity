// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, score } from './search.ts';

const CORPUS = [
  'web/src/lib/canvas/renderer/scene.ts',
  'web/src/lib/canvas/search.ts',
  'web/src/lib/canvas/layout/tree.ts',
  'web/src/App.svelte',
  'crates/sanity-core/src/scan.rs',
  'crates/sanity-core/src/wire.rs',
  'README.md',
];

test('an empty query matches nothing', () => {
  assert.equal(score('', 'README.md'), null);
  assert.equal(score('   ', 'README.md'), null);
  assert.deepEqual(rank('', CORPUS), []);
});

test('a name is found however it is cased', () => {
  assert.notEqual(score('readme', 'README.md'), null);
  assert.notEqual(score('README', 'readme.md'), null);
  assert.notEqual(score('Scene', 'web/src/lib/canvas/renderer/scene.ts'), null);
});

test('a hit in the file name beats a hit in the directories', () => {
  const inName = score('scene', 'a/b/scene.ts');
  const inPath = score('scene', 'scene/b/other.ts');
  assert.ok(inName !== null && inPath !== null);
  assert.ok(inName < inPath, `${inName} should sort before ${inPath}`);
});

test('a run of characters beats the same characters scattered', () => {
  const run = score('scan', 'scan.rs');
  const gaps = score('scan', 'sc_and.rs');
  assert.ok(run !== null && gaps !== null);
  assert.ok(run < gaps, `${run} should sort before ${gaps}`);
});

test('typing a name finds that file first', () => {
  for (const [query, want] of [
    ['scene', 'web/src/lib/canvas/renderer/scene.ts'],
    ['tree', 'web/src/lib/canvas/layout/tree.ts'],
    ['wire', 'crates/sanity-core/src/wire.rs'],
    ['app', 'web/src/App.svelte'],
    ['readme', 'README.md'],
    // A fragment of the path, which has to be contiguous there.
    ['canvas/lay', 'web/src/lib/canvas/layout/tree.ts'],
    // And a fragment of the name, which does not.
    ['tr.ts', 'web/src/lib/canvas/layout/tree.ts'],
  ] as const) {
    const first = rank(query, CORPUS)[0];
    assert.equal(first?.path, want, `"${query}" found ${first?.path}`);
  }
});

test('a query that matches nothing ranks nothing', () => {
  assert.deepEqual(rank('zzzz', CORPUS), []);
});

test('characters scattered across a path are not a match', () => {
  // Measured on 988 real files: allowing this made "renderer" match fifteen
  // of them in a project with no renderer, and the best of the fifteen was a
  // report.md. A search that highlights has to be able to say no.
  assert.equal(score('renderer', 'examples/inverse_design/02_filter_design/report.md'), null);
  assert.deepEqual(rank('renderer', CORPUS), [
    { path: 'web/src/lib/canvas/renderer/scene.ts', score: score('renderer', 'web/src/lib/canvas/renderer/scene.ts') as number },
  ]);
});

test('the earlier hit wins inside a tier', () => {
  const early = score('ab', 'abcd.ts');
  const late = score('ab', 'xxab.ts');
  assert.ok(early !== null && late !== null && early < late);
});

test('the shorter name wins when the position is the same', () => {
  const short = score('ab', 'ab.ts');
  const long = score('ab', 'abcdefghij.ts');
  assert.ok(short !== null && long !== null && short < long);
});

test('the order does not depend on the input order', () => {
  const a = rank('s', CORPUS).map((r) => r.path);
  const b = rank('s', [...CORPUS].reverse()).map((r) => r.path);
  assert.deepEqual(a, b);
});

test('a subsequence has to keep its order', () => {
  // Every letter present is not a match: "ent" is in "scene.ts" in order,
  // "tne" is not.
  assert.notEqual(score('ent', 'scene.ts'), null);
  assert.equal(score('tne', 'scene.ts'), null);
});
