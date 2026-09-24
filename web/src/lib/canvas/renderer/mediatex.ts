// Pictures on the GPU, at the resolution the zoom asks for.
//
// The rule is the one the code path already follows: hold what is being
// looked at, not what exists. Measured on pathsim, whose 47 images are 191
// megapixels between them: holding their pixels would be 730 MB of texture
// against the 96 MB the whole of its code costs. At the overview zoom a panel
// is a hundred pixels wide and an image in it needs 100 by 60, which is 24 KB,
// and the one or two panels large on screen need a few megabytes. So a picture
// is decoded to the size it is drawn at, and decoded again, larger, when
// somebody zooms in.
//
// What makes that work:
//
//   levels      Target widths are powers of two, so zooming does not
//               re-decode continuously, and a level already held that is
//               large enough is used as it is.
//   a budget    One number for everything, least recently seen thrown out
//               first. Without it a pan across a directory of renders would
//               climb until the context is lost.
//   off thread  `createImageBitmap` decodes without the main thread, and
//               at most a couple run at once, so opening a project full of
//               images does not stall the first frames. The decoded source
//               is kept for a while, and every size a picture is drawn at is
//               averaged down from it on the GPU (resample.ts) rather than
//               resized by the browser, which in WebKit was grainy.
//   exact       at rest, a picture is made for exactly the pixels it
//               covers and drawn 1:1, the way text is; see `wantExact`.
//   faded       a new texture fades in over the one it replaces, so a
//               picture sharpens rather than pops.
//   paced       and spaced out in time, largest on screen first, and not at
//               all while the camera is moving. Measured on a folder of 119
//               screenshots in the engine the desktop app ships (WKWebView,
//               not Chromium): decoding them costs 4.6 seconds, which as a
//               burst is the window not answering and spread out is pictures
//               arriving one after another.

// With the extension: this module is imported by its unit tests, which run
// in Node without a bundler to resolve it.
import { clock } from '../clock.ts';
import { decodeHere, ImageDecoder, isVector, rasteriseSvg, type Pixels } from './imagedecode.ts';

// Every picture texture holds premultiplied colour. A mip chain and the
// resampling both average neighbouring texels, and a plot is mostly clear
// pixels holding whatever colour the exporter left in them, usually black.
// Averaged straight, that black is pulled into every line as soon as the
// picture is drawn smaller than its texture, and the lines come out bolder
// and darker than they are. Premultiplied, a clear texel adds nothing, which
// is what it is, and the image shader divides it back out.

/** Bytes held for image content, over all levels. 64 MB is about four full
 *  screen renders at 2048 wide, which is more than a canvas ever shows at
 *  once, and a fraction of what the code textures take. */
const BUDGET_BYTES = 64 * 1024 * 1024;

/** Narrowest and widest level. The floor is what an image is worth at the
 *  overview zoom; the ceiling is one step past a 4K export of a single
 *  panel. */
const MIN_LEVEL = 32;
const MAX_LEVEL = 2048;

/** Decodes in flight. The decode itself is off-thread, so this is about how
 *  much upload work can be queued up behind it; four keeps the thread busy
 *  without letting a burst of uploads land in one frame. */
const MAX_IN_FLIGHT = 4;

/**
 * Main-thread milliseconds a frame may spend bringing pictures in.
 *
 * Only the upload is charged against it. Decoding happens off the main thread
 * and waiting for it blocks nothing, so charging the decode here was charging
 * the budget for work the frame never did: a hundred thumbnails, whose
 * uploads cost 1.3 ms each, were being paced as though they cost six.
 *
 * Twelve of a sixteen millisecond frame. Measured on a folder of 118
 * pictures, from the canvas appearing to the last thumbnail on screen: 725 ms
 * at eight, 528 at sixteen, and the frame times are the same either way. The
 * two thirds is a floor under the rest of the scene rather than a number the
 * pictures needed.
 *
 * A budget rather than a fixed gap between starts. The gap was 16 ms, which
 * made sense when a decode meant reading a multi-megabyte source, and became
 * the only thing that mattered once the backend started handing over 128
 * pixel thumbnails: 118 of them took 2.5 seconds to appear, arriving one per
 * frame, while the work itself was under a second. Charged against what each
 * one actually costs, they arrive as fast as the frame can carry them and no
 * faster.
 */
const FRAME_BUDGET_MS = 12;

/** And a ceiling on the wait when a single decode is expensive, so a folder
 *  of very large sources still fills in rather than stalling. */
const MAX_GAP_MS = 200;

/** How long the camera has to be still before decoding resumes. A tenth of a
 *  second: long enough that a pan does not start work it will throw away,
 *  short enough that letting go of the trackpad feels immediate. */
const QUIET_MS = 100;

/**
 * Level up to which a request ignores all of that and starts immediately.
 *
 * The waiting is there so a pan does not spend the frame decoding sources it
 * will have moved past. That reasoning does not apply to a thumbnail: it
 * costs about a millisecond, it is what every small panel is drawn from at
 * any zoom, and it will not be thrown away by the next camera move. Measured
 * on a folder of 118 pictures: with the wait, nothing started until the
 * opening camera flight had finished and the first thumbnail appeared at 700
 * milliseconds.
 */
const CHEAP_LEVEL = 128;

/** The same, for a picture being drawn from far too little. Two frames, not
 *  zero: skipping the wait entirely meant a zoom sweep pulled full-size
 *  textures for every picture it passed through, 43 decodes and 58 MB held for
 *  panels that were gone by the time they arrived. */
const URGENT_QUIET_MS = 32;

interface Slot {
  tex: WebGLTexture;
  /** Pixel size of what is held, which is the level, not the source. */
  w: number;
  h: number;
  bytes: number;
  /** Frame counter when this was last asked for, for eviction order. */
  seen: number;
  /** Mostly transparent, so it needs a sheet under it; see `translucent`. */
  translucent: boolean;
  /** Made for exactly this many screen pixels, to be drawn 1:1; see
   *  `wantExact`. False for a power-of-two level. */
  exact: boolean;
  /** The source at its own size, which nothing can improve on: a panel
   *  larger than the picture draws it magnified. */
  native: boolean;
  /** What was drawn before this arrived, faded out over `fadeMs` so a level
   *  changing is a sharpening rather than a pop. */
  prev: WebGLTexture | null;
  prevBytes: number;
  /** When this arrived, for the fade. */
  since: number;
  /** Fading in over the placeholder, with nothing before it to fade from:
   *  the first time a picture appears. */
  fresh: boolean;
}

/** What `want` hands back when a picture is ready to draw. */
export interface Drawable {
  tex: WebGLTexture;
  w: number;
  h: number;
  translucent: boolean;
  /** Drawn 1:1 on the pixel grid rather than scaled. */
  exact: boolean;
  /** The texture it replaces, still fading out, and how far the new one is
   *  in, from 0 to 1. */
  prev: WebGLTexture | null;
}


/** Resamples a picture to an exact size; see resample.ts. Passed in rather
 *  than imported so this module stays free of the GL program code, which its
 *  unit tests cannot load. */
export interface Resampling {
  resample(src: WebGLTexture, sw: number, sh: number, dw: number, dh: number): WebGLTexture;
}

/**
 * Bytes of source pictures kept on the GPU at their own size, to resample
 * from when the camera comes to rest at a new zoom. A 3062 by 1021 render is
 * 17 MB with its mip chain, so this is a handful of them: the ones being
 * looked at, which are the ones a zoom is most likely to settle on again.
 */
const SOURCE_BUDGET_BYTES = 96 * 1024 * 1024;

/** Largest side a source is held at, whatever the context allows: a 16k
 *  scan is not worth a gigabyte of texture. */
const MAX_SOURCE = 8192;

/** Pixels a picture may fall short of its rect by and still be resampled
 *  onto it rather than asked for again; see `decodeExact`. */
const ROUNDING_PX = 2;

/** Above this share of transparent area a picture is treated as ink on a page
 *  rather than as a picture with a background of its own. A plot exported by
 *  matplotlib is near 1.0; a photograph or a screenshot is 0. */
const TRANSLUCENT_SHARE = 0.5;

/**
 * Whether a picture relies on what is behind it.
 *
 * Measured on the decoded bitmap, scaled into a 16 by 16 canvas, so it costs
 * one draw of 256 pixels rather than a second pass over the source. That is
 * enough: the question is whether the background is there at all, not where.
 *
 * Returns false when the browser will not hand the pixels back, which is the
 * safe answer: a picture on the canvas background is what this app always did.
 */
function translucent(bitmap: ImageBitmap): boolean {
  try {
    const probe =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(16, 16)
        : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const ctx = probe.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | null;
    if (!ctx) return false;
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(bitmap, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 128) clear++;
    return clear / 256 > TRANSLUCENT_SHARE;
  } catch {
    return false;
  }
}

/** And down, for a ceiling: rounding a budget *up* to the next power of two
 *  doubles the area it was supposed to cap, which put 84 MB in a 64 MB
 *  cache. */
export function levelUnder(width: number): number {
  const w = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, width));
  return Math.max(MIN_LEVEL, 2 ** Math.floor(Math.log2(w)));
}

/** How far a picture may be drawn from under its own size before the next
 *  level up is worth fetching. A panel 300 pixels wide reads the same from a
 *  256 texture and a 512 one, and the smaller costs a quarter of the memory
 *  and a quarter of the upload. */
const DETAIL_SLACK = 1.25;

/**
 * The level to fetch for a panel this wide on screen.
 *
 * Rounding up meant a panel one pixel over a power of two paid for four times
 * the texture it could show. Rounding down with slack puts a level between
 * five eighths and one and a quarter of the panel's own width, which a mip
 * chain resolves into softness rather than into aliasing, and costs a quarter
 * of the memory and a quarter of the upload in the case that used to round up.
 */
export function levelAt(width: number): number {
  return levelUnder(width * DETAIL_SLACK);
}

export class MediaTextures {
  private slots = new Map<string, Slot>();
  /** Sources at their own size, by path, least recently used first. */
  private sources = new Map<string, { tex: WebGLTexture; w: number; h: number; bytes: number }>();
  private sourceBytes = 0;
  private resampler: Resampling | null;
  private fadeMs: number;
  /** Largest side a source may be uploaded at here. */
  private maxSource: number;
  /** Level being decoded per path, so the same request is not queued twice. */
  private loading = new Map<string, number>();
  /** Asked for but not started, by path: the level wanted, how wide the panel
   *  is on screen, which is the order they are started in, and whether what is
   *  held is so far under the panel that waiting would show mush. */
  private queued = new Map<
    string,
    {
      level: number; width: number; urgent: boolean;
      exact: { w: number; h: number; sourceW: number } | null;
    }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStart = 0;
  /** Smoothed cost of a decode, which is what the spacing follows. Seeded at
   *  a WebKit-ish value so the first few starts are already paced. */
  private decodeEma = 40;
  /** When the camera last moved. Nothing is started while it is, because a
   *  decode that lands mid-pan is a stutter and its level is stale by the time
   *  it arrives. */
  private movedAt = 0;
  /** Set while an export waits on the pictures: then the pacing is in the way
   *  and everything outstanding should run as fast as it can. */
  private hurry = false;
  private inFlight = 0;
  private held = 0;
  private clock = 0;
  /** Pictures asked for this frame and last frame, which is what the budget
   *  is divided between. */
  private askedNow = 0;
  private askedBefore = 1;
  /** Paths that cannot be decoded, so a broken file is attempted once. */
  private failed = new Set<string>();
  /** What the decoding has cost since the source was opened. Not diagnostics
   *  for their own sake: the cost of a picture is the decode of its source,
   *  which is the same whatever level comes out of it, so "how many decodes"
   *  is the number any work on this has to move. */
  private decodes = 0;
  private fetched = 0;
  private decodeMs = 0;
  private fetchMs = 0;
  private uploadMs = 0;
  private worstUpload = 0;
  private worstDecode = 0;

  private gl: WebGL2RenderingContext;
  private fetchBytes: (path: string, level: number) => Promise<ArrayBuffer | null>;
  /** Called when a picture has arrived, so the frame loop draws again: it
   *  parks when nothing moves, and an image that loaded into a parked canvas
   *  would appear on the next pan. */
  private onLoaded: () => void;
  private budget: number;

  // Written out rather than declared as constructor parameters, because
  // parameter properties are not syntax Node can strip, and this module has
  // unit tests that import it directly: see mediatex.test.ts.
  constructor(
    gl: WebGL2RenderingContext,
    fetchBytes: (path: string, level: number) => Promise<ArrayBuffer | null>,
    onLoaded: () => void,
    budget = BUDGET_BYTES,
    resampler: Resampling | null = null,
    fadeMs = 180,
  ) {
    this.gl = gl;
    this.fetchBytes = fetchBytes;
    this.onLoaded = onLoaded;
    this.budget = budget;
    this.resampler = resampler;
    this.fadeMs = fadeMs;
    this.maxSource = Math.min(MAX_SOURCE, (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096);
  }

  /**
   * A new frame: the clock eviction order is measured in, the count the budget
   * is divided between, and whether the camera moved into it.
   *
   * `moving` is the gate on starting work. The renderer asks for every picture
   * on screen every frame, so a pan across a directory of renders would queue
   * the whole directory at one level and then at the next; waiting for the
   * camera to come to rest means a pan queues nothing it will not still want
   * when it stops.
   */
  tick(moving = false): void {
    this.clock++;
    this.askedBefore = Math.max(1, this.askedNow);
    this.askedNow = 0;
    this.spentThisFrame = 0;
    if (moving) this.movedAt = performance.now();
    // Fades that have run their course let go of what they were fading from.
    const now = clock.now();
    for (const slot of this.slots.values()) {
      if ((slot.prev || slot.fresh) && now - slot.since >= this.fadeMs) this.endFade(slot);
    }
    this.schedule();
  }

  /** Whether a picture is still fading from one texture to the next, so the
   *  frame loop keeps drawing until it is done. */
  fading(): boolean {
    for (const slot of this.slots.values()) if (slot.prev || slot.fresh) return true;
    return false;
  }

  /** How far the texture a picture is drawn with has faded in, 0 to 1. */
  mix(d: Drawable): number {
    const slot = d as Slot;
    if (!slot.prev && !slot.fresh) return 1;
    return Math.min(1, Math.max(0, (clock.now() - slot.since) / this.fadeMs));
  }

  private endFade(slot: Slot): void {
    slot.fresh = false;
    if (!slot.prev) return;
    this.gl.deleteTexture(slot.prev);
    this.held -= slot.prevBytes;
    slot.prev = null;
    slot.prevBytes = 0;
  }

  /**
   * The picture at exactly `pxW` by `pxH` screen pixels, to be drawn 1:1.
   *
   * For a camera at rest. A level is a power of two and gets scaled onto the
   * screen, which is soft at best and, through the browser's own resize,
   * grainy at worst; measured against a Lanczos reference, WebKit's came out
   * twice as far off as Chromium's. So once the view holds still every
   * picture on it is resampled to the pixels it actually covers, from its
   * source, by an area average on the GPU, and put on the pixel grid.
   *
   * Returns what is held meanwhile, and asks for the exact version when what
   * is held is not it. A picture smaller than its panel is drawn from its
   * source as it is: there is nothing sharper to make.
   */
  wantExact(path: string, pxW: number, pxH: number, sourceW = Infinity): Drawable | null {
    this.askedNow++;
    const w = Math.max(1, Math.round(pxW));
    const h = Math.max(1, Math.round(pxH));
    const slot = this.slots.get(path);
    if (slot) {
      slot.seen = this.clock;
      if (slot.exact && slot.w === w && slot.h === h) return slot;
      if (slot.native && slot.w <= w) return slot;
    }
    if (!this.resampler || w > this.maxSource || h > this.maxSource) {
      return this.want(path, pxW, pxW / pxH, sourceW);
    }
    if (this.failed.has(path)) return slot ?? null;
    // Already being made at this width: asking again would make it twice,
    // and fade in twice.
    if (this.loading.get(path) === w) return slot ?? null;
    const pending = this.queued.get(path);
    if (!(pending?.exact && pending.exact.w === w && pending.exact.h === h)) {
      this.queued.set(path, { level: w, width: pxW, urgent: !slot, exact: { w, h, sourceW } });
    }
    this.schedule();
    return slot ?? null;
  }

  /**
   * Largest level a single picture may take right now.
   *
   * The budget is shared between the pictures on screen: forty seven of them
   * in view at 2048 wide each is 425 MB, which the first version of this
   * happily held, because eviction cannot help when everything was asked for
   * in the same frame. So the cap comes down instead: forty seven visible is
   * 512 each, five visible is 2048, and the total stays where it was put.
   */
  private cap(aspect: number): number {
    const sharing = Math.max(this.askedBefore, this.askedNow, 1);
    const share = this.budget / sharing;
    // Four bytes a pixel and a third again for the mip chain, at this
    // picture's proportion: a level is a width, and a 2:1 render costs half
    // what a square one does at the same width. Assuming square overshot the
    // budget by seven percent on a project of wide plots.
    const a = Math.max(0.1, Math.min(10, aspect));
    return levelUnder(Math.sqrt((share * a) / 5.36));
  }

  /**
   * The picture for this path, at least `width` pixels across if we have it.
   *
   * Returns what is held, which may be a smaller level than asked for, and
   * starts a decode for the wanted level when it is missing. Returning the
   * smaller one meanwhile is what makes zooming in look like sharpening
   * rather than like loading.
   *
   * `aspect` is the picture's own width over height, used to turn the budget
   * share into a level rather than assuming the picture is square. `sourceW`
   * is how wide the file actually is, so a 48 pixel icon is never decoded to
   * 256 and held as eight times its own size; a document leaves it out,
   * because a page has no native resolution to be capped at.
   */
  want(path: string, width: number, aspect = 1, sourceW = Infinity): Drawable | null {
    this.askedNow++;
    const level = Math.min(levelAt(width), this.cap(aspect), Math.max(1, sourceW));
    const slot = this.slots.get(path);
    if (slot) {
      slot.seen = this.clock;
      // Decoding a picture back down is memory saved and a decode spent, so it
      // only happens under pressure. Held four times too large used to be
      // enough on its own, which meant zooming out of a directory re-read
      // every picture in it to hold less of something nobody was looking at.
      const tooLarge =
        this.held > this.budget * 0.8 && slot.w > level * 4 && slot.w > MIN_LEVEL;
      if (!tooLarge && (slot.w >= level || slot.w >= MAX_LEVEL)) return slot;
    }
    // Zooming from the overview into one picture asks for eight times the
    // level it is held at, and what is on screen until that arrives is a
    // thumbnail blown up. That case does not wait for the camera to be still;
    // a step or two of sharpening does.
    this.request(path, level, width, !slot || slot.w * 4 <= level);
    return slot ?? null;
  }

  /**
   * What is held for this path, without asking for anything more.
   *
   * For a panel too small to be worth a decode: once a picture has been
   * decoded it keeps being drawn at whatever level it has, because throwing it
   * away on a zoom out and fetching it again on the way back in is the loop
   * this cache exists to avoid.
   */
  have(path: string): Drawable | null {
    const slot = this.slots.get(path);
    if (!slot) return null;
    slot.seen = this.clock;
    return slot;
  }

  private request(path: string, level: number, width: number, urgent: boolean): void {
    if (this.failed.has(path)) return;
    if (this.loading.get(path) === level) return;
    this.queued.set(path, { level, width, urgent: urgent || level <= CHEAP_LEVEL, exact: null });
    this.schedule();
  }

  /**
   * How long to wait before the next start.
   *
   * Zero while this frame still has budget left: what a picture costs is
   * charged against `FRAME_BUDGET_MS`, and cheap ones therefore come in
   * several to a frame. Once the budget is spent the wait is the rest of the
   * frame, and for a picture that costs more than a whole frame on its own it
   * is what that one cost, capped.
   */
  private gap(): number {
    if (this.spentThisFrame < FRAME_BUDGET_MS) return 0;
    return Math.min(MAX_GAP_MS, Math.max(16, this.decodeEma));
  }

  /** Main-thread time charged to pictures in the current frame. */
  private spentThisFrame = 0;

  /**
   * Ask for the next start at the time it is due.
   *
   * On a timer rather than on the frame loop, because the frame loop parks
   * when the picture holds still, and a queue drained by frames would stop
   * with the canvas: the pictures that are left are exactly the ones nobody is
   * moving the camera for.
   */
  private schedule(): void {
    if (this.timer !== null) return;
    if (this.queued.size === 0 || this.inFlight >= MAX_IN_FLIGHT) return;
    const now = performance.now();
    const wait = this.hurry || this.anyCheap() ? 0 : this.anyUrgent() ? URGENT_QUIET_MS : QUIET_MS;
    const quiet = Math.max(0, this.movedAt + wait - now);
    const spaced = this.hurry ? 0 : Math.max(0, this.lastStart + this.gap() - now);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(quiet, spaced),
    );
  }

  /** Whether anything queued is a picture drawn from far too little. */
  private anyUrgent(): boolean {
    for (const q of this.queued.values()) if (q.urgent) return true;
    return false;
  }

  /** Whether anything queued is small enough not to be worth waiting over. */
  private anyCheap(): boolean {
    for (const q of this.queued.values()) if (q.level <= CHEAP_LEVEL) return true;
    return false;
  }

  private pump(): void {
    const now = performance.now();
    const wait = this.hurry || this.anyCheap() ? 0 : this.anyUrgent() ? URGENT_QUIET_MS : QUIET_MS;
    if (now - this.movedAt < wait || (!this.hurry && now - this.lastStart < this.gap())) {
      this.schedule();
      return;
    }
    while (this.inFlight < MAX_IN_FLIGHT && this.queued.size > 0) {
      // Widest panel on screen first: that is the picture a viewer is most
      // likely looking at, and the one whose placeholder is largest.
      let path = '';
      let best = -1;
      for (const [p, q] of this.queued) {
        // Urgent before wide: a panel showing a blown-up thumbnail is worse to
        // look at than a slightly soft one, whatever their sizes.
        const rank = q.width * (q.urgent ? 1e6 : 1);
        if (rank > best) {
          best = rank;
          path = p;
        }
      }
      const next = this.queued.get(path)!;
      this.queued.delete(path);
      this.loading.set(path, next.level);
      this.inFlight++;
      this.lastStart = performance.now();
      const job = next.exact
        ? this.decodeExact(path, next.exact.w, next.exact.h, next.exact.sourceW)
        : this.decode(path, next.level);
      void job.finally(() => {
        this.inFlight--;
        this.loading.delete(path);
        // Straight back into the pump rather than through a timer: a timer
        // per picture is a timer per picture, and nested `setTimeout(0)` is
        // clamped to about four milliseconds, which on a folder of a hundred
        // thumbnails was most of the time they took to appear.
        this.pump();
      });
      if (!this.hurry && this.spentThisFrame >= FRAME_BUDGET_MS) break;
    }
    this.schedule();
  }

  private async decode(path: string, level: number): Promise<void> {
    // With a resampler, a level is made the way the exact version is: from
    // the source, decoded once and kept, averaged down on the GPU. The
    // browser's resize is not used at all, since it is what made pictures
    // grainy in WebKit, and a picture that is asked for at a level and then
    // exactly decodes its source once instead of twice.
    if (this.resampler) return this.decodeExact(path, level, 0, Infinity, false);
    // The level goes along: an image is resized while it is decoded, but a
    // document has to be rasterised at a size, and only the source knows how.
    const started = performance.now();
    const bytes = await this.fetchBytes(path, level).catch(() => null);
    this.fetchMs += performance.now() - started;
    if (!bytes || bytes.byteLength === 0) {
      this.failed.add(path);
      return;
    }
    this.decodes++;
    this.fetched += bytes.byteLength;
    let bitmap: ImageBitmap;
    try {
      // Decoded straight to the level: a 3570 by 2369 render never exists as
      // 34 MB of pixels on the way to a 256 pixel panel.
      bitmap = await createImageBitmap(new Blob([bytes]), {
        resizeWidth: level,
        resizeQuality: 'high',
        // Premultiplied, and uploaded as premultiplied, so nothing is
        // converted on the way in; see the module comment. No colour space
        // conversion either, which the upload would otherwise undo again;
        // that pair is what made a 128 pixel thumbnail cost milliseconds
        // rather than the 0.09 the upload itself measures.
        premultiplyAlpha: 'premultiply',
        colorSpaceConversion: 'none',
      });
    } catch {
      this.failed.add(path);
      return;
    }
    const took = performance.now() - started;
    this.decodeMs += took;
    this.decodeEma = this.decodeEma * 0.7 + took * 0.3;
    this.worstDecode = Math.max(this.worstDecode, took);
    const up = performance.now();
    this.upload(path, bitmap);
    this.uploadMs += performance.now() - up;
    this.spentThisFrame += performance.now() - up;
    this.worstUpload = Math.max(this.worstUpload, performance.now() - up);
    bitmap.close();
    this.onLoaded();
  }

  private upload(path: string, bitmap: ImageBitmap): void {
    const { gl } = this;
    const old = this.slots.get(path);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Taken as it is: premultiplied and unconverted.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // Global state, and set back at once: WebGL2 refuses a 3D upload from an
    // array while it is on, which is how the overview textures stopped being
    // written the moment the first picture arrived.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // A mip chain, because a picture is drawn at every size between its panel
    // on screen and a thumbnail, and without it the overview zoom aliases into
    // noise. Box filtering is right here, unlike for code: what a photograph
    // or a plot reduces to is its average, and it is the *text* textures that
    // needed a saturation-weighted reduction of their own.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Kept from the level before when there was one: the answer is about the
    // picture, not about the size it was decoded to, and re-probing every
    // level would ask the same question again.
    this.install(path, tex, bitmap.width, bitmap.height, false, false,
      old ? old.translucent : translucent(bitmap));
  }

  /**
   * Put a new texture in a path's slot, fading from whatever was drawn.
   *
   * The old texture is kept until the fade is over. Swapping outright is the
   * pop: a blown-up thumbnail replaced by a sharp render in one frame.
   */
  private install(
    path: string, tex: WebGLTexture, w: number, h: number,
    exact: boolean, native: boolean, isTranslucent: boolean,
  ): void {
    const old = this.slots.get(path);
    // Four bytes a pixel, and a third again for the chain.
    const bytes = Math.round(w * h * 4 * 1.34);
    let prev: WebGLTexture | null = null;
    let prevBytes = 0;
    if (old) {
      // One fade at a time: a fade still running gives up what it was fading
      // from, and the new one starts from what was coming in.
      this.endFade(old);
      prev = old.tex;
      prevBytes = old.bytes;
      this.slots.delete(path);
    }
    this.slots.set(path, {
      tex, w, h, bytes, seen: this.clock, translucent: isTranslucent,
      exact, native, prev, prevBytes, since: clock.now(), fresh: !old,
    });
    this.held += bytes;
    this.trim();
  }

  /**
   * Make the exact version of a picture: its source at its own size, from the
   * cache or decoded, averaged down to `w` by `h` on the GPU.
   *
   * A source is fetched at the size the backend will give without work when
   * that is enough: a panel under a thumbnail's size is resampled from the
   * thumbnail, which spares a folder of screenshots at the overview zoom the
   * full decode of every one of them. A document is asked for at the width it
   * is wanted, since it is rasterised to order rather than stored.
   */
  private async decodeExact(
    path: string, w: number, h: number, sourceW: number, exact = true,
  ): Promise<void> {
    const vector = isVector(path);
    // Enough to resample from: as large as the target, or the picture's own
    // size when that is smaller. A drawing has no size of its own and is
    // drawn at the target. A level has no height of its own; it takes the
    // source's proportion.
    //
    // Two pixels short counts as enough: a page is rendered at the width it is
    // asked for and comes back at its own height, which rounds a pixel either
    // side of the rect's, and falling through to the largest size for that
    // rendered pages at 4096 pixels, 800 milliseconds each, for one pixel.
    const enough = (sw: number, sh: number) =>
      (sw >= w && sh >= h - ROUNDING_PX) || (!vector && sw >= sourceW - 1);
    let src = this.sources.get(path) ?? null;
    if (src && !enough(src.w, src.h)) src = null;
    if (!src) {
      let px = await this.fetchPixels(path, w, h, w);
      const toOrder = sourceW === Infinity && !vector;
      if (px && !enough(px.w, px.h)) {
        if (!toOrder) {
          // A thumbnail where the source was needed: ask for the source,
          // which is what anything past a thumbnail's size gets.
          px = await this.fetchPixels(path, w, h, Math.max(w, h, 4096));
        } else if (px.w >= w) {
          // A document, as wide as asked and not as tall: asked again at the
          // width that covers the height too, now its proportion is known.
          px = await this.fetchPixels(path, w, h, Math.ceil((h * px.w) / Math.max(1, px.h)));
        }
        // A document narrower than asked is as large as the renderer makes
        // one, and asking again gets the same answer: that asked every page
        // of a panel larger than 2048 pixels twice, for nothing.
      }
      if (!px) return;
      const up = performance.now();
      const tex = this.uploadSource(px);
      if (!this.slots.has(path)) this.probed.set(path, px.clear > TRANSLUCENT_SHARE);
      src = { tex, w: px.w, h: px.h, bytes: Math.round(px.w * px.h * 4 * 1.34) };
      this.keepSource(path, src);
      const took = performance.now() - up;
      this.uploadMs += took;
      this.spentThisFrame += took;
      this.worstUpload = Math.max(this.worstUpload, took);
    }
    const isTranslucent = this.slots.get(path)?.translucent ?? this.probed.get(path) ?? false;
    const t0 = performance.now();
    if (!exact) h = Math.max(1, Math.round((w * src.h) / src.w));
    if (src.w === w && src.h === h) {
      // Already the size asked for, which is what a drawing is.
      const tex = this.resampler!.resample(src.tex, src.w, src.h, w, h);
      this.install(path, tex, w, h, exact, false, isTranslucent);
    } else if (src.w <= w && src.h <= h) {
      // No larger than the panel: the source as it is, drawn magnified.
      // Copied, since the source cache may let go of the original.
      const tex = this.resampler!.resample(src.tex, src.w, src.h, src.w, src.h);
      this.install(path, tex, src.w, src.h, false, !vector, isTranslucent);
    } else {
      const tex = this.resampler!.resample(src.tex, src.w, src.h, w, h);
      this.install(path, tex, w, h, exact, false, isTranslucent);
    }
    this.spentThisFrame += performance.now() - t0;
    this.onLoaded();
  }

  /**
   * A picture's pixels: a raster picture decoded at its own size on a worker,
   * a drawing drawn at `w` by `h` here. Null, and marked failed, when it
   * cannot be read.
   */
  private async fetchPixels(path: string, w: number, h: number, level: number): Promise<Pixels | null> {
    const started = performance.now();
    const bytes = await this.fetchBytes(path, level).catch(() => null);
    this.fetchMs += performance.now() - started;
    if (!bytes || bytes.byteLength === 0) {
      this.failed.add(path);
      return null;
    }
    this.decodes++;
    this.fetched += bytes.byteLength;
    let px: Pixels | null;
    if (isVector(path)) {
      px = await rasteriseSvg(bytes, w, h);
    } else {
      const r = await this.decoder.decode(bytes, this.maxSource);
      px = r === 'unsupported' ? await decodeHere(bytes, this.maxSource) : r === 'failed' ? null : r;
    }
    const took = performance.now() - started;
    this.decodeMs += took;
    this.decodeEma = this.decodeEma * 0.7 + took * 0.3;
    this.worstDecode = Math.max(this.worstDecode, took);
    if (!px) this.failed.add(path);
    return px;
  }

  /** A source on the GPU at its own size, from premultiplied pixels, with a
   *  mip chain for the rare target sixteen times smaller than it. */
  private uploadSource(px: Pixels): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, px.w, px.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Decodes raster pictures off the main thread; see imagedecode.ts. */
  private decoder = new ImageDecoder();

  /** Translucency measured on a source before its path had a slot. */
  private probed = new Map<string, boolean>();

  /** Hold a source, dropping the least recently used past the budget. */
  private keepSource(path: string, src: { tex: WebGLTexture; w: number; h: number; bytes: number }): void {
    const old = this.sources.get(path);
    if (old) {
      this.gl.deleteTexture(old.tex);
      this.sourceBytes -= old.bytes;
      this.sources.delete(path);
    }
    this.sources.set(path, src);
    this.sourceBytes += src.bytes;
    for (const [p, s] of this.sources) {
      if (this.sourceBytes <= SOURCE_BUDGET_BYTES || p === path) break;
      this.gl.deleteTexture(s.tex);
      this.sourceBytes -= s.bytes;
      this.sources.delete(p);
    }
  }

  /** Throw out what has not been looked at until the budget holds. */
  private trim(): void {
    if (this.held <= this.budget) return;
    const order = [...this.slots.entries()].sort((a, b) => a[1].seen - b[1].seen);
    // First pass: everything not asked for this frame. Evicting what is on
    // screen right now would have it decoded again immediately, which is a
    // loop rather than an eviction.
    for (const [path, slot] of order) {
      if (this.held <= this.budget) break;
      if (slot.seen >= this.clock) continue;
      this.drop(path, slot);
    }
    // Second pass, oldest first, including what is on screen. Only past the
    // budget by half, so it is a floor under a pathological frame rather than
    // something the normal case ever reaches.
    if (this.held <= this.budget * 1.5) return;
    for (const [path, slot] of order) {
      if (this.held <= this.budget) break;
      if (!this.slots.has(path)) continue;
      this.drop(path, slot);
    }
  }

  private drop(path: string, slot: Slot): void {
    this.endFade(slot);
    this.gl.deleteTexture(slot.tex);
    this.slots.delete(path);
    this.held -= slot.bytes;
  }

  /** For the status bar and the checks. */
  stats(): {
    count: number;
    bytes: number;
    loading: number;
    decodes: number;
    fetched: number;
    decodeMs: number;
    fetchMs: number;
    uploadMs: number;
    worstUpload: number;
    worstDecode: number;
  } {
    return {
      count: this.slots.size,
      bytes: this.held,
      loading: this.inFlight + this.queued.size,
      decodes: this.decodes,
      fetched: this.fetched,
      decodeMs: this.decodeMs,
      fetchMs: this.fetchMs,
      uploadMs: this.uploadMs,
      worstUpload: this.worstUpload,
      worstDecode: this.worstDecode,
    };
  }

  /** Resolves when nothing is in flight, so an export waits for its pictures
   *  rather than writing the placeholders. */
  async settled(): Promise<void> {
    this.hurry = true;
    try {
      while (this.inFlight > 0 || this.queued.size > 0) {
        this.pump();
        await new Promise((r) => setTimeout(r, 16));
      }
    } finally {
      this.hurry = false;
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queued.clear();
    for (const slot of this.slots.values()) {
      this.endFade(slot);
      this.gl.deleteTexture(slot.tex);
    }
    this.slots.clear();
    for (const s of this.sources.values()) this.gl.deleteTexture(s.tex);
    this.sources.clear();
    this.sourceBytes = 0;
    this.held = 0;
  }
}
