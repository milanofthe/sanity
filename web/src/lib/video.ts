// The history replay, rendered to an MP4.
//
// Not a recording of the window. The canvas is taken over at the video's
// size and its clock is held (see canvas/clock.ts), so each frame is drawn at
// the moment it stands for and waits for whatever it shows to have arrived:
// the video is smooth however slow the machine is, and a frame never has a
// placeholder in it that the next one fills.
//
// Encoded in the webview with WebCodecs, H.264, which is the hardware encoder
// on macOS and Windows, and muxed by mediabunny. The file comes out in pieces
// as it is written (see `VideoSink`), so a minute of 4K never sits in memory.

import {
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';
import type { CanvasApp } from '$lib/canvas/app';

/** Frame sizes offered, 16:9. The project is fitted inside with the margin the
 *  fit always leaves, whatever its own shape. */
export const VIDEO_SIZES = {
  '1080p': [1920, 1080],
  '4K': [3840, 2160],
} as const satisfies Record<string, readonly [number, number]>;
export type VideoSize = keyof typeof VIDEO_SIZES;

export const VIDEO_FPS = 60;

/** The first commit, held before anything changes, and the last, held after,
 *  so a video neither starts nor ends in the middle of a movement. */
export const INTRO_S = 1;
export const OUTRO_S = 2;
/** Shortest step: a change's flash takes about half a second to read. */
export const MIN_STEP_S = 0.5;
/** Longest step: past this a step is a still, and the video only longer. */
export const MAX_STEP_S = 4;

export interface ReplayPlan {
  /** The commit shown first, as an index into the ticker's list, newest 0. */
  start: number;
  /** The commits stepped to, in order, the last one the newest of the range. */
  targets: number[];
  introFrames: number;
  stepFrames: number;
  outroFrames: number;
  frames: number;
  /** What `frames` comes to, which can be less than was asked for: a short
   *  history does not stretch to fill a long video. */
  seconds: number;
}

/**
 * The steps of a replay from commit `from` to commit `to`, oldest first, in
 * about `seconds`.
 *
 * With more commits than fit, each step takes several of them at once, the
 * way a held arrow key jumps, spread evenly over the range. With fewer, each
 * step is longer, up to `MAX_STEP_S`.
 */
export function planReplay(from: number, to: number, seconds: number, fps = VIDEO_FPS): ReplayPlan {
  const commits = Math.max(0, from - to);
  const body = Math.max(MIN_STEP_S, seconds - INTRO_S - OUTRO_S);
  const steps = Math.max(Math.min(commits, 1), Math.min(commits, Math.floor(body / MIN_STEP_S)));
  const stepS = steps > 0 ? Math.min(MAX_STEP_S, body / steps) : 0;
  const targets: number[] = [];
  for (let k = 1; k <= steps; k++) targets.push(from - Math.round((k * commits) / steps));
  const introFrames = Math.round(INTRO_S * fps);
  const stepFrames = Math.max(1, Math.round(stepS * fps));
  const outroFrames = Math.round(OUTRO_S * fps);
  const frames = introFrames + steps * stepFrames + outroFrames;
  return { start: from, targets, introFrames, stepFrames, outroFrames, frames, seconds: frames / fps };
}

/** What a replay plays. The history in the app; something made up in a check. */
export interface ReplaySource {
  /** Show commit `index`. Resolves once the canvas has been handed the step;
   *  its animation plays out in the frames drawn after. */
  go(index: number): Promise<void>;
  /** The line along the bottom of the frame while `index` is shown: what
   *  is set dim, the date and the id, and what is not, the subject. */
  caption(index: number): { meta: string; subject: string };
}

/** Where the MP4 goes, as the muxer writes it. */
export interface VideoSink {
  writable: WritableStream<StreamTargetChunk>;
  /** Finish, or throw away when `keep` is false; where it went, if kept. */
  close(keep: boolean): Promise<string | null>;
}

export interface ReplayOptions {
  size: VideoSize;
  fps?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Render `plan` from `source` into `sink`. Returns where it went, or null
 *  when it was cancelled. */
export async function renderReplay(
  app: CanvasApp,
  plan: ReplayPlan,
  source: ReplaySource,
  sink: VideoSink,
  opts: ReplayOptions,
): Promise<string | null> {
  const fps = opts.fps ?? VIDEO_FPS;
  const [width, height] = VIDEO_SIZES[opts.size];
  const dt = 1 / fps;
  const canvas = app.beginCapture(width, height);
  let keep = false;
  let output: Output | null = null;
  try {
    output = new Output({
      // The header at the front, in room kept for it, so the file plays while
      // it downloads; the frame count it needs is known before the start.
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: new StreamTarget(sink.writable, { chunked: true, chunkSize: 4 << 20 }),
    });
    const video = new CanvasSource(canvas, {
      codec: 'avc',
      quality: QUALITY_HIGH,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(video, { frameRate: fps, maximumPacketCount: plan.frames });
    await output.start();

    let frame = 0;
    const shoot = async (count: number) => {
      for (let i = 0; i < count; i++) {
        if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        await app.captureFrame(dt);
        await video.add(frame * dt, dt);
        frame++;
        opts.onProgress?.(frame, plan.frames);
      }
    };

    // The first commit, arrived at before the video starts: getting there
    // from the present is a jump across the whole range, not part of it.
    await source.go(plan.start);
    app.setCaption(caption(source.caption(plan.start), width, height));
    app.captureFit(0);
    await app.captureSettle();
    await shoot(plan.introFrames);
    for (const target of plan.targets) {
      await source.go(target);
      app.setCaption(caption(source.caption(target), width, height));
      app.captureFit(CAMERA_S);
      await shoot(plan.stepFrames);
    }
    await shoot(plan.outroFrames);

    await output.finalize();
    keep = true;
  } catch (e) {
    // The encoder stopped and nothing more written: half a video is not one.
    await output?.cancel().catch(() => {});
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      await sink.close(false);
      throw e;
    }
  } finally {
    app.endCapture();
  }
  return sink.close(keep);
}

/** How long the camera takes to fit a step's layout, in the video's time. */
const CAMERA_S = 0.45;

/** A sink that keeps the file in memory: the browser's, and the checks'. */
export function memorySink(): VideoSink & { bytes(): Uint8Array | null } {
  let buf = new Uint8Array(1 << 20);
  let size = 0;
  let done: Uint8Array | null = null;
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      const end = chunk.position + chunk.data.byteLength;
      if (end > buf.byteLength) {
        const grown = new Uint8Array(Math.max(end, buf.byteLength * 2));
        grown.set(buf.subarray(0, size));
        buf = grown;
      }
      buf.set(chunk.data, chunk.position);
      size = Math.max(size, end);
    },
  });
  return {
    writable,
    async close(keep) {
      done = keep ? buf.slice(0, size) : null;
      return keep ? 'memory' : null;
    },
    bytes: () => done,
  };
}

/**
 * The commit line: a band along the bottom of the frame in the theme's
 * colours and fonts, the date, the short id and the subject.
 *
 * Sized from the frame's height, so 4K is not 1080p with a caption a quarter
 * of the size.
 */
export function caption(
  line: { meta: string; subject: string },
  width: number,
  height: number,
): HTMLCanvasElement {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const px = Math.round(height / 48);
  const band = Math.round(px * 2.2);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = band;
  const g = c.getContext('2d')!;
  g.fillStyle = v('--bg') || '#1c2126';
  g.globalAlpha = 0.88;
  g.fillRect(0, 0, width, band);
  g.globalAlpha = 1;
  g.fillStyle = v('--border') || '#454f59';
  g.fillRect(0, 0, width, Math.max(1, Math.round(px / 16)));
  g.font = `${px}px ${v('--font-ui') || 'sans-serif'}`;
  g.textBaseline = 'middle';
  const pad = px;
  g.fillStyle = v('--text-dim') || '#9aa0a6';
  g.fillText(line.meta, pad, band / 2);
  const x = pad + g.measureText(line.meta).width + px;
  g.fillStyle = v('--text') || '#dfe3e6';
  let t = line.subject;
  // Cut to the frame rather than run off it.
  while (t.length > 4 && g.measureText(t).width > width - x - pad) t = `${t.slice(0, -4)}...`;
  g.fillText(t, x, band / 2);
  return c;
}
