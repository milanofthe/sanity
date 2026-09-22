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

interface Slot {
  tex: WebGLTexture;
  /** Pixel size of what is held, which is the level, not the source. */
  w: number;
  h: number;
  bytes: number;
  /** Frame counter when this was last asked for, for eviction order. */
  seen: number;
}

/** What `want` hands back when a picture is ready to draw. */
export interface Drawable {
  tex: WebGLTexture;
  w: number;
  h: number;
}

/** Rounds a wanted width up to a level, inside the bounds: a picture should
 *  never be drawn from less than it needs. */
export function levelFor(width: number): number {
  const w = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, width));
  return Math.min(MAX_LEVEL, 2 ** Math.ceil(Math.log2(w)));
}

/** And down, for a ceiling: rounding a budget *up* to the next power of two
 *  doubles the area it was supposed to cap, which put 84 MB in a 64 MB
 *  cache. */
export function levelUnder(width: number): number {
  const w = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, width));
  return Math.max(MIN_LEVEL, 2 ** Math.floor(Math.log2(w)));
}

export class MediaTextures {
  private slots = new Map<string, Slot>();
  /** Level being decoded per path, so the same request is not queued twice. */
  private loading = new Map<string, number>();
  private queue: { path: string; level: number }[] = [];
  private inFlight = 0;
  private held = 0;
  private clock = 0;
  /** Pictures asked for this frame and last frame, which is what the budget
   *  is divided between. */
  private askedNow = 0;
  private askedBefore = 1;
  /** Paths that cannot be decoded, so a broken file is attempted once. */
  private failed = new Set<string>();

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

  /** A new frame: the clock eviction order is measured in, and the count the
   *  budget is divided between. */
  tick(): void {
    this.clock++;
    this.askedBefore = Math.max(1, this.askedNow);
    this.askedNow = 0;
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
   * share into a level rather than assuming the picture is square.
   */
  want(path: string, width: number, aspect = 1): Drawable | null {
    this.askedNow++;
    const level = Math.min(levelFor(width), this.cap(aspect));
    const slot = this.slots.get(path);
    if (slot) {
      slot.seen = this.clock;
      // Held larger than needed by more than two steps: decode it down. Zoom
      // out of a directory of renders and the levels they were loaded at are
      // sixteen times the pixels the panels now cover, which is memory held
      // for a picture nobody is looking at closely any more. Two steps of
      // slack, so a small pan does not re-decode anything.
      const tooLarge = slot.w > level * 4 && slot.w > MIN_LEVEL;
      if (!tooLarge && (slot.w >= level || slot.w >= MAX_LEVEL)) return slot;
    }
    this.request(path, level);
    return slot ?? null;
  }

  private request(path: string, level: number): void {
    if (this.failed.has(path)) return;
    const already = this.loading.get(path);
    if (already === level) return;
    this.loading.set(path, level);
    this.queue = this.queue.filter((q) => q.path !== path);
    this.queue.push({ path, level });
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      // Newest request first: it is the one the viewer is looking at, and a
      // queue drained in arrival order spends its time on panels that have
      // since been panned away from.
      const next = this.queue.pop()!;
      this.inFlight++;
      void this.decode(next.path, next.level).finally(() => {
        this.inFlight--;
        this.loading.delete(next.path);
        this.pump();
      });
    }
  }

  private async decode(path: string, level: number): Promise<void> {
    // The level goes along: an image is resized while it is decoded, but a
    // document has to be rasterised at a size, and only the source knows how.
    const bytes = await this.fetchBytes(path, level).catch(() => null);
    if (!bytes || bytes.byteLength === 0) {
      this.failed.add(path);
      return;
    }
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
    this.upload(path, bitmap);
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
  stats(): { count: number; bytes: number; loading: number } {
    return { count: this.slots.size, bytes: this.held, loading: this.inFlight + this.queue.length };
  }

  /** Resolves when nothing is in flight, so an export waits for its pictures
   *  rather than writing the placeholders. */
  async settled(): Promise<void> {
    while (this.inFlight > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 16));
    }
  }

  dispose(): void {
    for (const slot of this.slots.values()) this.gl.deleteTexture(slot.tex);
    this.slots.clear();
    this.held = 0;
  }
}
