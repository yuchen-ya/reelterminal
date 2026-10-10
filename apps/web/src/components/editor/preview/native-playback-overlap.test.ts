import { describe, expect, it } from "vitest";
import { hasOverlappingSortedVideoClips } from "./native-playback-overlap";

describe("hasOverlappingSortedVideoClips", () => {
  it("treats decimal clip endpoints with floating-point residue as adjacent", () => {
    expect(
      hasOverlappingSortedVideoClips([
        { startTime: 76.7, duration: 7.4 },
        { startTime: 84.1, duration: 2 },
      ]),
    ).toBe(false);
  });

  it("keeps native playback disabled for a real clip overlap", () => {
    expect(
      hasOverlappingSortedVideoClips([
        { startTime: 76.7, duration: 7.4 },
        { startTime: 84.09, duration: 2 },
      ]),
    ).toBe(true);
  });

  it("allows a gap between clips", () => {
    expect(
      hasOverlappingSortedVideoClips([
        { startTime: 1, duration: 2 },
        { startTime: 3.1, duration: 1 },
      ]),
    ).toBe(false);
  });
});
