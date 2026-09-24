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

test('a pan by whole pixels leaves what the grid rounds untouched', () => {
  // The shaders round `world * scale + rest` and add the whole pixels after,
  // so a drag, which moves by whole pixels, has to change only those. If the
  // rest moved, float error would decide which side of a half pixel a row of
  // text lands on, differently every frame.
  const cam = camera();
  cam.dpr = 2;
  cam.zoom = 9 / 14;
  cam.x = 18424.3;
  cam.y = 8281.5 + 0.5 / cam.zoom;
  const px = new Float32Array(6);
  cam.writePixels(px);
  const first = [...px];
  for (let i = 1; i <= 500; i++) {
    cam.panBy(3, -2);
    cam.writePixels(px);
    assert.equal(px[4], first[4], `rest x moved after ${i} steps`);
    assert.equal(px[5], first[5], `rest y moved after ${i} steps`);
    assert.equal(px[2] - first[2], 6 * i);
    assert.equal(px[3] - first[3], 4 * i);
  }
  assert.ok(first[4] >= 0 && first[4] < 1 && first[5] >= 0 && first[5] < 1);
});

test('the split puts a point where the clip space matrix does', () => {
  const cam = camera();
  cam.dpr = 2;
  cam.zoom = 0.37;
  cam.x = -512.25;
  cam.y = 77.1;
  const m = new Float32Array(9);
  const px = new Float32Array(6);
  cam.writeMatrix(m);
  cam.writePixels(px);
  for (const [wx, wy] of [[0, 0], [-900, 400], [1234.5, -17.25]]) {
    const cx = m[0] * wx + m[6];
    const cy = m[4] * wy + m[7];
    const viaClip = [(cx * 0.5 + 0.5) * cam.vw * cam.dpr, (cy * 0.5 + 0.5) * cam.vh * cam.dpr];
    const viaSplit = [wx * px[0] + px[4] + px[2], wy * px[1] + px[5] + px[3]];
    assert.ok(Math.abs(viaClip[0] - viaSplit[0]) < 1e-2, `x ${viaClip[0]} vs ${viaSplit[0]}`);
    assert.ok(Math.abs(viaClip[1] - viaSplit[1]) < 1e-2, `y ${viaClip[1]} vs ${viaSplit[1]}`);
  }
});
