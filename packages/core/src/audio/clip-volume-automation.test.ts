import { describe, expect, it, vi } from "vitest";
import { getVolumeAutomationPointsForRange, scheduleVolumeAutomationOnGain } from "./clip-volume-automation";
import { generateDuckingKeyframesFromRanges } from "./volume-automation";

describe("clip volume automation", () => {
  const zeroRamp = () => generateDuckingKeyframesFromRanges(
    [{ start: 1, end: 3 }],
    { threshold: -30, reduction: 0.5, attack: 0.1, release: 0.5, holdTime: 0.2 },
    0.8,
    { startAfterLastPresenceSec: 0.75, swellRampSec: 0, swellGainRatio: 1.5 },
  );

  it("preserves both sides of a zero-ramp swell in the audible range", () => {
    expect(getVolumeAutomationPointsForRange(zeroRamp(), 3.5, 0.5, 0.8)).toEqual([
      { time: 0, value: 0.8 },
      { time: 0.25, value: 0.8 },
      { time: 0.25, value: 0.8 * 1.5 },
      { time: 0.5, value: 0.8 * 1.5 },
    ]);
    expect(getVolumeAutomationPointsForRange(zeroRamp(), 3.5, 0.25, 0.8)).toEqual([
      { time: 0, value: 0.8 },
      { time: 0.25, value: 0.8 },
      { time: 0.25, value: 0.8 * 1.5 },
    ]);
    for (const offset of [3.75, 3.8]) {
      expect(getVolumeAutomationPointsForRange(zeroRamp(), offset, 0.2, 0.8)).toEqual([
        { time: 0, value: 0.8 * 1.5 },
        { time: 0.2, value: 0.8 * 1.5 },
      ]);
    }
  });

  it("schedules the instantaneous swell as a set event after holding normal volume", () => {
    const gain = { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
    scheduleVolumeAutomationOnGain({ gain } as unknown as GainNode, zeroRamp(), 0.8, 3.5, 0.5, 10);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.8, 10.25);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0.8 * 1.5, 10.25);
    expect(gain.linearRampToValueAtTime).not.toHaveBeenCalledWith(0.8 * 1.5, 10.25);
  });
  it("trims automation to a clip range and interpolates the start and end", () => {
    const points = getVolumeAutomationPointsForRange(
      [
        { time: 0.5, value: 0.4 },
        { time: 1, value: 1 },
      ],
      0.75,
      0.2,
      1,
    );

    expect(points).toEqual([
      { time: 0, value: 0.7 },
      { time: 0.2, value: 0.94 },
    ]);
  });

  it("keeps in-range keyframes and preserves the base volume before the first point", () => {
    const points = getVolumeAutomationPointsForRange(
      [
        { time: 0.4, value: 0.5 },
        { time: 0.9, value: 1 },
      ],
      0,
      0.6,
      0.8,
    );

    expect(points).toEqual([
      { time: 0, value: 0.8 },
      { time: 0.4, value: 0.5 },
      { time: 0.6, value: 0.7 },
    ]);
  });
});
