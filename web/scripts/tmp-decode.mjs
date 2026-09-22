import { webkit } from 'playwright';
import { readdirSync, statSync } from 'node:fs';
const dir = 'web/public/demo/home/media/static/images';
const files = readdirSync(dir).filter((f) => f.endsWith('.png')).slice(0, 6);
const rel = files.map((f) => `/demo/home/media/static/images/${f}`);
const browser = await webkit.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5183/', { waitUntil: 'load' });
const rows = await page.evaluate(async (paths) => {
  const out = [];
  for (const p of paths) {
    const bytes = await fetch(p).then((r) => r.arrayBuffer());
    const run = async (opts) => {
      const t = performance.now();
      const b = await createImageBitmap(new Blob([bytes]), opts);
      const ms = performance.now() - t;
      const size = `${b.width}x${b.height}`;
      b.close();
      return { ms: Math.round(ms), size };
    };
    await run({});                                     // warm the codec
    const full = await run({});
    const high = await run({ resizeWidth: 256, resizeQuality: 'high' });
    const medium = await run({ resizeWidth: 256, resizeQuality: 'medium' });
    const low = await run({ resizeWidth: 256, resizeQuality: 'low' });
    const pixelated = await run({ resizeWidth: 256, resizeQuality: 'pixelated' });
    out.push({ file: p.split('/').pop(), kb: Math.round(bytes.byteLength / 1024), full, high, medium, low, pixelated });
  }
  return out;
}, rel);
for (const r of rows) {
  console.log(
    `${r.file.padEnd(34)} ${String(r.kb).padStart(5)} KB  ${r.full.size.padEnd(10)}` +
      ` full ${String(r.full.ms).padStart(4)}  high ${String(r.high.ms).padStart(4)}` +
      `  medium ${String(r.medium.ms).padStart(4)}  low ${String(r.low.ms).padStart(4)}` +
      `  pixelated ${String(r.pixelated.ms).padStart(4)}`,
  );
}
await browser.close();
