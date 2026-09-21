// What a file that just changed looks like, as a function of how long ago.
//
// One clock per file, seconds since the change landed, and two things read
// from it:
//
//   flash   a bright wash over the whole panel, gone in half a second. This
//           is the "where": at the zoom where a project fits the window a
//           panel is a few pixels tall and its lines cannot be drawn at all,
//           so something has to say which panel it was, briefly and loudly.
//   mark    the bands on the lines that changed, held for a few seconds and
//           then faded out. This is the "what", and it only means anything
//           close enough to see lines.
//
// What this replaced: a single glow that decayed over ninety seconds and drove
// both. It was the wrong shape twice over. As a picture it said "this file is
// warm", which is a state, when the thing worth showing is an event: someone
// is working on the code right now and you want to see it happen. And as a
// cost it drew a frame for ninety seconds, 5400 for one save, because a value
// that changes continuously has to be redrawn continuously.

import { timing } from '../metrics.ts';

/**
 * The panel flash, 1 at the moment of the change and 0 once it has passed.
 *
 * Squared, so it is bright immediately and most of the decay happens in the
 * first third. A linear fade over the same duration reads as a slow pulse
 * rather than a flash, which is the difference between noticing it from the
 * corner of your eye and having to watch for it.
 */
export function flashAt(since: number): number {
  if (!(since >= 0) || since >= timing.flash) return 0;
  const t = 1 - since / timing.flash;
  return t * t;
}

/**
 * How strongly the changed lines are banded, 1 while the mark is held and
 * ramping to 0 at the end of it.
 *
 * Held rather than decaying from the start: the bands are the answer to "which
 * lines", and an answer that is already fading while it is being read is worse
 * than one that stands still and then goes.
 */
export function markAt(since: number): number {
  if (!(since >= 0) || since >= timing.markHold) return 0;
  const left = timing.markHold - since;
  if (left >= timing.markFade) return 1;
  return left / timing.markFade;
}

/** Whether anything about this file is still being drawn from its clock. */
export function recent(since: number): boolean {
  return since >= 0 && since < timing.markHold;
}

/**
 * The mark in steps, for deciding whether a frame is needed.
 *
 * The flash is an animation and is drawn every frame it lasts; the mark sits
 * still for seconds and then fades, so redrawing it continuously would cost
 * frames for no visible difference. Twelve steps over the fade is one frame
 * every eighty milliseconds at the end, which is smooth for a ramp this slow.
 */
export const MARK_STEPS = 12;

export function markStep(since: number): number {
  return Math.ceil(markAt(since) * MARK_STEPS) / MARK_STEPS;
}
