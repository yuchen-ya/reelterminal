import { describe, expect, it } from "vitest";
import { collectNativePlaybackImageClips, type NativeImageTrackLike } from "./native-playback-image-clips";

interface TestClip {
  readonly id: string;
  readonly mediaId: string;
}

function track(
  type: string,
  clips: TestClip[],
  hidden = false,
): NativeImageTrackLike<TestClip> {
  return { type, clips, hidden };
}

describe("collectNativePlaybackImageClips", () => {
  const mediaTypeOf = (clip: TestClip, types: Record<string, string> = {}) =>
    types[clip.mediaId];

  it("collects every clip on visible image tracks regardless of media records", () => {
    const clips: TestClip[] = [
      { id: "i1", mediaId: "m1" },
      { id: "i2", mediaId: "missing" },
    ];
    const entries = collectNativePlaybackImageClips(
      [track("image", clips)],
      (clip) => mediaTypeOf(clip),
    );
    expect(entries.map((entry) => entry.clip.id)).toEqual(["i1", "i2"]);
    expect(entries.every((entry) => entry.trackIndex === 0)).toBe(true);
  });

  it("collects image-media clips on video tracks next to video clips", () => {
    const videoTrack = track("video", [
      { id: "still", mediaId: "jpg-1" },
      { id: "movie", mediaId: "mp4-1" },
      { id: "still2", mediaId: "jpg-2" },
      { id: "unresolved", mediaId: "no-record" },
    ]);
    const entries = collectNativePlaybackImageClips(
      [videoTrack, track("image", [{ id: "layered", mediaId: "jpg-3" }])],
      (clip) =>
        mediaTypeOf(clip, {
          "jpg-1": "image",
          "jpg-2": "image",
          "jpg-3": "image",
          "mp4-1": "video",
        }),
    );
    // The video-track stills must not vanish during native playback, and the
    // image-track clip keeps its own (higher) track index for z-order.
    expect(entries.map((entry) => entry.clip.id)).toEqual(["still", "still2", "layered"]);
    expect(entries.map((entry) => entry.trackIndex)).toEqual([0, 0, 1]);
  });

  it("skips hidden tracks and non-visual track kinds", () => {
    const entries = collectNativePlaybackImageClips(
      [
        track("video", [{ id: "v-still", mediaId: "jpg-1" }], true),
        track("audio", [{ id: "a-still", mediaId: "jpg-2" }]),
        track("video", [{ id: "v-movie", mediaId: "mp4-1" }]),
      ],
      (clip) =>
        mediaTypeOf(clip, { "jpg-1": "image", "jpg-2": "image", "mp4-1": "video" }),
    );
    expect(entries).toEqual([]);
  });
});
