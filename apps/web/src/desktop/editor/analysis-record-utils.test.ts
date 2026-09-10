import { describe, expect, it } from "vitest";
import { collectEvidenceTimes, findTimelineLocations } from "./analysis-record-utils";

describe("analysis record timeline mapping", () => {
  it("maps trimmed forward and reversed constant-speed clips", () => {
    const project = {
      timeline: {
        tracks: [
          {
            id: "track-a",
            clips: [
              { id: "forward", mediaId: "media-a", startTime: 10, duration: 2, inPoint: 2, outPoint: 6, speed: 2 },
              { id: "reverse", mediaId: "media-a", startTime: 20, duration: 4, inPoint: 2, outPoint: 6, speed: 1, reversed: true },
            ],
          },
        ],
      },
    };
    expect(findTimelineLocations(project, "media-a", 4)).toEqual([
      { clipId: "forward", trackId: "track-a", timelineSec: 11 },
      { clipId: "reverse", trackId: "track-a", timelineSec: 22 },
    ]);
  });

  it("does not claim an approximate location for variable speed", () => {
    const project = {
      timeline: {
        tracks: [{ id: "t", clips: [{ id: "c", mediaId: "m", startTime: 0, duration: 5, inPoint: 0, outPoint: 5, speedKeyframes: [{}] }] }],
      },
    };
    expect(findTimelineLocations(project, "m", 2)).toEqual([]);
  });
});

describe("analysis evidence time extraction", () => {
  it("extracts explicit times and onsets without mistaking durations for positions", () => {
    expect(collectEvidenceTimes({ durationSec: 9, facts: { startSec: 1, endSec: 3, onsets: [1.2, 2.4] } })).toEqual([
      { label: "facts.startSec", sourceSec: 1 },
      { label: "facts.endSec", sourceSec: 3 },
      { label: "facts.onsets[0]", sourceSec: 1.2 },
      { label: "facts.onsets[1]", sourceSec: 2.4 },
    ]);
  });
});
