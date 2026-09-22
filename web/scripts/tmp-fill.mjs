// How long until every picture on screen actually has its pixels.
import { base, launch } from './browser.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const t0 = Date.now();
await page.goto(`${base}/?demo=${process.env.SANITY_DEMO ?? 'home'}`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 90000 });
const up = Date.now() - t0;
const out = await page.evaluate(async (start) => {
  const app = window.__sanity.app;
  const pictures = [...app.scene.files.values()].filter((f) => f.node.media?.kind === 'image');
  const marks = [];
  const began = performance.now();
  for (let i = 0; i < 400; i++) {
    const held = pictures.filter((f) => app.scene.media?.have(f.node.path)).length;
    marks.push({ ms: Math.round(performance.now() - began), held });
    if (held >= pictures.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = app.scene.media.stats();
  return {
    pictures: pictures.length,
    marks: marks.filter((m, i) => i === 0 || i === marks.length - 1 || m.held !== marks[i - 1].held),
    stats: {
      decodes: s.decodes,
      decodeMs: Math.round(s.decodeMs),
      fetchMs: Math.round(s.fetchMs),
      uploadMs: Math.round(s.uploadMs),
    },
  };
}, t0);
console.log(`canvas up after ${up} ms, ${out.pictures} pictures`);
// The point where it stops climbing: the rest are pictures off screen, which
// are never asked for.
let settled = out.marks[0];
for (const m of out.marks) {
  if (m.held > settled.held) settled = m;
}
console.log(`${settled.held} of ${out.pictures} drawn after ${settled.ms} ms`);
console.log(
  `fetching ${out.stats.fetchMs} ms, decoding ${out.stats.decodeMs - out.stats.fetchMs} ms, ` +
    `uploading ${out.stats.uploadMs} ms in total, over ${out.stats.decodes} decodes`,
);
const steps = out.marks.filter((_, i) => i % Math.ceil(out.marks.length / 8) === 0);
console.log(steps.map((m) => `${m.ms}ms: ${m.held}`).join('  '));
await browser.close();
