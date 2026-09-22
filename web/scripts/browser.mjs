// Shared browser setup for the check scripts.
//
// Every check needs the same three things: a Chromium that can run WebGL2 on
// this machine, a page pointed at the dev server, and a wait until the canvas
// has something on it. That preamble was copied into eight scripts, so a fix
// to any of it reached one of them.

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';

export const base = process.env.SANITY_URL ?? 'http://localhost:5183';
export const src = process.env.SANITY_SRC ?? 'fixture=fixture';

/**
 * Playwright's bundled Chromium, newest first.
 *
 * Resolved by hand rather than left to Playwright because the checks run
 * through `npm exec` from the repo root, where Playwright's own lookup does
 * not find the cache. Undefined falls back to its default, which is right when
 * the browser was installed some other way.
 */
export function chromiumPath() {
  if (process.env.SANITY_CHROME) return process.env.SANITY_CHROME;
  const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
  if (!existsSync(cacheRoot)) return undefined;
  for (const d of readdirSync(cacheRoot)
    .filter((x) => /^chromium-\d+$/.test(x))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const c of [
      `${cacheRoot}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${cacheRoot}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    ]) {
      if (existsSync(c)) return c;
    }
  }
  return undefined;
}

/**
 * A browser with a GPU backend that supports WebGL2 on macOS.
 *
 * `args` are appended: the screenshot scripts want rasterisation flags that
 * the checks do not. `SANITY_HEADED=1` runs it in a real window, which is the
 * only way to get numbers off the actual GPU, because headless falls back to
 * SwiftShader and measures the CPU instead.
 */
export async function launch({ args = [], headless } = {}) {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless: headless ?? process.env.SANITY_HEADED !== '1',
    args: ['--use-gl=angle', '--use-angle=metal', ...args],
  });
}

/**
 * Open the app and wait until the status bar says it has finished indexing.
 *
 * The timeout is generous because a large fixture takes tens of seconds to
 * decode and lay out, and a check that gives up early reports a failure that
 * is only impatience.
 */
export async function openApp({
  width = 900,
  height = 600,
  source = src,
  quiet = false,
} = {}) {
  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  if (!quiet) page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
  await page.goto(`${base}/?${source}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const t = document.querySelector('footer')?.textContent ?? '';
      return t.length > 0 && !t.includes('indexing');
    },
    null,
    { timeout: 180000 },
  );
  await settled(page);
  return { browser, page };
}

/**
 * Wait until no panel is still settling into place.
 *
 * Panels animate in when a scene opens, so a screenshot taken the moment the
 * scan finishes catches a different picture every run. The canvas reports
 * whether anything is still moving; waiting on that is exact where waiting a
 * fixed number of milliseconds is a guess that goes stale the next time a
 * duration changes.
 */
export async function settled(page, timeout = 30000) {
  // Whatever the source still has in flight. A fixture fetches its text after
  // its structure, so the canvas can be at rest with panels that have no
  // characters in them yet, and a check that compared then would be measuring
  // the gap rather than the drawing.
  await page.evaluate(() => window.__sanity?.ready?.()).catch(() => {});
  await page
    // `app.settling()` and not `stats.settling`: the stats are written by the
    // render loop, so right after a relayout they still describe the previous
    // scene and would report a canvas at rest that has not drawn a frame yet.
    .waitForFunction(() => window.__sanity?.app?.settling?.() === false, null, { timeout })
    .catch(() => {});
  // One more frame, so the frame that set it false has been presented.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/**
 * Find a zoom that puts at least `min` panels on screen, and leave the camera
 * there.
 *
 * A fixed zoom is not a stable target: panels grew when wrapping landed, so
 * the zoom that used to show thirty of them ended up inside the interior of
 * one, and a check looking for panel borders found none to look at. Searching
 * instead means the check keeps measuring the thing it is about.
 *
 * Returns the number of panels in view, which the caller should report: a run
 * that found nothing to look at must not pass as a run that found nothing
 * wrong.
 */
export async function zoomForPanels(page, min = 20, stops = [6, 4.5, 3, 2, 1.4, 1, 0.7]) {
  return page.evaluate(
    async ([min, stops]) => {
      const app = window.__sanity.app;
      for (const ppl of stops) {
        window.__sanity.zoomTo(ppl / 14);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (app.stats.visibleFiles >= min) return app.stats.visibleFiles;
      }
      return app.stats.visibleFiles;
    },
    [min, stops],
  );
}

/**
 * Wait for a frame to be on screen before screenshotting it.
 *
 * The canvas is drawn in a continuous requestAnimationFrame loop and its
 * context does not preserve the drawing buffer, so a screenshot can land
 * between the clear and the draw and come back empty. That is not a rendering
 * bug, and it cost an afternoon to establish that once.
 */
export async function frameOnScreen(page) {
  await page.evaluate(() => {
    // The renderer draws on demand and parks itself when there is nothing to
    // draw, so asking for a frame has to ask for one. Without this a check
    // that pokes the scene and screenshots gets the frame from before it:
    // sharp-check measured the sharpening as having no effect at all.
    window.__sanity?.app?.invalidate?.();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(40);
}

/** Number of pixels that differ between two PNG screenshots. */
/**
 * Where the canvas sits in the window, in CSS pixels.
 *
 * Needed by anything that turns a world position into a screenshot position.
 * The camera works in canvas coordinates and a screenshot is of the whole
 * window, so the two differ by the toolbar above the canvas and nothing warns
 * you: a rect built without this lands 34 pixels up, and at the outermost zoom
 * a panel is 14 pixels tall, so the sample window ends up on a different file
 * altogether. Two checks got this wrong before it lived here.
 */
export async function canvasBox(page) {
  return page.evaluate(() => {
    const b = document.querySelector('canvas').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

export function pixelDiff(decodePng, a, b, threshold = 20, rect = null) {
  const A = decodePng(a);
  const B = decodePng(b);
  // `rect` in device pixels, clamped to the image. Without it a check that
  // means "this panel changed" passes on anything anywhere on screen, and a
  // relayout moves everything, so the count is large whatever happened to the
  // panel. With it the count is about the panel it named.
  const x0 = rect ? Math.max(0, Math.floor(rect.x)) : 0;
  const y0 = rect ? Math.max(0, Math.floor(rect.y)) : 0;
  const x1 = rect ? Math.min(A.width, Math.ceil(rect.x + rect.w)) : A.width;
  const y1 = rect ? Math.min(A.height, Math.ceil(rect.y + rect.h)) : A.height;
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.width + x) * 4;
      const d =
        Math.abs(A.data[i] - B.data[i]) +
        Math.abs(A.data[i + 1] - B.data[i + 1]) +
        Math.abs(A.data[i + 2] - B.data[i + 2]);
      if (d > threshold) changed++;
    }
  }
  return changed;
}
