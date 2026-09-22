// Overviews rasterised across the cores while a project opens.
//
// Rasterising a file's overview is arithmetic on its token spans, and at a
// hundred thousand files it was most of the time it took to open a project:
// 265 microseconds a file, on the main thread, between frames. Only the upload
// has to happen on the main thread. So the arithmetic goes to a few workers,
// each with scratch memory of its own, and what comes back is the mip levels
// ready to upload.
//
// Bounded, so a project of a hundred thousand files is not a hundred thousand
// copies of its token arrays waiting in a queue: `saturated` says when to stop
// handing files over for now.

import type { RasterInput } from './raster';

export interface RasterLevel {
  level: number;
  w: number;
  h: number;
  data: Uint8Array;
}

/**
 * Jobs handed over and not yet back, per worker, before the pool is full.
 *
 * A file's arrays are a few kilobytes, so this is a few megabytes in flight.
 * Eight was too few: the frame loop hands over files between frames, and at
 * eight each the workers sat idle for most of every frame waiting for the
 * next batch.
 */
const PER_WORKER = 128;

export class RasterPool {
  private workers: Worker[] = [];
  private next = 0;
  private nextId = 1;
  private waiting = new Map<number, (levels: RasterLevel[]) => void>();

  constructor() {
    // One core left for the main thread, which is uploading what they send.
    const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./raster.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; levels: RasterLevel[] }>) => {
        const done = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        done?.(e.data.levels);
      };
      this.workers.push(w);
    }
  }

  /** Whether workers can be used here at all. */
  static available(): boolean {
    return typeof Worker === 'function';
  }

  /** Rasterise one file; `done` is called on the main thread with its levels. */
  submit(input: RasterInput, done: (levels: RasterLevel[]) => void): void {
    const id = this.nextId++;
    this.waiting.set(id, done);
    const w = this.workers[this.next];
    this.next = (this.next + 1) % this.workers.length;
    w.postMessage({ id, input });
  }

  /** Enough in flight that handing over more would only queue it. */
  get saturated(): boolean {
    return this.waiting.size >= this.workers.length * PER_WORKER;
  }

  /** Jobs handed over and not yet back. */
  get busy(): number {
    return this.waiting.size;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.waiting.clear();
  }
}

let shared: RasterPool | null = null;

/** The one pool, made on first use and kept: a scene is replaced every time a
 *  project is opened, and workers made per scene were never let go. */
export function sharedPool(): RasterPool | null {
  if (!RasterPool.available()) return null;
  shared ??= new RasterPool();
  return shared;
}
