/**
 * Tests for {@link ./node-media-adapter}: real mediabunny probing in pure
 * Node against the deterministic embedded MP4 fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeLocalMediaFile } from "./node-media-adapter";
import {
  TINY_MP4_BASE64,
  TINY_MP4_EXPECTED,
  TINY_MP4_FILENAME,
  tinyMp4Bytes,
  writeTinyMp4,
} from "./fixtures/tiny-mp4";

describe("tiny-mp4 fixture", () => {
  it("decodes to a well-formed, deterministic MP4", () => {
    const bytes = tinyMp4Bytes();
    expect(bytes.byteLength).toBeGreaterThan(1000); // ~3.7 KB
    // ISO base media signature at offset 4: 'ftyp'.
    const signature = Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString(
      "latin1",
    );
    expect(signature).toBe("ftyp");
    // Round-trips through the exported constant as well.
    expect(Buffer.from(TINY_MP4_BASE64, "base64").byteLength).toBe(
      bytes.byteLength,
    );
  });
});

describe("probeLocalMediaFile", () => {
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "node-media-adapter-"));
    fixturePath = writeTinyMp4(fixtureDir);
    expect(fixturePath.endsWith(TINY_MP4_FILENAME)).toBe(true);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it("probes the tiny MP4's real metadata", async () => {
    const probed = await probeLocalMediaFile(fixturePath);

    expect(probed.type).toBe("video");
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(false);

    expect(probed.width).toBe(TINY_MP4_EXPECTED.width); // 320
    expect(probed.height).toBe(TINY_MP4_EXPECTED.height); // 180

    // Container timing is rounded; expected duration is 6.0 s +/- 0.1 s.
    expect(
      Math.abs(probed.durationSec - TINY_MP4_EXPECTED.durationSec),
    ).toBeLessThanOrEqual(0.1);
    // Cross-check ffprobe-measured duration on the same bytes (6.000000 s).
    expect(probed.durationSec).toBeCloseTo(6.0, 1);

    expect(probed.fileSize).toBe(tinyMp4Bytes().byteLength);
    expect(probed.fileSize).toBeGreaterThan(0);

    expect(typeof probed.codec).toBe("string");
    expect(probed.codec.length).toBeGreaterThan(0);

    expect(probed.mimeType.startsWith("video/")).toBe(true);
  }, 30000);

  it("recovers a best-effort nonzero frame rate", async () => {
    const probed = await probeLocalMediaFile(fixturePath);
    // The fixture is 10 fps; computePacketStats demuxes ~100 packets, so the
    // measured average packet rate must land near 10 (not fall back to 0).
    expect(probed.frameRate).toBeCloseTo(10, -1); // within +-5 of 10
    console.info(`probed frameRate=${probed.frameRate.toFixed(3)} fps`);
  }, 30000);

  it("throws a clear error for a nonexistent path", async () => {
    const missing = path.join(fixtureDir, "nope.mp4");
    await expect(probeLocalMediaFile(missing)).rejects.toThrowError(
      /cannot read media file/i,
    );
  });

  it("throws when the input is not decodable media (text wearing .mp4)", async () => {
    const fake = path.join(fixtureDir, "actually-text.mp4");
    await writeFile(fake, "this is definitely not an mp4 file", "utf8");
    await expect(probeLocalMediaFile(fake)).rejects.toThrowError(
      /failed to probe|unsupported media/i,
    );
  }, 30000);
});
