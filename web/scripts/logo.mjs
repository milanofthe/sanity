// The wordmark, drawn rather than traced: every letter and both rails as a
// centre line of straight runs and round corners, stroked at one weight.
//
// The original, assets/sanity-logo.png, is a monoline: the letters, the two
// rails that frame the word and the S that runs out of the top one all have
// the same stroke, about 48 of its 465 pixels. So the drawing is the centre
// lines and that one number, and the weight can change without anything else
// having to be redrawn. Coordinates are the original's pixels, so the two can
// be laid over each other; see `npm run logo-check`, which renders both.

/** The original's stroke, in its pixels. */
export const ORIGINAL_STROKE = 48;

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * A polyline with round corners, as path data. `corners[i]` is the radius at
 * vertex i, for the vertices between the ends; the arcs are tangent to both
 * runs, and a radius the runs are too short for is reduced to fit.
 */
export function rounded(points, corners = []) {
  let d = `M${r2(points[0][0])} ${r2(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const [cx, cy] = points[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay);
    const l2 = Math.hypot(cx - bx, cy - by);
    const u = [(bx - ax) / l1, (by - ay) / l1];
    const v = [(cx - bx) / l2, (cy - by) / l2];
    const turn = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    let r = corners[i - 1] ?? 0;
    if (r <= 0 || turn < 1e-6) {
      d += `L${r2(bx)} ${r2(by)}`;
      continue;
    }
    // Half of each run at most: a corner never eats into the next one's.
    const t = Math.min(r * Math.tan(turn / 2), l1 / 2, l2 / 2);
    r = t / Math.tan(turn / 2);
    const sweep = u[0] * v[1] - u[1] * v[0] > 0 ? 1 : 0;
    d += `L${r2(bx - u[0] * t)} ${r2(by - u[1] * t)}`;
    d += `A${r2(r)} ${r2(r)} 0 0 ${sweep} ${r2(bx + v[0] * t)} ${r2(by + v[1] * t)}`;
  }
  const [ex, ey] = points[points.length - 1];
  return `${d}L${r2(ex)} ${r2(ey)}`;
}

/**
 * The wordmark's geometry at stroke `t`.
 *
 * Returns the strokes, which are drawn with butt caps, and the strokes that
 * are cut level at the x-height, the arms of the y, which are drawn clipped:
 * a butt cap is square to the stroke, and a diagonal ending square would
 * poke above the letters beside it.
 */
export function wordmark(t = ORIGINAL_STROKE, { letters = true } = {}) {
  const c = t / 2;
  // What grows with the stroke is the ink, not the white: the gaps between
  // the rails and the letters, and inside the letters, stay the original's.
  const grow = t - ORIGINAL_STROKE;
  const xTop = t + 37; // top of the x-height, under the top rail
  const xHeight = 274;
  const base = xTop + xHeight; // the letters stand on this
  const height = base + 60 + t; // and the bottom rail runs under them
  const railTop = c;
  const railBottom = height - c;

  const strokes = [];
  const clipped = [];
  let x = 0;

  // S, and the top rail it runs out of. Its bottom bar runs out to the left
  // edge on the baseline.
  const sW = 192 + grow;
  const sLeft = 12 + c;
  const sRight = sW - c;
  const sBar = base;
  const sTopTurn = xTop + 50;
  const sBottomTurn = sBar - 121;
  x = sW;

  // The mark, for the places that want a square: the S and the y and the
  // frame they make, with the letters between left out and the two brought
  // together, about a letter's gap apart.
  if (!letters) x += 76 + grow;

  // a: an arch from a cut terminal over to the stem, and a bowl hung off the
  // stem.
  // Each letter where the original has it, and moved right by what the
  // heavier strokes before it have added, so the white between them stays.
  if (letters) x = 252 + grow * 1.5;
  const aW = 163 + grow * 1.5;
  const aL = x + c;
  const aR = x + aW - c;
  const aTerm = xTop + 77;
  const aBowl = xTop + 112 + c;
  const aArch = 78 + grow / 2;
  const bowlH = base - c - aBowl;
  if (letters) {
    // The arch starts a little in from the bowl's left edge, as the
  // original's does.
  strokes.push(rounded([[aL + 5, aTerm], [aL + 5, xTop + c], [aR, xTop + c], [aR, base]], [aArch, aArch]));
    strokes.push(rounded(
      [[aR, aBowl], [aL, aBowl], [aL, base - c], [aR, base - c]],
      [bowlH / 2, bowlH / 2],
    ));
    x += aW;
  }

  // n: a stem, and an arch that starts inside it, so its end is covered.
  if (letters) x = 471 + grow * 3.5;
  const nW = 164 + grow * 1.5;
  const nL = x + c;
  const nR = x + nW - c;
  const nArch = 72 + grow / 2;
  if (letters) {
    strokes.push(rounded([[nL, xTop], [nL, base]]));
    strokes.push(rounded([[nL, xTop + c + nArch + 10], [nL, xTop + c], [nR, xTop + c], [nR, base]], [nArch, nArch]));
    x += nW;

    // A dotless i.
    x = 702 + grow * 5.5;
    strokes.push(rounded([[x + c, xTop], [x + c, base]]));
    x += t;

    // T: a stem hung from the top rail.
    x = 821 + grow * 7;
    const tStem = x + c;
    strokes.push(rounded([[tStem, 0], [tStem, base]]));
    x += t;

    x = 928 + grow * 8.5;
  }

  // y: the right arm runs down into the bottom rail and along it to the left
  // edge, which closes the frame the S opened.
  const yW = 183 + grow * 1.2;
  // The arms' run over their fall: the original's right arm, along its outer
  // edge.
  const slope = 72 / 299;
  // Where each arm's centre line crosses the x-height, which is where it is
  // cut: a slanted stroke is wider across than its weight, by the secant.
  const across = c * Math.hypot(1, slope);
  const yR = x + yW - across;
  const yL = x + across;
  // Started a stroke's width above the cut, along the same line.
  const above = t;
  const start = (at, dir) => [at + dir * slope * above, xTop - above];
  const yCorner = [yR - slope * (railBottom - xTop), railBottom];
  // The left arm falls at the original's angle, along its outer edge, until
  // it meets the right one's centre line.
  const joinY = xTop + 250 + grow;
  const joinX = yR - slope * (joinY - xTop);
  clipped.push(rounded([start(yR, 1), yCorner, [0, railBottom]], [70]));
  clipped.push(rounded([start(yL, -1), [joinX, joinY]]));
  x += yW;

  const width = x;
  strokes.unshift(rounded(
    [[width, railTop], [sLeft, railTop], [sLeft, sTopTurn], [sRight, sBottomTurn], [sRight, sBar], [0, sBar]],
    [70, 28, 28, 70],
  ));
  return { width: r2(width), height: r2(height), stroke: t, xTop, strokes, clipped };
}

/**
 * The wordmark as an SVG body in `color`, for a viewBox of its own size: the
 * strokes, and the arms of the y clipped at the x-height. `id` names the clip,
 * which has to be unique in the document it lands in.
 */
export function wordmarkBody(w, color, id = 'sanity-cut', transform = '') {
  const lines = [
    `<clipPath id="${id}"><rect x="0" y="${w.xTop}" width="${w.width}" height="${w.height - w.xTop}"/></clipPath>`,
    `<g${transform ? ` transform="${transform}"` : ''} fill="none" stroke="${color}" stroke-width="${w.stroke}" stroke-linecap="butt" stroke-linejoin="miter">`,
    ...w.strokes.map((d) => `  <path d="${d}"/>`),
    `  <g clip-path="url(#${id})">`,
    ...w.clipped.map((d) => `    <path d="${d}"/>`),
    '  </g>',
    '</g>',
  ];
  return lines.join('\n');
}
