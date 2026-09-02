import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade } from "./index";
import type { RenderProvider } from "./providers";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
});
