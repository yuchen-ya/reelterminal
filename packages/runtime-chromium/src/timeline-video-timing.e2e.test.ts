import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip, Transition } from "@reelterminal/core/types/timeline";
import { ChromiumRuntime, PartFileWriter } from "./node/runtime";
import { extractFrameRgba, resolveFfmpegBinaries, runProcess } from "./node/ffmpeg";

const width = 320;
const height = 180;
const fps = 10;
const bitPoints = Array.from({ length: 6 }, (_, bit) => [20 + bit * 48, 20]);
const points = [[160, 120], ...bitPoints];
const runtime = new ChromiumRuntime();
let directory: string;
let source: string;

function clip(id: string, updates: Partial<Clip> = {}): Clip {
  return {
    id, mediaId: "numbered", trackId: "video", startTime: 0, duration: 2,
    inPoint: 0, outPoint: 2, speed: 1, volume: 0, effects: [], audioEffects: [], keyframes: [],
    transform: {
      position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1,
    },
    ...updates,
  };
}

function project(clips: Clip[], duration: number, transitions: Transition[] = []): Project {
  return {
    id: "numbered-timeline", name: "Numbered source timing", createdAt: 1, modifiedAt: 1,
    settings: { width, height, frameRate: fps, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [{
      id: "numbered", name: "numbered.webm", type: "video", blob: null, fileHandle: null,
      thumbnailUrl: null, waveformData: null,
      metadata: {
        duration: 4, width, height, frameRate: fps, codec: "vp9",
        sampleRate: 0, channels: 0, fileSize: 0,
      },
    }] },
    timeline: {
      duration, subtitles: [], markers: [], tracks: [{
        id: "video", type: "video", name: "Numbered video", clips, transitions,
        hidden: false, locked: false, muted: false, solo: false,
      }],
    },
  };
}

async function samples(pngs: Buffer[]): Promise<number[][][]> {
  return runtime.withIsolatedContext({ javaScriptEnabled: true }, async (context) => {
    const page = await context.newPage();
    return page.evaluate(async ({ images, coordinates }) => {
      const result: number[][][] = [];
      for (const base64 of images) {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        result.push(coordinates.map(([x, y]) =>
          Array.from(ctx.getImageData(x!, y!, 1, 1).data.slice(0, 3)),
        ));
      }
      return result;
    }, { images: pngs.map((png) => png.toString("base64")), coordinates: points });
  });
}

function frameNumber(frame: number[][]): number {
  return frame.slice(1).reduce((number, [red], bit) => number + (red! > 128 ? 2 ** bit : 0), 0);
}

function expectColor(actual: number[], expected: number[], label: string): void {
  expected.forEach((value, channel) => {
    expect(Math.abs(actual[channel]! - value), `${label}, RGB channel ${channel}: ${actual}`).toBeLessThanOrEqual(18);
  });
}

async function renderedSamples(fixture: Project, times: number[]): Promise<number[][][]> {
  const pngs = await runtime.withHydratedSession(fixture, { numbered: source }, async (session) => {
    const images: Buffer[] = [];
    for (const time of times) images.push(await session.renderPng(time, width, height));
    return images;
  });
  return samples(pngs);
}

describe("real numbered video timeline timing", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "timeline-video-timing-"));
    source = path.join(directory, "numbered.webm");
    const binaries = await resolveFfmpegBinaries();
    if (!binaries) throw new Error("ffmpeg is required for the numbered video fixture");
    // Red frames 0..19, blue frames 20..39; six binary cells encode the exact
    // source frame number. The test expectations never read another render as an oracle.
    const filters = [
      "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(n,20)'",
      "drawbox=x=0:y=0:w=iw:h=40:color=black:t=fill",
      ...bitPoints.map(([x, y], bit) =>
        `drawbox=x=${x! - 7}:y=${y! - 7}:w=14:h=14:color=white:t=fill:enable='bitand(n,${2 ** bit})'`,
      ),
    ];
    await runProcess(binaries.ffmpeg, [
      "-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=10:d=4",
      "-vf", [...filters, "scale=out_color_matrix=bt709:out_range=tv"].join(","),
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-an", "-c:v", "libvpx-vp9", "-lossless", "1",
      "-g", "10", "-pix_fmt", "yuv420p", source,
    ]);
  });

  afterAll(async () => {
    await runtime.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("chooses exact cut frames and the last timeline frame during out-of-order seeks", async () => {
    const fixture = project([
      clip("before-cut", { duration: 1, outPoint: 1 }),
      clip("after-cut", { startTime: 1, duration: 1, inPoint: 3, outPoint: 4 }),
    ], 2);
    const cases = [
      { time: 1.9, frame: 39 }, { time: 1, frame: 30 }, { time: 0.999, frame: 9 },
      { time: 0, frame: 0 }, { time: 1.5, frame: 35 },
      { time: 1, frame: 30 },
    ];
    const frames = await renderedSamples(fixture, cases.map(({ time }) => time));
    expect(frames.map(frameNumber), JSON.stringify(cases)).toEqual(cases.map(({ frame }) => frame));
    cases.forEach(({ time, frame }, index) => {
      expectColor(frames[index]![0]!, frame < 20 ? [255, 0, 0] : [0, 0, 255], `cut seek ${time}s`);
    });
  });

  it.each([
    {
      name: "2x forward", speed: 2, reversed: false, start: 0.4, duration: 1,
      cases: [[1.3, 28], [0.9, 20], [0.4, 10], [0.675, 15]],
    },
    {
      name: "2x reverse", speed: 2, reversed: true, start: 0.4, duration: 1,
      cases: [[1.3, 12], [0.925, 19], [0.4, 29], [0.675, 24]],
    },
    {
      name: "half-speed forward", speed: 0.5, reversed: false, start: 0, duration: 4,
      cases: [[3.9, 29], [2, 20], [0, 10], [0.1, 10], [0.2, 11]],
    },
  ])("maps $name timeline time to the intended trimmed source frame", async ({ speed, reversed, start, duration, cases }) => {
    const fixture = project([clip("speed-clip", {
      startTime: start, duration, inPoint: 1, outPoint: 3, speed, reversed,
    })], start + duration);
    const frames = await renderedSamples(fixture, cases.map(([time]) => time!));
    expect(frames.map(frameNumber), JSON.stringify(cases)).toEqual(cases.map(([, frame]) => frame));
  });

  it("crossfades two trimmed clips from the same moving source at the correct midpoint", async () => {
    const fixture = project([
      clip("outgoing"),
      clip("incoming", { startTime: 2, inPoint: 2, outPoint: 4 }),
    ], 4, [{
      id: "same-source-fade", clipAId: "outgoing", clipBId: "incoming",
      type: "crossfade", duration: 1, params: { easing: "linear" },
    }]);
    const times = [2, 1.5, 2.5, 1.75, 2.25, 2];
    const frames = await renderedSamples(fixture, times);
    const expected = [[128, 0, 128], [255, 0, 0], [0, 0, 255], [191, 0, 64], [64, 0, 191], [128, 0, 128]];
    frames.forEach((frame, index) => expectColor(frame[0]!, expected[index]!, `transition at ${times[index]}s`));
    // At the midpoint, clip A holds its last pre-cut frame (19), while clip B
    // starts at frame 20. Check each source's binary cells through the blend.
    frames[0]!.slice(1).forEach((rgb, bit) => {
      const expectedValue = (((19 >> bit) & 1) + ((20 >> bit) & 1)) * 127.5;
      expectColor(rgb, [expectedValue, expectedValue, expectedValue], `midpoint source bit ${bit}`);
    });
  });

  it("encodes the first, midpoint and final 2x reverse frames rather than an untrimmed source", async () => {
    const fixture = project([clip("reverse-export", {
      duration: 1, inPoint: 1, outPoint: 3, speed: 2, reversed: true,
    })], 1);
    const output = path.join(directory, "reverse.mp4");
    const writer = await PartFileWriter.open(output);
    try {
      const result = await runtime.exportWebcodecsStreaming(fixture, { numbered: source }, {
        width, height, frameRate: fps, videoBitrateKbps: 1000,
      }, writer, () => {});
      expect(result.success, result.errorMessage).toBe(true);
      expect(result.framesRendered).toBe(10);
      const binaries = await resolveFfmpegBinaries();
      if (!binaries) throw new Error("ffmpeg is required to inspect the encoded frame numbers");
      const probe = await runProcess(binaries.ffprobe, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames",
        "-of", "csv=p=0", output,
      ]);
      expect(Number(probe.stdout.toString().trim())).toBe(10);
      for (const [time, expected] of [[0, 29], [0.5, 20], [0.9, 12]]) {
        const rgba = await extractFrameRgba(binaries.ffmpeg, output, time!, width, height);
        const frame = points.map(([x, y]) => {
          const offset = (y! * width + x!) * 4;
          return [...rgba.subarray(offset, offset + 3)];
        });
        expect(frameNumber(frame), `exported source frame at ${time}s`).toBe(expected);
      }
    } finally {
      await writer.discard();
    }
  });

});
