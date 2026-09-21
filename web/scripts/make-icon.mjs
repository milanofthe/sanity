// Generates the mark in its three forms: assets/sanity-icon.svg for the app
// icon, web/public/favicon.svg for the browser tab, and the Svelte component
// the toolbar draws.
//
// Generated from one description so the three cannot drift. The identity is
// the same drawing everywhere it appears, which is the point of having one.
//
// The mark is what the app draws: a project as panels sized by how much code
// is in them, one of them just changed. Charcoal, white and the signature red,
// which is the whole palette.
//
// Generated rather than hand-written because the two variants differ in
// proportion and detail and have to stay the same drawing otherwise:
//
//   The app icon follows Apple's grid, a body of 824 in a 1024 canvas with a
//   185 radius. Filling the canvas instead makes it sit visibly larger than
//   its neighbours in the Dock.
//
//   The favicon is full bleed with a smaller radius, drops the code texture,
//   and splits into four panels rather than five. It is read at sixteen
//   pixels, where the texture is noise, a heavy radius eats the silhouette and
//   a fifth panel is two pixels of grey between two others.

import { writeFileSync } from 'node:fs';

const CHARCOAL = '#16181a';
const WHITE = '#f4f5f6';
const GREY = '#c3c8cc';
const RED = '#ff2020';

/** Indentation and length per line, in units of the panel's own width. */
const LINES = [
  [0, 0.67], [0, 0.47], [0.08, 0.56], [0.08, 0.42], [0.16, 0.51], [0.16, 0.33],
  [0.08, 0.6], [0, 0.36], [0, 0.65], [0.08, 0.45], [0.08, 0.54], [0.16, 0.29],
];

/**
 * A squarified split of `box`: one large panel, one changed, and either three
 * or two beside them. Three at the sizes where they are distinguishable, two
 * where they would not be.
 */
function panels(box, rows) {
  const gap = box.w * 0.038;
  const leftW = Math.round((box.w - gap) * 0.605);
  const rightX = box.x + leftW + gap;
  const rightW = box.x + box.w - rightX;
  const topH = Math.round((box.h - gap) * 0.618);
  const bottomY = box.y + topH + gap;
  const rowH = (box.h - (rows - 1) * gap) / rows;
  const fills = rows === 3 ? [WHITE, GREY, WHITE] : [WHITE, GREY];

  const out = [
    { x: box.x, y: box.y, w: leftW, h: topH, fill: WHITE, code: true },
    { x: box.x, y: bottomY, w: leftW, h: box.y + box.h - bottomY, fill: RED },
  ];
  for (let i = 0; i < rows; i++) {
    out.push({
      x: rightX,
      y: box.y + i * (rowH + gap),
      w: rightW,
      h: rowH,
      fill: fills[i],
    });
  }
  return out;
}

function codeLines(p) {
  const pad = p.w * 0.075;
  const lh = p.h * 0.066;
  const bar = lh * 0.42;
  const out = [];
  for (let i = 0; i < LINES.length; i++) {
    const y = p.y + pad + i * lh;
    if (y + bar > p.y + p.h - pad) break;
    const [indent, len] = LINES[i];
    const x = p.x + pad + indent * p.w;
    const w = Math.min(len * p.w, p.x + p.w - pad - x);
    if (w <= 0) continue;
    out.push(
      `  <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(bar)}" ` +
        `rx="${r(bar * 0.3)}" fill="${CHARCOAL}" opacity="0.8"/>`,
    );
  }
  return out;
}

const r = (v) => Math.round(v * 10) / 10;

function build({ body, radius, code, rows }) {
  const inset = body.w * 0.115;
  const box = {
    x: body.x + inset,
    y: body.y + inset,
    w: body.w - 2 * inset,
    h: body.h - 2 * inset,
  };
  const out = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">',
    '  <title>sanity</title>',
    `  <rect x="${body.x}" y="${body.y}" width="${body.w}" height="${body.h}" ` +
      `rx="${radius}" fill="${CHARCOAL}"/>`,
  ];
  for (const p of panels(box, rows)) {
    out.push(
      `  <rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.w)}" height="${r(p.h)}" ` +
        `rx="${r(box.w * 0.016)}" fill="${p.fill}"/>`,
    );
    if (code && p.code) out.push(...codeLines(p));
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

// Apple's grid: a body of 824 centred in 1024, radius 185.
writeFileSync(
  'assets/sanity-icon.svg',
  build({ body: { x: 100, y: 100, w: 824, h: 824 }, radius: 185, code: true, rows: 3 }),
);
writeFileSync(
  'web/public/favicon.svg',
  build({ body: { x: 0, y: 0, w: 1024, h: 1024 }, radius: 112, code: false, rows: 2 }),
);
// The toolbar mark: the favicon's geometry, with the theme's own colours so it
// sits correctly on a light palette as well. The red is not one of them: it is
// the signature and does not follow the theme.
const themed = build({
  body: { x: 0, y: 0, w: 1024, h: 1024 },
  radius: 112,
  code: false,
  rows: 2,
})
  .replace(new RegExp(CHARCOAL, 'g'), 'var(--bg)')
  .replace(new RegExp(WHITE, 'g'), 'var(--text)')
  .replace(new RegExp(GREY, 'g'), 'var(--text-dim)')
  .replace(new RegExp(RED, 'g'), 'var(--sanity-red)')
  .replace('<title>sanity</title>\n', '')
  .replace(
    ' width="1024" height="1024"',
    ' width={height} height={height} role="img" aria-label="sanity"',
  );

writeFileSync(
  'web/src/lib/ui/SanityMark.svelte',
  `<script lang="ts">
	// Generated by web/scripts/make-icon.mjs. Edit that, not this: the same
	// drawing is the app icon and the favicon, and the three drifting apart is
	// exactly what one source of geometry is for.
	//
	// The panels take the theme's colours so the mark sits on a light palette as
	// well as a dark one. The red does not: it is the signature, and it stays
	// the one thing on screen at full saturation.
	let { height = 16 }: { height?: number } = $props();
</script>

${themed}
<style>
	svg {
		display: block;
		flex: none;
	}
</style>
`,
);

console.log('icon, favicon and SanityMark written');
