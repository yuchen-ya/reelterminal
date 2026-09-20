/**
 * Runtime probe E2E: launches real Chromium, records machine-readable facts,
 * saves them as JSON evidence. The probe is the capability source of truth —
 * this test pins its shape and its honesty (a probe that can't launch still
 * returns an all-false result, never a throw).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TINY_MP4_EXPECTED,
  writeTinyMp4,
} from "@reelterminal/agent-facade/media/fixtures/tiny-mp4";
import { runChromiumRuntimeProbe } from "./node/probe";
import { saveEvidence } from "./evidence";

describe("chromium runtime probe", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "probe-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("produces a machine-readable probe result with real facts", async () => {
    const samplePath = writeTinyMp4(workDir);
    const result = await runChromiumRuntimeProbe({
      sampleMediaPath: samplePath,
    });

    // Persist the machine-readable result and re-read it (what CI uploads).
    const outPath = path.join(workDir, "runtime-probe.json");
    await writeFile(outPath, JSON.stringify(result, null, 2));
    const persisted = JSON.parse(await readFile(outPath, "utf8")) as typeof result;
    expect(persisted.probeVersion).toBe(1);
    const evidencePath = await saveEvidence("runtime-probe.json", result);
    console.log(`[probe] evidence saved: ${evidencePath}`);

    console.log(
      `[probe] chromium=${result.chromium.version} route=${result.summary.exportRoute} ` +
        `render=${result.summary.renderAvailable} h264dec=${result.summary.h264DecodeAvailable} ` +
        `h264enc=${result.summary.h264EncodeAvailable} ffmpeg=${result.ffmpeg.available} ` +
        `decodeSample=${JSON.stringify(result.page.decodeSample)} (${result.durationMs}ms)`,
    );

    // Launch must succeed on a dev machine / CI image with Chromium present.
    expect(result.launchError).toBeUndefined();
    expect(result.chromium.version).toMatch(/^\d+\./);
    expect(result.chromium.userAgent).toContain("Chrome");

    // OffscreenCanvas + PNG encode smoke.
    expect(result.page.offscreenCanvas).toBe(true);
    expect(result.page.offscreenPngEncode).toBe(true);

    // Core engine availability.
    expect(result.page.videoEngineInit).toBe(true);
    expect(result.page.exportEngineInit).toBe(true);
    expect(result.page.mediabunnyLoaded).toBe(true);
    expect(result.page.webCodecsSupported).toBe(true);

    // Codec fact maps are populated (content varies by platform).
    expect(Object.keys(result.page.videoDecoder).length).toBeGreaterThan(0);
    expect(Object.keys(result.page.videoEncoder).length).toBeGreaterThan(0);
    expect(result.page.firstEncodableVideo).not.toBeNull();

    // The h264 sample decode smoke ran and reports an explicit verdict.
    expect(result.page.decodeSample).not.toBeNull();
    expect(result.page.decodeSample?.attempted).toBe(true);
    if (result.page.decodeSample?.ok) {
      expect(result.page.decodeSample.codec).toContain("avc");
      expect(result.page.decodeSample.width).toBe(TINY_MP4_EXPECTED.width);
      expect(result.page.decodeSample.height).toBe(TINY_MP4_EXPECTED.height);
    }

    // Summary coherence: the DEFAULT route is only ever WebCodecs or
    // unavailable — the video-only frames route is an explicit opt-in
    // experiment and must never be derived silently. "unavailable" always
    // carries a reason.
    expect(["chromium-webcodecs", "unavailable"]).toContain(
      result.summary.exportRoute,
    );
    if (result.summary.exportRoute === "unavailable") {
      expect(result.summary.exportUnavailableReason).toBeTruthy();
    }
    if (result.summary.exportRoute === "chromium-webcodecs") {
      // Route W requires BOTH the codec and a working ExportEngine.
      expect(result.summary.h264EncodeAvailable).toBe(true);
      expect(result.page.exportEngineInit).toBe(true);
    }
    // The video-only experiment's availability is a fact, not a route claim.
    if (result.summary.videoOnlyFramesRouteAvailable) {
      expect(result.ffmpeg.available).toBe(true);
      expect(result.summary.renderAvailable).toBe(true);
    }

    // Render availability implies all its prerequisites (no inflated claim).
    if (result.summary.renderAvailable) {
      expect(result.page.offscreenPngEncode).toBe(true);
      expect(result.page.videoEngineInit).toBe(true);
      expect(result.page.mediabunnyLoaded).toBe(true);
    }
  });

  it("is repeatable: two runs agree on capability facts", async () => {
    const first = await runChromiumRuntimeProbe();
    const second = await runChromiumRuntimeProbe();
    expect(second.summary).toEqual(first.summary);
    expect(second.page.videoDecoder).toEqual(first.page.videoDecoder);
    expect(second.page.videoEncoder).toEqual(first.page.videoEncoder);
    expect(second.ffmpeg.available).toBe(first.ffmpeg.available);
  });
});
