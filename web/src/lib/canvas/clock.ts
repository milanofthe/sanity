// The canvas's time, for what plays out over time: a camera flight, a picture
// fading in, the view coming to rest.
//
// The wall clock, except while a video is being rendered. Then a frame is
// drawn at the time it stands for, 1/60 of a second after the one before,
// however long it took to make: a frame that waited half a second for a
// history step would otherwise show every flight half a second further on,
// and the video would jump.
//
// Only for time as the picture sees it. What measures the cost of work, the
// time budgets of a frame and the timings in the status bar, stays on
// `performance.now()`, since that is about the machine and not the picture.

let virtual: number | null = null;
/** How far ahead of the wall clock a video left this one. */
let ahead = 0;

export const clock = {
  /** Milliseconds, on the timeline of `performance.now()` or ahead of it. */
  now(): number {
    return virtual ?? performance.now() + ahead;
  },
};

/** Take the clock over at the current time; it moves only by `advance`. */
export function holdClock(): void {
  virtual = clock.now();
}

export function advanceClock(ms: number): void {
  if (virtual !== null) virtual += ms;
}

/**
 * Back to the wall clock, without going back in time.
 *
 * A short video renders faster than it plays, which leaves the held clock
 * ahead of the wall. Dropping back to the wall then would put every time taken
 * during it in the future: a fade would run backwards, and the view would not
 * count as at rest until the wall caught up, a minute later for a minute of
 * video. So the clock keeps the lead instead.
 */
export function releaseClock(): void {
  if (virtual === null) return;
  ahead = Math.max(0, virtual - performance.now());
  virtual = null;
}
