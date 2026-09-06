import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAgentFacade } from "./index";
import type { RenderProvider } from "./providers";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const execute = promisify(execFile);

/** Real incompressible noise frame — an honest worst case for PNG delivery. */
async function noisePngBytes(width = 1024, height = 576): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "visual-noise-"));
  try {
    const png = path.join(dir, "noise.png");
    await execute("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", `nullsrc=s=${width}x${height},geq=random(1)*255:random(1)*255:random(1)*255`, "-frames:v", "1", "-y", png], { timeout: 30000 });
    const { readFile } = await import("node:fs/promises");
    return readFile(png);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function provider(withSheet = true): RenderProvider {
  const write = async (destPath: string): Promise<void> => {
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, PNG);
  };
  return {
    id: "visual-test-render",
    preflight: async () => ({ available: true }),
    renderFramePng: async (request) => {
      await write(request.destPath);
      return { bytesWritten: PNG.length };
    },
    ...(withSheet
      ? {
          renderContactSheetPng: async (request) => {
            await write(request.destPath);
            return { bytesWritten: PNG.length };
          },
        }
      : {}),
  };
}

/** Provider whose frames are oversized PNGs that must be budget-fitted. */
function noiseProvider(frame: Buffer): RenderProvider {
  return {
    id: "visual-noise-render",
    preflight: async () => ({ available: true }),
    renderFramePng: async (request) => {
      await mkdir(path.dirname(request.destPath), { recursive: true });
      await writeFile(request.destPath, frame);
      return { bytesWritten: frame.length };
    },
  };
}

describe("visual.inspect", () => {
  let mediaRoot: string;
  let artifactRoot: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "visual-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "visual-artifacts-"));
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  async function seeded(withSheet = true) {
    const mediaPath = writeTinyMp4(mediaRoot);
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: provider(withSheet),
    });
    const created = await facade["project.create"]({ name: "Visual" });
    expect(created.ok).toBe(true);
    const imported = await facade["media.import"]({ path: mediaPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("media import failed");
    const track = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    expect(track.ok).toBe(true);
    const clip = await facade["edit.apply"]({
      ops: [{
        op: "clip.add",
        trackId: "v1",
        mediaId: imported.value.mediaId,
        clipId: "clip-1",
        startTime: 0,
        duration: 1,
        inPoint: 0,
        outPoint: 1,
      }],
    });
    expect(clip.ok).toBe(true);
    return facade;
  }

  it("samples a clip with source revisions and a real contact-sheet artifact", async () => {
    const facade = await seeded(true);
    const result = await facade["visual.inspect"]({
      clipId: "clip-1",
      sampleCount: 3,
      width: 320,
      height: 180,
      idempotencyKey: "visual-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frames).toHaveLength(3);
    expect(result.value.frames.map((frame) => frame.sourceRevision)).toEqual([3, 3, 3]);
    expect(result.value.frames.map((frame) => frame.label)).toEqual([
      "clip:clip-1 1/3",
      "clip:clip-1 2/3",
      "clip:clip-1 3/3",
    ]);
    expect(result.value.contactSheet?.format).toBe("png");
    expect(result.value.contactSheet?.sourceRevision).toBe(3);
    const replay = await facade["visual.inspect"]({ clipId: "clip-1", sampleCount: 3, width: 320, height: 180, idempotencyKey: "visual-1" });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
  });

  it("falls back to individually rendered PNGs when sheet composition is unavailable", async () => {
    const facade = await seeded(false);
    const result = await facade["visual.inspect"]({
      timeRange: { startSec: 0.1, endSec: 0.9 },
      sampleCount: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contactSheet).toBeNull();
    expect(result.value.frames).toHaveLength(2);
    expect(result.value.limitations.join(" ")).toContain("individual frame PNGs");
  });

  it("requires exactly one selection and rejects oversized visual rasters", async () => {
    const facade = await seeded();
    const missing = await facade["visual.inspect"]({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID_PARAMS");
    const both = await facade["visual.inspect"]({ clipId: "clip-1", timeRange: { startSec: 0, endSec: 1 } });
    expect(both.ok).toBe(false);
    const oversized = await facade["visual.inspect"]({ clipId: "clip-1", width: 2048 });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error.code).toBe("INVALID_PARAMS");
  });

  it("fits oversized frames into the byte budget with per-frame fidelity disclosure", async () => {
    const frame = await noisePngBytes();
    expect(frame.length).toBeGreaterThan(1.5 * 1024 * 1024); // the default budget must engage
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: noiseProvider(frame),
    });
    await facade["project.create"]({ name: "Noisy" });
    const imported = await facade["media.import"]({ path: writeTinyMp4(mediaRoot) });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("media import failed");
    await facade["edit.apply"]({ ops: [{ op: "track.add", trackType: "video", trackId: "v1" }] });
    await facade["edit.apply"]({ ops: [{ op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, clipId: "clip-1", startTime: 0, duration: 1, inPoint: 0, outPoint: 1 }] });
    const result = await facade["visual.inspect"]({ clipId: "clip-1", sampleCount: 2, width: 640, height: 360 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frameBudgetBytes).toBe(1_572_864);
    for (const delivered of result.value.frames) {
      expect(delivered.artifact.format).toBe("jpeg");
      expect(delivered.artifact.sizeBytes).toBeLessThanOrEqual(1_572_864);
      expect(delivered.fidelity).toMatchObject({ format: "jpeg", sourceWidth: 1920, sourceHeight: 1080, withinBudget: true });
      expect(delivered.fidelity.note).toContain("recompress");
    }
    expect(result.value.limitations.join(" ")).toContain("lossless budget");
    // An explicit generous budget keeps the lossless PNG.
    const lossless = await facade["visual.inspect"]({ clipId: "clip-1", sampleCount: 1, width: 640, height: 360, maxFrameBytes: 8 * 1024 * 1024 });
    expect(lossless.ok).toBe(true);
    if (lossless.ok) {
      expect(lossless.value.frameBudgetBytes).toBe(8 * 1024 * 1024);
      expect(lossless.value.frames[0].artifact.format).toBe("png");
      expect(lossless.value.frames[0].fidelity.withinBudget).toBe(true);
    }
    // Out-of-range budgets are rejected at the schema boundary.
    const invalid = await facade["visual.inspect"]({ clipId: "clip-1", maxFrameBytes: 1000 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_PARAMS");
  }, 30000);
});
