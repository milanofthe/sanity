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
// Three things make that work:
//
//   levels      Target widths are powers of two, so zooming does not
//               re-decode continuously, and a level already held that is
//               large enough is used as it is.
//   a budget    One number for everything, least recently seen thrown out
//               first. Without it a pan across a directory of renders would
//               climb until the context is lost.
//   off thread  `createImageBitmap` decodes and resizes without the main
//               thread, and at most a couple run at once, so opening a
//               project full of images does not stall the first frames.
//   paced       and spaced out in time, largest on screen first, and not at
//               all while the camera is moving. Measured on a folder of 119
//               screenshots in the engine the desktop app ships (WKWebView,
//               not Chromium): decoding them costs 4.6 seconds, which as a
//               burst is the window not answering and spread out is pictures
//               arriving one after another.

/** Bytes held for image content, over all levels. 64 MB is about four full
 *  screen renders at 2048 wide, which is more than a canvas ever shows at
 *  once, and a fraction of what the code textures take. */
const BUDGET_BYTES = 64 * 1024 * 1024;

/** Narrowest and widest level. The floor is what an image is worth at the
 *  overview zoom; the ceiling is one step past a 4K export of a single
 *  panel. */
const MIN_LEVEL = 32;
const MAX_LEVEL = 2048;

/** Decodes in flight. Two, because a decode is off-thread but the upload that
 *  follows is not, and a burst of them shows up as dropped frames. */
const MAX_IN_FLIGHT = 2;

/** Bounds on the spacing between decode starts. The floor is a frame, so a
 *  handful of small pictures still arrive at once; the ceiling keeps a folder
 *  of very large ones from taking minutes to fill in. */
const MIN_GAP_MS = 16;
const MAX_GAP_MS = 200;

/** How long the camera has to be still before decoding resumes. A tenth of a
 *  second: long enough that a pan does not start work it will throw away,
 *  short enough that letting go of the trackpad feels immediate. */
const QUIET_MS = 100;

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
}

/** What `want` hands back when a picture is ready to draw. */
export interface Drawable {
  tex: WebGLTexture;
  w: number;
  h: number;
  translucent: boolean;
}

/** Above this share of transparent area a picture is treated as ink on a page
 *  rather than as a picture with a background of its own. A plot exported by
 *  matplotlib and a PDF page rendered by ImageIO are both near 1.0; a
 *  photograph or a screenshot is 0. */
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
  /** Level being decoded per path, so the same request is not queued twice. */
  private loading = new Map<string, number>();
  /** Asked for but not started, by path: the level wanted and how wide the
   *  panel is on screen, which is the order they are started in. */
  private queued = new Map<string, { level: number; width: number }>();
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
  ) {
    this.gl = gl;
    this.fetchBytes = fetchBytes;
    this.onLoaded = onLoaded;
    this.budget = budget;
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
    if (moving) this.movedAt = performance.now();
    this.schedule();
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
    this.request(path, level, width);
    return slot ?? null;
  }

  private request(path: string, level: number, width: number): void {
    if (this.failed.has(path)) return;
    if (this.loading.get(path) === level) return;
    this.queued.set(path, { level, width });
    this.schedule();
  }

  /** Milliseconds to leave between decode starts: half again what the last
   *  ones cost, so a folder of large screenshots paces itself wider than a
   *  folder of icons does, inside fixed bounds. */
  private gap(): number {
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, this.decodeEma * 1.5));
  }

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
    const quiet = this.hurry ? 0 : Math.max(0, this.movedAt + QUIET_MS - now);
    const spaced = this.hurry ? 0 : Math.max(0, this.lastStart + this.gap() - now);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(quiet, spaced),
    );
  }

  private pump(): void {
    const now = performance.now();
    if (!this.hurry && (now - this.movedAt < QUIET_MS || now - this.lastStart < this.gap())) {
      this.schedule();
      return;
    }
    while (this.inFlight < MAX_IN_FLIGHT && this.queued.size > 0) {
      // Widest panel on screen first: that is the picture a viewer is most
      // likely looking at, and the one whose placeholder is largest.
      let path = '';
      let best = -1;
      for (const [p, q] of this.queued) {
        if (q.width > best) {
          best = q.width;
          path = p;
        }
      }
      const next = this.queued.get(path)!;
      this.queued.delete(path);
      this.loading.set(path, next.level);
      this.inFlight++;
      this.lastStart = performance.now();
      void this.decode(path, next.level).finally(() => {
        this.inFlight--;
        this.loading.delete(path);
        this.schedule();
      });
      if (!this.hurry) break;
    }
    this.schedule();
  }

  private async decode(path: string, level: number): Promise<void> {
    // The level goes along: an image is resized while it is decoded, but a
    // document has to be rasterised at a size, and only the source knows how.
    const started = performance.now();
    const bytes = await this.fetchBytes(path, level).catch(() => null);
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
    this.worstUpload = Math.max(this.worstUpload, performance.now() - up);
    bitmap.close();
    this.onLoaded();
  }

  private upload(path: string, bitmap: ImageBitmap): void {
    const { gl } = this;
    const old = this.slots.get(path);
    if (old) {
      gl.deleteTexture(old.tex);
      this.held -= old.bytes;
      this.slots.delete(path);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
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

    // Four bytes a pixel, and a third again for the chain.
    const bytes = Math.round(bitmap.width * bitmap.height * 4 * 1.34);
    this.slots.set(path, {
      tex,
      w: bitmap.width,
      h: bitmap.height,
      bytes,
      seen: this.clock,
      // Kept from the level before when there was one: the answer is about the
      // picture, not about the size it was decoded to, and re-probing every
      // level would ask the same question again.
      translucent: old ? old.translucent : translucent(bitmap),
    });
    this.held += bytes;
    this.trim();
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
    for (const slot of this.slots.values()) this.gl.deleteTexture(slot.tex);
    this.slots.clear();
    this.held = 0;
  }
}
