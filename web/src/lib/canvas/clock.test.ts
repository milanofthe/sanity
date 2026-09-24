// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceClock, clock, holdClock, releaseClock } from './clock.ts';

test('a held clock moves only when it is advanced', async () => {
  holdClock();
  const t0 = clock.now();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clock.now(), t0);
  advanceClock(1000 / 60);
  assert.equal(clock.now(), t0 + 1000 / 60);
  releaseClock();
});

test('releasing a clock that ran ahead does not go back in time', () => {
  holdClock();
  advanceClock(60_000);
  const last = clock.now();
  releaseClock();
  assert.ok(clock.now() >= last, `${clock.now()} is before ${last}`);
  // And it runs on from there at the wall's pace.
  const a = clock.now();
  const b = clock.now();
  assert.ok(b >= a);
});
