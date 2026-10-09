import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ChromiumRuntime } from "./node/runtime";
import { extractFrameRgba, resolveFfmpegBinaries } from "./node/ffmpeg";
import type { Project } from "@reelterminal/core/types/project";

test("HEVC review uses original decoded pixels, accepts a real black frame, and rejects corrupt media", async () => {
  const dir = await mkdtemp(path.join(process.env.REELTERMINAL_TEST_WORK_ROOT ?? tmpdir(), "hevc-review-"));
  const runtime = new ChromiumRuntime();
  try {
    const binaries = await resolveFfmpegBinaries();
    if (!binaries) throw new Error("This regression requires FFmpeg");
    const source = process.env.REELTERMINAL_TEST_HEVC_SOURCE ?? path.join(dir, "red-hevc.mp4");
    if (!process.env.REELTERMINAL_TEST_HEVC_SOURCE) execFileSync(binaries.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1", "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", source], { windowsHide: true });
    const project = {
      id: "hevc-review", name: "HEVC", createdAt: 0, modifiedAt: 0,
      settings: { width: 160, height: 90, frameRate: 10, sampleRate: 48000, channels: 2 },
      mediaLibrary: { items: [{ id: "hevc", type: "video", name: "HEVC", metadata: { duration: 1, width: 160, height: 90 }, blob: null }] },
      timeline: { duration: 1, subtitles: [], tracks: [{ id: "video", type: "video", hidden: false, clips: [{ id: "clip", mediaId: "hevc", startTime: 0, duration: 1, inPoint: 0, outPoint: 1, transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1 }, effects: [] }], transitions: [] }] },
    } as unknown as Project;
    const png = await runtime.renderPng(project, { hevc: source }, 0, 160, 90);
    const frame = path.join(dir, "review.png");
    await writeFile(frame, png);
    const rgba = await extractFrameRgba(binaries.ffmpeg, frame, 0, 160, 90);
    const sourceRgba = await extractFrameRgba(binaries.ffmpeg, source, 0, 160, 90, { scale: { width: 160, height: 90 } });
    const meanRgb = (data: Buffer) => data.reduce((sum, byte, index) => sum + (index % 4 === 3 ? 0 : byte), 0) / (160 * 90 * 3);
    expect(meanRgb(sourceRgba)).toBeGreaterThan(5);
    expect(meanRgb(rgba)).toBeGreaterThan(5);
    const black = path.join(dir, "black.mp4");
    execFileSync(binaries.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", black], { windowsHide: true });
    await writeFile(frame, await runtime.renderPng(project, { hevc: black }, 0, 160, 90));
    expect(meanRgb(await extractFrameRgba(binaries.ffmpeg, frame, 0, 160, 90))).toBeLessThan(1);
    const corrupt = path.join(dir, "corrupt.mp4");
    await writeFile(corrupt, "not video bytes");
    await expect(runtime.renderPng(project, { hevc: corrupt }, 0, 160, 90)).rejects.toThrow();
    if (process.env.REELTERMINAL_TEST_EVIDENCE) await writeFile(process.env.REELTERMINAL_TEST_EVIDENCE, JSON.stringify({ source, outcome: "decoded-pixels", meanRgb: meanRgb(rgba), sourceMeanRgb: meanRgb(sourceRgba), realBlackAccepted: true, corruptSourceRejected: true }, null, 2));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
