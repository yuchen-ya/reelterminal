import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import type { RenderProvider } from "./providers";
import {
  fingerprintFile,
  fingerprintMediaFiles,
  inspectionRequestKey,
  publishArtifact,
} from "./inspection-artifacts";

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inspection-artifacts-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable inspection artifact publication", () => {
  it("atomically reuses an identical published file and removes only its temp", async () => {
    const root = await testRoot();
    const dir = join(root, "visual", "frames");
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, "frame.png");
    const tempPath = join(dir, ".frame.attempt.png");
    await writeFile(finalPath, "published bytes");
    await writeFile(tempPath, "published bytes");
    const before = await stat(finalPath);

    await expect(publishArtifact({
      tempPath,
      finalPath,
      artifactRoot: root,
      verb: "visual.inspect",
    })).resolves.toBe(await realpath(finalPath));

    expect(await readFile(finalPath, "utf8")).toBe("published bytes");
    expect((await stat(finalPath)).ino).toBe(before.ino);
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite different bytes at an already-published path", async () => {
    const root = await testRoot();
    const dir = join(root, "visual", "frames");
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, "frame.png");
    const tempPath = join(dir, ".frame.attempt.png");
    await writeFile(finalPath, "first immutable evidence");
    await writeFile(tempPath, "later different render");
    const before = await stat(finalPath);

    await expect(publishArtifact({
      tempPath,
      finalPath,
      artifactRoot: root,
      verb: "visual.inspect",
    })).rejects.toThrow(/different bytes.*refusing to overwrite immutable evidence/);

    expect(await readFile(finalPath, "utf8")).toBe("first immutable evidence");
    expect((await stat(finalPath)).ino).toBe(before.ino);
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows exactly one concurrent publisher and never replaces the winner", async () => {
    const root = await testRoot();
    const dir = join(root, "visual", "frames");
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, "frame.png");
    const attempts = Array.from({ length: 12 }, (_, index) => ({
      tempPath: join(dir, `.frame.${index}.png`),
      bytes: index % 2 === 0 ? "render A" : "render B",
    }));
    await Promise.all(attempts.map(({ tempPath, bytes }) => writeFile(tempPath, bytes)));

    const results = await Promise.allSettled(attempts.map(({ tempPath }) => publishArtifact({
      tempPath,
      finalPath,
      artifactRoot: root,
      verb: "visual.inspect",
    })));

    const winner = await readFile(finalPath, "utf8");
    expect(["render A", "render B"]).toContain(winner);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    // Every byte-identical attempt reuses the winner; every differing attempt
    // fails explicitly. No attempt can replace the inode created by the winner.
    expect(fulfilled).toHaveLength(6);
    expect(rejected).toHaveLength(6);
    expect(rejected.every((result) =>
      result.status === "rejected" && /different bytes/.test(String(result.reason)),
    )).toBe(true);
    expect(await readdir(dir)).toEqual(["frame.png"]);
  });

  it("failure cleanup leaves a pre-existing non-file destination untouched", async () => {
    const root = await testRoot();
    const dir = join(root, "visual", "frames");
    const finalPath = join(dir, "frame.png");
    const tempPath = join(dir, ".frame.attempt.png");
    await mkdir(finalPath, { recursive: true });
    await writeFile(tempPath, "candidate");

    await expect(publishArtifact({
      tempPath,
      finalPath,
      artifactRoot: root,
      verb: "visual.inspect",
    })).rejects.toThrow(/not a regular file/);

    expect((await stat(finalPath)).isDirectory()).toBe(true);
    await expect(stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["preview.render_frame", "visual.inspect"] as const)(
    "%s rejects a source change during rendering and removes its unpublished temp",
    async (verb) => {
      const root = await testRoot();
      const mediaRoot = join(root, "media");
      const artifactRoot = join(root, "artifacts");
      await Promise.all([
        mkdir(mediaRoot, { recursive: true }),
        mkdir(artifactRoot, { recursive: true }),
      ]);
      const mediaPath = writeTinyMp4(mediaRoot);
      const onePixelPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const changingProvider: RenderProvider = {
        id: "source-changing-provider",
        preflight: async () => ({ available: true }),
        renderFramePng: async (request) => {
          await writeFile(request.destPath, onePixelPng);
          const before = await stat(mediaPath);
          const bytes = await readFile(mediaPath);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(mediaPath, bytes);
          await utimes(mediaPath, before.atime, before.mtime);
          return { bytesWritten: onePixelPng.length };
        },
      };
      const facade = createAgentFacade({
        mediaRoots: [mediaRoot],
        artifactRoot,
        renderProvider: changingProvider,
      });
      await facade["project.create"]({ name: "Changing source" });
      const imported = await facade["media.import"]({ path: mediaPath });
      expect(imported.ok).toBe(true);
      if (!imported.ok) throw new Error("media import failed");
      await facade["edit.apply"]({ ops: [{ op: "track.add", trackType: "video", trackId: "v1" }] });
      await facade["edit.apply"]({
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

      const result = verb === "preview.render_frame"
        ? await facade["preview.render_frame"]({ timeSec: 0 })
        : await facade["visual.inspect"]({ clipId: "clip-1", sampleCount: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
      const outputDir = verb === "preview.render_frame"
        ? join(artifactRoot, "renders")
        : join(artifactRoot, "visual", "frames");
      expect(await readdir(outputDir)).toEqual([]);
    },
  );
});

describe("inspection source fingerprints", () => {
  it("changes when bytes change even if size and mtime are restored", async () => {
    const root = await testRoot();
    const mediaPath = join(root, "source.mp4");
    await writeFile(mediaPath, "AAAA-same-size");
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    await utimes(mediaPath, fixed, fixed);
    const before = await fingerprintFile(mediaPath);

    await writeFile(mediaPath, "BBBB-same-size");
    await utimes(mediaPath, fixed, fixed);
    const after = await fingerprintFile(mediaPath);

    expect(after.sizeBytes).toBe(before.sizeBytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.sha256).toBe(
      createHash("sha256").update("BBBB-same-size").digest("hex"),
    );
  });

  it("includes the strong source digest in the request key", async () => {
    const root = await testRoot();
    const mediaPath = join(root, "source.mp4");
    await writeFile(mediaPath, "first-source");
    const firstMedia = await fingerprintMediaFiles({ media: mediaPath });
    const parts = {
      projectId: "project",
      revision: 7,
      selector: { kind: "timeRange" as const, startSec: 0, endSec: 1 },
      sampleTimesMs: [0, 500],
      width: 320,
      height: 180,
      maxFrameBytes: 1024,
    };
    const firstKey = inspectionRequestKey({ ...parts, media: firstMedia });

    const original = await stat(mediaPath);
    await writeFile(mediaPath, "other-source");
    await utimes(mediaPath, original.atime, original.mtime);
    const secondMedia = await fingerprintMediaFiles({ media: mediaPath });
    const secondKey = inspectionRequestKey({ ...parts, media: secondMedia });

    expect(firstKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secondKey).toMatch(/^[0-9a-f]{64}$/);
    expect(secondKey).not.toBe(firstKey);
  });
});
