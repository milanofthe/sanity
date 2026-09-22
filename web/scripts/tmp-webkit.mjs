import { webkit, chromium } from 'playwright';
import { chromiumPath } from './browser.mjs';

const url = 'http://localhost:5183/demo/pathsim/media/';
// pick a real picture from the demo dump
const { readdirSync } = await import('node:fs');
const dir = 'web/public/demo/pathsim/media';
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
const files = walk(dir).filter((f) => f.endsWith('.png')).slice(0, 3);
const rel = files.map((f) => f.replace('web/public', ''));
console.log('testing with', rel);

for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
  const browser = await type.launch(
    name === 'chromium' ? { executablePath: chromiumPath(), args: ['--use-gl=angle', '--use-angle=metal'] } : {},
  );
  const page = await browser.newPage();
  await page.goto('http://localhost:5183/', { waitUntil: 'load' });
  const out = await page.evaluate(async (paths) => {
    const rows = [];
    for (const p of paths) {
      const bytes = await fetch(p).then((r) => r.arrayBuffer());
      const t0 = performance.now();
      const full = await createImageBitmap(new Blob([bytes]));
      const tFull = performance.now() - t0;
      const t1 = performance.now();
      const small = await createImageBitmap(new Blob([bytes]), { resizeWidth: 128, resizeQuality: 'high' });
      const tSmall = performance.now() - t1;
      rows.push({
        file: p.split('/').pop(),
        source: `${full.width}x${full.height}`,
        asked: 128,
        got: `${small.width}x${small.height}`,
        fullMs: Math.round(tFull),
        levelMs: Math.round(tSmall),
      });
      full.close(); small.close();
    }
    return rows;
  }, rel);
  console.log(`\n${name}`);
  for (const r of out) console.log(`  ${r.file}: source ${r.source}, asked for 128 wide, got ${r.got} · full decode ${r.fullMs} ms, level decode ${r.levelMs} ms`);
  await browser.close();
}
