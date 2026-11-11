import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

// The cells encode the source frame index above the rectangle. The adjustment
// inverts both the cells and the rectangle until the source clip ends at 4s.
const width = 320;
const height = 180;
const cellY = 24;
const bits = 7;
const white = [255, 255, 255];
const black = [0, 0, 0];
const blue = [59, 130, 246];
const invertedBlue = blue.map(value => 255 - value);
const points = [[160, 90], [4, 4], ...Array.from({ length: bits }, (_, bit) => [30 + bit * 38, cellY])];

function expectColor(actual: number[], expected: number[], tolerance: number) {
  expected.forEach((value, index) => expect(Math.abs(actual[index] - value)).toBeLessThanOrEqual(tolerance));
}

function decodedNumber(samples: number[][]): number {
  return samples.slice(2).reduce((total, [red], bit) => total + (red < 128 ? 2 ** bit : 0), 0);
}

test("the player, timeline PNG and both MP4 exports retain effects, source frames and the overlay tail", async () => {
  const launched = await launchApp();
  let agent: ExternalAgent | undefined;
  try {
    const { app, page, runDir } = launched;
    await createProjectViaUI(page);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const call = async <T,>(name: string, args = {}) => value(await agent!.callCommand<T>(name, args));
    const { identity } = await call<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context");
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const revision = async () => (await call<{ revision: number }>("project.get_state", target)).revision;
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
    const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
    const source = path.join(runDir, "numbered.mp4");
    const filter = points.slice(2).map(([x, y], bit) =>
      `drawbox=x=${x - 6}:y=${y - 6}:w=12:h=12:color=white:t=fill:enable='bitand(n,${2 ** bit})'`).join(",");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=4",
      "-vf", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { windowsHide: true });
    const { mediaId } = await call<{ mediaId: string }>("media.import", { ...target, path: source, expectedRevision: await revision() });
    await call("edit.apply", { ...target, expectedRevision: await revision(), ops: [
      { op: "track.add", trackType: "video", trackId: "numbered-track" },
      { op: "clip.add", mediaId, trackId: "numbered-track", startTime: 0, duration: 4 },
    ] });
    await page.getByRole("button", { name: "Graphics", exact: true }).click();
    await page.getByRole("button", { name: "Rectangle", exact: true }).click();
    await page.getByRole("button", { name: "Select clip numbered.mp4", exact: true }).click();
    await page.getByRole("button", { name: "Expand Adjustment Layers section" }).click();
    await page.getByRole("button", { name: "Add Adjustment Layer" }).click();
    await page.getByRole("button", { name: "+ Invert", exact: true }).click();

    const readCanvas = () => page.getByTestId("preview-canvas").evaluate((element, points) => {
      const canvas = element as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      return points.map(([x, y]) => Array.from(ctx.getImageData(
        Math.floor(x * canvas.width / 320), Math.floor(y * canvas.height / 180), 1, 1,
      ).data.slice(0, 3)));
    }, points);
    const seek = (timeSeconds: number) => call("editor.control", { ...target, action: "seek", timeSeconds });
    const checkContent = (samples: number[][], frame: number, tolerance = 1) => {
      if (frame < 120) {
        expectColor(samples[0], invertedBlue, tolerance);
        expectColor(samples[1], white, tolerance);
        expect(decodedNumber(samples)).toBe(frame);
      } else {
        expectColor(samples[0], blue, tolerance);
        expectColor(samples[1], black, tolerance);
      }
    };
    const samplesFromFile = (file: string, frame: number) => {
      const raw = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-vf",
        `select=eq(n\\,${frame}),scale=320:180,format=rgb24`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
      { windowsHide: true, timeout: 30000 });
      expect(raw.length).toBe(width * height * 3);
      return points.map(([x, y]) => [...raw.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]);
    };

    await seek(0.5);
    await vi.waitFor(async () => checkContent(await readCanvas(), 15));
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await vi.waitFor(async () => {
      const samples = await readCanvas();
      const frame = decodedNumber(samples);
      expect(frame).toBeGreaterThan(15);
      expect(frame).toBeLessThan(120);
      expectColor(samples[0], invertedBlue, 1);
      expectColor(samples[1], white, 1);
    }, { timeout: 3000, interval: 30 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    // Consecutive boundary frames and the exact timeline end, requested out
    // of order so a stale decoder, old GUI commit or wrong clamp is visible.
    for (const frame of [120, 119, 150, 15]) {
      await seek(frame / 30);
      await vi.waitFor(async () => checkContent(await readCanvas(), frame), { timeout: 10000 });
      const png = await call<{ artifact: { path: string } }>("preview.render_frame",
        { ...target, timeSec: frame / 30, width, height });
      checkContent(samplesFromFile(png.artifact.path, 0), frame);
    }

    const { jobId } = await call<{ jobId: string }>("export.start", {
      ...target, expectedRevision: await revision(), settings: { width, height, frameRate: 30, videoBitrateKbps: 1000 },
    });
    type Job = { state: string; error?: unknown; artifact?: { path: string } };
    const job = await vi.waitFor(async () => {
      const status = await call<Job>("job.status", { jobId });
      expect(["done", "error", "cancelled"]).toContain(status.state);
      return status;
    }, { timeout: 120000, interval: 500 });
    expect(job.state, JSON.stringify(job.error)).toBe("done");
    const desktopFile = path.join(runDir, "desktop.mp4");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, desktopFile);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await page.getByRole("button", { name: "Start Export", exact: true }).click();
    await page.getByText("Export complete", { exact: false }).first().waitFor({ timeout: 120000 });
    for (const file of [job.artifact!.path, desktopFile]) {
      const frames = execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=nb_frames", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true });
      expect(Number(frames)).toBe(150);
      for (const frame of [15, 119, 120, 149]) checkContent(samplesFromFile(file, frame), frame, 10);
    }
  } finally {
    await agent?.close();
    await launched.close();
  }
});
