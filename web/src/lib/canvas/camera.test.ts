// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.ts';

/** Fly and sample where a world point is on screen at each step. */
function track(cam: Camera, to: { x: number; y: number; zoom: number }, point: [number, number]) {
  const t0 = performance.now();
  cam.flyTo(to.x, to.y, to.zoom, 1);
  const out: [number, number][] = [];
  for (let i = 0; i <= 20; i++) {
    cam.update(t0 + 1 + i * 50);
    out.push(cam.worldToScreen(point[0], point[1]));
  }
  return out;
}

const camera = () => {
  const c = new Camera();
  c.vw = 1400;
  c.vh = 900;
  c.x = 0;
  c.y = 0;
  c.zoom = 0.05;
  return c;
};

test('zooming in on a point off to one side moves it in a straight line', () => {
  const cam = camera();
  const target = { x: 6000, y: -4000, zoom: 1.2 };
  const path = track(cam, target, [target.x, target.y]);
  const [a, b] = [path[0], path[path.length - 1]];
  let worst = 0;
  for (const p of path) {
    // Distance from the line through the two ends, in screen pixels.
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    worst = Math.max(worst, Math.abs(cross) / Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  assert.ok(worst < 1e-6, `strays ${worst} px from the straight line`);
  // And it gets there without passing it.
  const d = path.map((p) => Math.hypot(p[0] - b[0], p[1] - b[1]));
  for (let i = 1; i < d.length; i++) assert.ok(d[i] <= d[i - 1] + 1e-9, `step ${i} moved away`);
});

test('a flight ends exactly on its target', () => {
  const cam = camera();
  const t0 = performance.now();
  cam.flyTo(1234.5, -987.25, 0.8, 0.5);
  cam.update(t0 + 10_000);
  assert.equal(cam.x, 1234.5);
  assert.equal(cam.y, -987.25);
  assert.ok(Math.abs(cam.zoom - 0.8) < 1e-12);
  assert.equal(cam.flying, false);
});

test('a flight at the same zoom is a pan', () => {
  const cam = camera();
  const path = track(cam, { x: 3000, y: 500, zoom: 0.05 }, [0, 0]);
  // Every point moves by the same amount: the one at the centre travels a
  // straight line to where the pan leaves it.
  const [a, b] = [path[0], path[path.length - 1]];
  for (const p of path) {
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    assert.ok(Math.abs(cross) < 1e-6);
  }
  assert.equal(cam.zoom, 0.05);
  assert.equal(cam.x, 3000);
});
