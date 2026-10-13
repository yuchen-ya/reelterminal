import { describe, expect, it } from "vitest";
import { canCommitHistoryFrame } from "./history-frame-readiness";

describe("history preview frame readiness", () => {
  it("does not treat a rendered text overlay as valid while its active video is missing", () => {
    // The overlay rendered, but the video clip that should sit underneath it
    // did not decode; the retained bitmap must remain until the video arrives.
    expect(canCommitHistoryFrame({
      historyFramePending: true,
      renderedContent: true,
      expectedVideoClipIds: new Set(["video-clip"]),
      decodedVideoClipIds: new Set(),
    })).toBe(false);
  });

  it("accepts an empty history frame and a complete video composition", () => {
    expect(canCommitHistoryFrame({
      historyFramePending: true,
      renderedContent: true,
      expectedVideoClipIds: new Set(),
      decodedVideoClipIds: new Set(),
    })).toBe(true);
    expect(canCommitHistoryFrame({
      historyFramePending: true,
      renderedContent: true,
      expectedVideoClipIds: new Set(["video-clip"]),
      decodedVideoClipIds: new Set(["video-clip"]),
    })).toBe(true);
  });
});
