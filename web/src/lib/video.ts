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
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  type StreamTargetChunk,
  type VideoCodec,
} from 'mediabunny';
import type { CanvasApp } from '$lib/canvas/app';
import { isWebKitGTK } from './platform.ts';

/** Frame sizes offered, 16:9. The project is fitted inside with the margin the
 *  fit always leaves, whatever its own shape. */
export const VIDEO_SIZES = {
  '1080p': [1920, 1080],
  '4K': [3840, 2160],
} as const satisfies Record<string, readonly [number, number]>;
export type VideoSize = keyof typeof VIDEO_SIZES;

export const VIDEO_FPS = 60;

/**
 * Codecs a video is written in, the first that works on this machine.
 *
 * H.264 first, since everything plays it. It is also the one that can be
 * missing: WebView2 on Windows encodes it only with the system's hardware
 * encoder, which some machines do not have, and the export failed there. VP9
 * and AV1 are encoded in software by every Chromium and go in the same MP4,
 * which browsers, VLC and the Windows player all open.
 */
export const VIDEO_CODECS = [
  { codec: 'avc', name: 'H.264' },
  { codec: 'vp9', name: 'VP9' },
  { codec: 'av1', name: 'AV1' },
] as const satisfies readonly { codec: VideoCodec; name: string }[];
export type VideoCodecChoice = (typeof VIDEO_CODECS)[number];

const found = new Map<string, Promise<VideoCodecChoice | null>>();

/**
 * The codec a video of this size can be written in here, or null.
 *
 * Found by encoding two frames, not by asking: an encoder can take a
 * configuration it then fails on at the first frame, which is what asking
 * alone cannot tell apart from one that works. Once per size.
 */
export function videoCodec(size: VideoSize): Promise<VideoCodecChoice | null> {
  let p = found.get(size);
  if (!p) {
    p = (async () => {
      const [w, h] = VIDEO_SIZES[size];
      for (const c of VIDEO_CODECS) {
        if (await encodes(c.codec, w, h)) return c;
      }
      return null;
    })();
    found.set(size, p);
  }
  return p;
}

async function encodes(codec: VideoCodec, width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) return false;
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH });
    output.addVideoTrack(source, { frameRate: VIDEO_FPS });
    await output.start();
    for (let i = 0; i < 2; i++) {
      g.fillStyle = i ? '#222' : '#ddd';
      g.fillRect(0, 0, width, height);
      await source.add(i / VIDEO_FPS, 1 / VIDEO_FPS);
    }
    await output.finalize();
    return (target.buffer?.byteLength ?? 0) > 0;
  } catch {
    return false;
  }
}

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
  // Down, so a video is never longer than was asked for: rounded to the
  // nearest, 239 steps of a ten minute video came out a second over.
  const stepFrames = Math.max(1, Math.floor(stepS * fps));
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
  /** What to encode with; see `videoCodec`. */
  codec?: VideoCodec;
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
  const frames = upright(canvas);
  let keep = false;
  let output: Output | null = null;
  try {
    output = new Output({
      // The header at the front, in room kept for it, so the file plays while
      // it downloads; the frame count it needs is known before the start.
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: new StreamTarget(sink.writable, { chunked: true, chunkSize: 4 << 20 }),
    });
    const video = new CanvasSource(frames.canvas, {
      codec: opts.codec ?? 'avc',
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
        frames.copy();
        await video.add(frame * dt, dt);
        frame++;
        opts.onProgress?.(frame, plan.frames);
      }
    };

    // The first commit, arrived at before the video starts: getting there
    // from the present is a jump across the whole range, not part of it.
    const band = captionHeight(height);
    await source.go(plan.start);
    app.setCaption(caption(source.caption(plan.start), width, height));
    app.captureFit(0, band);
    await app.captureSettle();
    await shoot(plan.introFrames);
    for (const target of plan.targets) {
      await source.go(target);
      app.setCaption(caption(source.caption(target), width, height));
      app.captureFit(CAMERA_S, band);
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

/**
 * The canvas the encoder reads, with the frame the right way up.
 *
 * WebKitGTK encodes a WebGL canvas upside down: the frame it takes from one
 * keeps GL's origin at the bottom, and the video came out mirrored top to
 * bottom. A 2D canvas it gets right, and drawing the WebGL one into it puts
 * the picture the right way up, so there each frame is copied across before
 * it is added. Everywhere else the canvas is read as it is.
 */
function upright(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; copy(): void } {
  const direct = { canvas, copy() {} };
  if (!isWebKitGTK()) return direct;
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const g = flat.getContext('2d');
  if (!g) return direct;
  return {
    canvas: flat,
    copy() {
      g.clearRect(0, 0, flat.width, flat.height);
      g.drawImage(canvas, 0, 0);
    },
  };
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

const captionFont = (height: number) => Math.round(height / 48);
const captionHeight = (height: number) => Math.round(captionFont(height) * 2.2);

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
  const px = captionFont(height);
  const band = captionHeight(height);
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
