import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade } from "@reelterminal/agent-facade";

import { ChromiumRuntime } from "./runtime";
import { createChromiumProviders, type ChromiumProviders } from "./providers";
import { renderHtmlAnimation, HtmlRenderError } from "./html-render";
import { ffprobeJson, resolveFfmpegBinaries, runProcess } from "./ffmpeg";

function meanAbsDiff(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  expect(a.length).toBeGreaterThan(0);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += Math.abs(a[i]! - b[i]!);
  }
  return total / a.length;
}

function rowSpan(rgba: Buffer, width: number, y: number, matches: (r: number, g: number, b: number) => boolean) {
  const xs = [];
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (matches(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!)) xs.push(x);
  }
  return xs.length ? [xs[0]!, xs.at(-1)!] : [];
}

async function decodeFrames(ffmpeg: string, videoPath: string, width: number, height: number) {
  const { stdout } = await runProcess(ffmpeg, [
    "-v", "error", "-i", videoPath, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const frameBytes = width * height * 4;
  expect(stdout.length % frameBytes).toBe(0);
  return Array.from({ length: stdout.length / frameBytes }, (_, i) => stdout.subarray(i * frameBytes, (i + 1) * frameBytes));
}

describe("media.render_html animated rendering (real Chromium + ffmpeg)", () => {
  let runtime: ChromiumRuntime;
  let providers: ChromiumProviders;
  let tempDir: string;

  beforeAll(async () => {
    const binaries = await resolveFfmpegBinaries({});
    if (!binaries) {
      throw new Error("ffmpeg/ffprobe must be installed in PATH for html animation tests");
    }
  });

  beforeEach(async () => {
    runtime = new ChromiumRuntime({ headless: true });
    providers = createChromiumProviders({ headless: true });
    tempDir = await mkdtemp(path.join(tmpdir(), "html-anim-e2e-"));
  });

  afterEach(async () => {
    await runtime.close().catch(() => undefined);
    await providers.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renders CSS @keyframes + --reel-progress + SVG SMIL deterministically to MP4 and frames strictly differ", async () => {
    const html = `<!doctype html><html><head><style>
      html, body { margin: 0; width: 100%; height: 100%; background: #101820; overflow: hidden; }
      #bar {
        position: absolute; left: 0; top: 20px; height: 40px;
        width: calc(var(--reel-progress, 0) * 100%);
        background: #ff4422;
      }
      @keyframes slideBox {
        from { transform: translateX(0px); background: #22cc44; }
        to { transform: translateX(200px); background: #3366ff; }
      }
      #box {
        position: absolute; left: 10px; top: 80px; width: 40px; height: 40px;
        animation: slideBox 1s linear forwards;
      }
    </style></head><body>
      <div id="bar"></div>
      <div id="box"></div>
      <svg width="320" height="60" style="position:absolute;left:0;top:120px;">
        <rect x="0" y="10" width="40" height="40" fill="#ffff00">
          <animate attributeName="x" from="0" to="240" dur="1s" fill="freeze" />
        </rect>
      </svg>
    </body></html>`;

    const destPath = path.join(tempDir, "out.mp4");
    const info = await renderHtmlAnimation(runtime, {
      source: { kind: "inline", html },
      width: 320,
      height: 180,
      transparent: false,
      durationSec: 1.0,
      fps: 12,
      format: "mp4",
      destPath,
    });

    expect(info.format).toBe("mp4");
    expect(info.frameCount).toBe(12);
    expect(info.fps).toBe(12);
    expect(info.durationSec).toBeCloseTo(1.0, 4);
    expect(info.bytesWritten).toBeGreaterThan(0);

    const binaries = (await resolveFfmpegBinaries({}))!;
    const probe = await ffprobeJson(binaries.ffprobe, destPath, { countFrames: true });
    const video = probe.streams?.find((s) => s.codec_type === "video")!;
    expect(video.codec_name).toBe("h264");
    expect(video.pix_fmt).toBe("yuv420p");
    expect(video.width).toBe(320);
    expect(video.height).toBe(180);
    expect(Number(video.nb_read_frames ?? video.nb_frames)).toBe(12);

    const frames = await decodeFrames(binaries.ffmpeg, destPath, 320, 180);
    expect(frames).toHaveLength(12);
    for (const [k, frame] of frames.entries()) {
      // Each animation mechanism has its own row: one moving region cannot
      // conceal a frozen CSS timeline, SMIL timeline, or progress variable.
      const bar = rowSpan(frame, 320, 40, (r, g, b) => r > 180 && g < 130 && b < 110);
      if (k === 0) expect(bar).toEqual([]);
      else {
        expect(bar[0]).toBeLessThanOrEqual(2);
        expect(Math.abs(bar[1]! + 1 - 320 * k / 11)).toBeLessThanOrEqual(2);
      }
      const box = rowSpan(frame, 320, 100, (r, g, b) => r < 110 && Math.max(g, b) > 130);
      const smil = rowSpan(frame, 320, 150, (r, g, b) => r > 180 && g > 180 && b < 100);
      for (const [span, left] of [[box, 10 + 200 * k / 12], [smil, 240 * k / 12]] as const) {
        expect(span).toHaveLength(2);
        expect(Math.abs(span[0]! - left)).toBeLessThanOrEqual(2);
        expect(Math.abs(span[1]! - (left + 39))).toBeLessThanOrEqual(2);
      }
    }
    const repeatedPath = path.join(tempDir, "repeated.mp4");
    await renderHtmlAnimation(runtime, {
      source: { kind: "inline", html }, width: 320, height: 180,
      transparent: false, durationSec: 1, fps: 12, format: "mp4", destPath: repeatedPath,
    });
    const repeated = await decodeFrames(binaries.ffmpeg, repeatedPath, 320, 180);
    expect(repeated).toHaveLength(frames.length);
    for (const [k, frame] of frames.entries()) expect(repeated[k]!.equals(frame), `decoded frame ${k}`).toBe(true);
  }, 60_000);

  it("renders transparent animated HTML to VP9 yuva420p WebM via facade and imports into project media library", async () => {
    const html = `<!doctype html><html><head><style>
      html, body { margin: 0; width: 100%; height: 100%; background: transparent; }
      #mover {
        position: absolute;
        left: calc(var(--reel-progress, 0) * 100px);
        top: 40px;
        width: 40px;
        height: 40px;
        background: #00ffcc;
      }
    </style></head><body><div id="mover"></div></body></html>`;

    const facade = createAgentFacade({
      mediaRoots: [tempDir],
      renderProvider: providers.renderProvider,
    });
    await facade["project.create"]({ name: "html-anim" });

    const rendered = await facade["media.render_html"]({
      source: { kind: "inline", html },
      width: 160,
      height: 120,
      transparent: true,
      animation: { durationSec: 0.5, fps: 10 },
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.format).toBe("webm");
    expect(rendered.value.frameCount).toBe(5);
    expect(rendered.value.fps).toBe(10);
    expect(rendered.value.path.endsWith(".webm")).toBe(true);
    expect((await stat(rendered.value.path)).size).toBe(rendered.value.bytes);

    const binaries = (await resolveFfmpegBinaries({}))!;
    const probe = await ffprobeJson(binaries.ffprobe, rendered.value.path, {
      countFrames: true,
    });
    const video = probe.streams?.find((s) => s.codec_type === "video") as
      | (typeof probe.streams extends (infer T)[] | undefined ? T & { tags?: Record<string, string> } : never)
      | undefined;
    expect(video?.codec_name).toBe("vp9");
    expect(video?.tags?.alpha_mode).toBe("1");
    expect(Number(video?.nb_read_frames ?? video?.nb_frames)).toBe(5);

    // ffprobe 6.1 cannot select a decoder. Inspect the actual libvpx-decoded
    // frame format with ffmpeg, without forcing an output pixel format; the
    // default native VP9 probe can report yuv420p even when alpha is present.
    const { stderr: decodedInfo } = await runProcess(binaries.ffmpeg, [
      "-hide_banner", "-v", "info", "-c:v", "libvpx-vp9", "-i", rendered.value.path,
      "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-",
    ]);
    expect(decodedInfo).toMatch(/\bfmt:yuva420p\b/);

    const { stdout: earlyRgba } = await runProcess(binaries.ffmpeg, [
      "-v", "error", "-c:v", "libvpx-vp9", "-i", rendered.value.path,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ]);
    const { stdout: lateRgba } = await runProcess(binaries.ffmpeg, [
      "-v", "error", "-c:v", "libvpx-vp9", "-ss", "0.4", "-i", rendered.value.path,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ]);
    expect(earlyRgba.length).toBe(160 * 120 * 4);
    expect(lateRgba.length).toBe(160 * 120 * 4);
    expect(meanAbsDiff(earlyRgba, lateRgba)).toBeGreaterThan(5);
    // Top-left corner (0,0) stays transparent while #mover at (10, 60) is opaque
    expect(earlyRgba[3]).toBeLessThan(10);
    expect(earlyRgba[(60 * 160 + 10) * 4 + 3]).toBeGreaterThan(200);
    expect(lateRgba[(60 * 160 + 10) * 4 + 3]).toBeLessThan(10);
    expect(lateRgba[(60 * 160 + 110) * 4 + 3]).toBeGreaterThan(200);

    // Proves media.import accepts the rendered .webm cleanly
    const imported = await facade["media.import"]({ path: rendered.value.path });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.type).toBe("video");
    expect(imported.value.metadata.width).toBe(160);
    expect(imported.value.metadata.height).toBe(120);
  }, 60_000);

  it("rejects transparent: true + format: mp4 and preserves html-policy script blocking", async () => {
    await expect(
      renderHtmlAnimation(runtime, {
        source: { kind: "inline", html: "<p>hello</p>" },
        width: 64,
        height: 64,
        transparent: true,
        durationSec: 1,
        fps: 10,
        format: "mp4",
        destPath: path.join(tempDir, "bad.mp4"),
      }),
    ).rejects.toThrow(HtmlRenderError);

    await expect(
      renderHtmlAnimation(runtime, {
        source: { kind: "inline", html: "<script>alert(1)</script><p>x</p>" },
        width: 64,
        height: 64,
        transparent: false,
        durationSec: 0.5,
        fps: 10,
        format: "mp4",
        destPath: path.join(tempDir, "xss.mp4"),
      }),
    ).rejects.toThrow(HtmlRenderError);
  });

  it.each([{ durationSec: 0.25, frameCount: 3 }, { durationSec: 0.01, frameCount: 1 }])(
    "encodes $frameCount frames for duration $durationSec with final progress equal to one",
    async ({ durationSec, frameCount }) => {
      const destPath = path.join(tempDir, "rounded.mp4");
      const info = await renderHtmlAnimation(runtime, {
        source: { kind: "inline", html: '<style>body{margin:0;background:black}div{height:32px;width:calc(var(--reel-progress)*64px);background:white}</style><div></div>' },
        width: 64, height: 32, durationSec, fps: 10, transparent: false, format: "mp4", destPath,
      });
      expect(info.frameCount).toBe(frameCount);
      const binaries = (await resolveFfmpegBinaries({}))!;
      const frames = await decodeFrames(binaries.ffmpeg, destPath, 64, 32);
      expect(frames).toHaveLength(frameCount);
      for (const [k, frame] of frames.entries()) {
        const span = rowSpan(frame, 64, 16, (r, g, b) => Math.min(r, g, b) > 180);
        if (frameCount > 1 && k === 0) expect(span).toEqual([]);
        else {
          expect(span[0]).toBe(0);
          expect(span[1]).toBe((frameCount === 1 ? 64 : 32 * k) - 1);
        }
      }
    },
  );
});
