// Rendering what is on the canvas to a PNG.
//
// A screenshot of the window is capped at the window, and this app is mostly
// used with a thousand panels in it, where that means a file is a line and a
// line is nothing. So the export renders the scene again into a 4K frame,
// which is a different picture rather than a bigger one: every level of detail
// follows from pixels per line, so a panel that was eight pixels wide on
// screen is twenty here and has its tokens in it.
//
// Two regions, which are the two things anyone wants: the view, for showing
// what you are looking at, and the whole project, which is the one that makes
// a wallpaper.

import type { CanvasApp } from '$lib/canvas/app';
import { project } from '$lib/state/project.svelte';
import { inTauri, savePng } from '$lib/sources/tauri';

/** 4K in 16:9. Fixed rather than taken from the window, so an image does not
 *  need cropping before it can be posted or set as a background. */
export const IMAGE_WIDTH = 3840;
export const IMAGE_HEIGHT = 2160;

/** The project's name and the minute, which is enough to keep two exports
 *  apart without a counter. */
export function imageName(): string {
  const root = project.root.split('/').filter(Boolean).pop() || 'sanity';
  const t = new Date();
  const p = (n: number) => `${n}`.padStart(2, '0');
  const stamp =
    `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}` +
    `-${p(t.getHours())}${p(t.getMinutes())}`;
  return `${root}-${stamp}.png`;
}

/**
 * Render and save.
 *
 * Returns where it went, or null when the save was cancelled. The browser has
 * no say in where a download lands, so there it returns the file name.
 */
export async function saveImage(
  app: CanvasApp,
  region: 'view' | 'project',
): Promise<string | null> {
  const blob = await app.renderToBlob({
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    region,
  });
  const name = imageName();
  if (inTauri()) {
    return savePng(new Uint8Array(await blob.arrayBuffer()), name);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Held until the download has certainly started, then released: revoking it
  // in the same task cancels the download in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
