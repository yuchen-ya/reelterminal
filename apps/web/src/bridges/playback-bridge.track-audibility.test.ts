import { describe, expect, it } from "vitest";
import { PlaybackBridge } from "./playback-bridge";

/**
 * Video tracks carry embedded audio, so the preview audibility rule must
 * stay type-agnostic — every track is judged only by its muted/solo flags.
 */
describe("PlaybackBridge track audibility", () => {
  const bridge = new PlaybackBridge();

  it("excludes explicitly muted tracks of any type from the mix", () => {
    expect(
      bridge.isTrackAudible({ muted: true, solo: false }, false),
    ).toBe(false);
    expect(
      bridge.isTrackAudible({ muted: false, solo: false }, false),
    ).toBe(true);
  });

  it("suppresses non-soloed tracks of any type while any track solos", () => {
    expect(bridge.isTrackAudible({ muted: false, solo: false }, true)).toBe(
      false,
    );
    expect(bridge.isTrackAudible({ muted: false, solo: true }, true)).toBe(
      true,
    );
    expect(bridge.isTrackAudible({ muted: true, solo: true }, true)).toBe(
      false,
    );
  });

  it("computes per-track audibility across mixed audio and video tracks", () => {
    const audibility = bridge.getTrackAudibility([
      { id: "video-1", muted: true, solo: false },
      { id: "video-2", muted: false, solo: true },
      { id: "audio-1", muted: false, solo: false },
    ]);

    expect(audibility.map((entry) => entry.isAudible)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
