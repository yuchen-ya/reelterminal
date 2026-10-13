import { describe, expect, it } from "vitest";
import {
  decodeVideoMarkerSourcePts,
  decodePcmMarkerSourcePts,
  estimateOutputTimestampMasterPts,
  pcmMarkerAmplitude,
  summarizePlaybackAvErrors,
  videoMarkerGray,
} from "./playback-av-metrics";
import { getConstantSpeedAudioRange } from "@reelterminal/core/audio/clip-audio-timing";

describe("playback AV measurement helpers", () => {
  it("decodes unique source-time markers without using the expected source position", () => {
    const sourcePtsSec = 5.8;
    const amplitude = pcmMarkerAmplitude(sourcePtsSec);
    const rms = amplitude * Math.SQRT1_2;

    expect(decodePcmMarkerSourcePts(rms)).toBe(5.875);
    expect(decodePcmMarkerSourcePts(pcmMarkerAmplitude(1.8) * Math.SQRT1_2)).toBe(1.875);
    expect(decodeVideoMarkerSourcePts(videoMarkerGray(2.7))).toBeCloseTo(2.7);
    expect(decodeVideoMarkerSourcePts(videoMarkerGray(5.9))).toBeCloseTo(5.9);
    expect(decodePcmMarkerSourcePts(0)).toBeNull();
  });

  it("maps output timestamps through the master clock at the observation time", () => {
    const estimate = estimateOutputTimestampMasterPts(
      { contextTime: 10.5, performanceTime: 500 },
      600,
      { contextTimeSec: 10, masterPtsSec: 3, masterRate: 2 },
    );
    expect(estimate.status).toBe("ok");
    expect(estimate.outputContextTimeSec).toBeCloseTo(10.6);
    expect(estimate.masterPtsSec).toBeCloseTo(4.2);
  });

  it("keeps missing or invalid output timestamps unavailable instead of reporting zero", () => {
    const anchor = { contextTimeSec: 1, masterPtsSec: 2, masterRate: 1 };
    expect(estimateOutputTimestampMasterPts({ contextTime: 0, performanceTime: 0 }, 100, anchor).status)
      .toBe("unsupported");
    expect(estimateOutputTimestampMasterPts(null, 100, anchor)).toEqual({
      status: "unsupported",
      reason: "api_unavailable",
      outputContextTimeSec: null,
      masterPtsSec: null,
    });
    expect(estimateOutputTimestampMasterPts(
      { contextTime: Number.NaN, performanceTime: 100 },
      100,
      anchor,
    )).toEqual({
      status: "unsupported",
      reason: "invalid_timestamp",
      outputContextTimeSec: null,
      masterPtsSec: null,
    });
    expect(summarizePlaybackAvErrors([], "unsupported")).toEqual({
      status: "unsupported",
      n: 0,
      p50Ms: null,
      p95Ms: null,
    });
    expect(summarizePlaybackAvErrors([], "not_applicable")).toEqual({
      status: "not_applicable",
      n: 0,
      p50Ms: null,
      p95Ms: null,
    });
  });

  it("withholds under-sampled P95 and uses nearest-rank for enough paired observations", () => {
    expect(summarizePlaybackAvErrors([20, 5, 10, 15])).toEqual({
      status: "insufficient_samples",
      n: 4,
      p50Ms: 10,
      p95Ms: null,
    });
    expect(summarizePlaybackAvErrors(Array.from({ length: 20 }, (_, index) => index + 1)))
      .toEqual({ status: "ok", n: 20, p50Ms: 10, p95Ms: 19 });
  });

  it("recovers source PTS bins from the decoded synthetic video marker", () => {
    const sourcePtsSec = 5.8;
    expect(decodeVideoMarkerSourcePts(videoMarkerGray(sourcePtsSec))).toBe(5.9);
    expect(decodeVideoMarkerSourcePts(255)).toBeNull();
  });

  it.each([
    { speed: 1, reversed: false, offset: 1.1, expectedSourceTime: 3.1 },
    { speed: 2, reversed: false, offset: 1.1, expectedSourceTime: 4.2 },
    { speed: 2, reversed: true, offset: 1.1, expectedSourceTime: 3.8 },
  ])("uses the production audio scheduling range at $speed x reverse=$reversed", ({ speed, reversed, offset, expectedSourceTime }) => {
    const range = getConstantSpeedAudioRange(
      { inPoint: 2, outPoint: 6, speed, reversed },
      offset,
      2,
    );
    expect(range?.sourceTime).toBeCloseTo(expectedSourceTime);
    expect(range?.speed).toBe(speed);
  });
});
