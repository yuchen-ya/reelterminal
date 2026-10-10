import { describe, expect, it } from "vitest";
import {
  findNextAudioClipStartTime,
  findNextClipStartTime,
  findNextMotionInstanceStartTime,
  findNextShapeClipStartTime,
  findNextTextClipStartTime,
  type NextContentStartTimedLike,
  type NextContentStartTrackLike,
} from "./next-content-start";

interface TestClip extends NextContentStartTimedLike {
  readonly id: string;
}

function clip(id: string, startTime: number): TestClip {
  return { id, startTime };
}

function track(
  type: string,
  clips: TestClip[],
  hidden = false,
): NextContentStartTrackLike<TestClip> {
  return { type, clips, hidden };
}

describe("findNextClipStartTime", () => {
  it("returns null for empty or exhausted track lists", () => {
    expect(findNextClipStartTime([], 0)).toBeNull();
    expect(
      findNextClipStartTime([track("video", [clip("a", 0), clip("b", 5)])], 5),
    ).toBeNull();
  });

  it("picks the earliest following start across visible video/image tracks only", () => {
    const tracks = [
      track("video", [clip("v1", 2), clip("v2", 9)]),
      track("image", [clip("i1", 4)]),
      track("video", [clip("hidden", 1)], true),
      track("audio", [clip("a1", 0.5)]),
    ];
    expect(findNextClipStartTime(tracks, 1)).toBe(2);
    expect(findNextClipStartTime(tracks, 2)).toBe(4);
    expect(findNextClipStartTime(tracks, 4)).toBe(9);
  });
});

describe("findNextTextClipStartTime", () => {
  it("returns null when empty and the minimum start otherwise", () => {
    expect(findNextTextClipStartTime([], 0)).toBeNull();
    expect(
      findNextTextClipStartTime([clip("t2", 7), clip("t1", 3)], 1),
    ).toBe(3);
    expect(findNextTextClipStartTime([clip("t1", 3)], 3)).toBeNull();
  });
});

describe("findNextShapeClipStartTime", () => {
  it("returns the smallest start strictly after afterTime", () => {
    expect(
      findNextShapeClipStartTime([clip("s2", 12), clip("s1", 6)], 5),
    ).toBe(6);
    expect(findNextShapeClipStartTime([], 5)).toBeNull();
  });
});

describe("findNextMotionInstanceStartTime", () => {
  it("returns null when empty and the minimum start otherwise", () => {
    expect(findNextMotionInstanceStartTime([], 0)).toBeNull();
    expect(
      findNextMotionInstanceStartTime(
        [{ startTime: 8 }, { startTime: 3.5 }],
        2,
      ),
    ).toBe(3.5);
  });
});

describe("findNextAudioClipStartTime", () => {
  it("considers only visible audio tracks", () => {
    const tracks = [
      track("video", [clip("v1", 1)]),
      track("audio", [clip("a2", 10)]),
      track("audio", [clip("a1", 4)], true),
    ];
    expect(findNextAudioClipStartTime(tracks, 0)).toBe(10);
    expect(findNextAudioClipStartTime([], 0)).toBeNull();
  });
});
