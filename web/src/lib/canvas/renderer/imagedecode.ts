// Pictures as raw premultiplied pixels, ready to upload.
//
// Decoded in a worker, which also draws the picture into a canvas and reads
// the pixels back. That is more work than handing the decoded bitmap to WebGL
// directly, and it is done on purpose: in WebKit, which the desktop app draws
// with, uploading an ImageBitmap cost 31 to 33 milliseconds whatever its size,
// on the main thread, where raw pixels of the same picture took 5 for a 4122
// by 2111 render and under one for 1024 by 525. Measured over a stop-and-go
// zoom through a folder of 47 pictures, that was 47 frames over 25 ms.
//
// An SVG is drawn instead, at exactly the size asked for, on the main thread
// since a worker cannot draw one. It has no resolution of its own to be
// scaled from, so it is crisp at any size.

export interface Pixels {
  w: number;
  h: number;
  /** Premultiplied RGBA. */
  data: Uint8Array;
  /** Share of the picture that is mostly transparent. */
  clear: number;
}

/** Whether a path is a picture drawn from a description rather than pixels. */
export function isVector(path: string): boolean {
  return path.toLowerCase().endsWith('.svg');
}

/** Two at once: a decode is a few tens of milliseconds, and the frame loop
 *  only uploads a few pictures a frame anyway. */
const WORKERS = 2;

export class ImageDecoder {
  private workers: Worker[] = [];
  private next = 0;
  private nextId = 1;
  private waiting = new Map<number, (r: Pixels | 'failed' | 'unsupported') => void>();
  /** Set once a worker has said it cannot draw, so the rest go the old way. */
  unsupported = false;

  constructor() {
    if (typeof Worker !== 'function') {
      this.unsupported = true;
      return;
    }
    for (let i = 0; i < WORKERS; i++) {
      const w = new Worker(new URL('./imagedecode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{
        id: number; w?: number; h?: number; data?: Uint8Array; clear?: number;
        failed?: boolean; unsupported?: boolean;
      }>) => {
        const m = e.data;
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (!done) return;
        if (m.unsupported) {
          this.unsupported = true;
          done('unsupported');
        } else if (m.failed || !m.data) {
          done('failed');
        } else {
          done({ w: m.w!, h: m.h!, data: m.data, clear: m.clear ?? 0 });
        }
      };
      this.workers.push(w);
    }
  }

  /** A raster picture's pixels at its own size, or at most `maxSide`. */
  decode(bytes: ArrayBuffer, maxSide: number): Promise<Pixels | 'failed' | 'unsupported'> {
    if (this.unsupported) return Promise.resolve('unsupported');
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.waiting.set(id, resolve);
      const w = this.workers[this.next];
      this.next = (this.next + 1) % this.workers.length;
      // Copied rather than handed over: a source may hand out the same buffer
      // every time, a thumbnail it holds, and a transfer would empty it.
      w.postMessage({ id, bytes, maxSide });
    });
  }
}

/**
 * An SVG drawn at exactly `w` by `h`, or null when it cannot be read. A
 * height of zero takes the drawing's own proportion.
 */
export async function rasteriseSvg(bytes: ArrayBuffer, w: number, h: number): Promise<Pixels | null> {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (h <= 0) {
      const nw = img.naturalWidth || 1;
      const nh = img.naturalHeight || nw;
      h = Math.max(1, Math.round((w * nh) / nw));
    }
    return drawn(img, w, h);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A raster picture's pixels on the main thread, for an engine whose workers
 * cannot draw. Slower where the worker is not, which is the point of it.
 */
export async function decodeHere(bytes: ArrayBuffer, maxSide: number): Promise<Pixels | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const px = drawn(bmp, Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    bmp.close();
    return px;
  } catch {
    return null;
  }
}

/** Draw into a canvas of `w` by `h` and read it back premultiplied. */
function drawn(img: CanvasImageSource, w: number, h: number): Pixels | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let clear = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) clear++;
    if (a === 255) continue;
    const f = a / 255;
    data[i] = data[i] * f + 0.5;
    data[i + 1] = data[i + 1] * f + 0.5;
    data[i + 2] = data[i + 2] * f + 0.5;
  }
  return { w, h, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), clear: clear / (w * h) };
}
