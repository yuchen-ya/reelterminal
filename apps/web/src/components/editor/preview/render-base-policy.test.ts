import { describe, expect, it } from "vitest";

import {
  type RenderBaseClipCandidate,
  isFullFrameActiveVideoClip,
  resolveRenderBase,
} from "./render-base-policy";
import { DEFAULT_TRANSFORM } from "./types";

const baseClip: RenderBaseClipCandidate = {
  mediaType: "video",
  trackHidden: false,
  startTime: 0,
  duration: 10,
  transform: DEFAULT_TRANSFORM,
};

const withTransform = (
  patch: Partial<NonNullable<RenderBaseClipCandidate["transform"]>>,
): RenderBaseClipCandidate => ({
  ...baseClip,
  transform: { ...DEFAULT_TRANSFORM, ...patch },
});

describe("isFullFrameActiveVideoClip", () => {
  it("is true for a visible, untransformed, active video clip", () => {
    expect(isFullFrameActiveVideoClip(baseClip, 5)).toBe(true);
  });

  it("treats a missing transform as identity", () => {
    expect(isFullFrameActiveVideoClip({ ...baseClip, transform: null }, 5)).toBe(
      true,
    );
  });

  it("is active on the half-open interval [start, start + duration)", () => {
    expect(isFullFrameActiveVideoClip(baseClip, 0)).toBe(true);
    expect(isFullFrameActiveVideoClip(baseClip, 9.999)).toBe(true);
    expect(isFullFrameActiveVideoClip(baseClip, 10)).toBe(false);
    expect(isFullFrameActiveVideoClip(baseClip, -0.001)).toBe(false);
  });

  it("rejects clips on hidden tracks", () => {
    expect(
      isFullFrameActiveVideoClip({ ...baseClip, trackHidden: true }, 5),
    ).toBe(false);
  });

  it("rejects image clips: their raw bitmaps may letterbox", () => {
    expect(
      isFullFrameActiveVideoClip({ ...baseClip, mediaType: "image" }, 5),
    ).toBe(false);
  });

  it("rejects clips transformed away from full coverage", () => {
    expect(isFullFrameActiveVideoClip(withTransform({ scale: { x: 0.5, y: 0.5 } }), 5)).toBe(false);
    expect(
      isFullFrameActiveVideoClip(
        withTransform({ position: { x: 120, y: 0 } }),
        5,
      ),
    ).toBe(false);
    expect(isFullFrameActiveVideoClip(withTransform({ rotation: 15 }), 5)).toBe(
      false,
    );
    expect(isFullFrameActiveVideoClip(withTransform({ opacity: 0.5 }), 5)).toBe(
      false,
    );
  });

  it("accepts near-identity transforms within epsilon", () => {
    expect(
      isFullFrameActiveVideoClip(
        withTransform({ scale: { x: 1 + 1e-9, y: 1 } }),
        5,
      ),
    ).toBe(true);
  });
});

describe("resolveRenderBase", () => {
  it("starts from the background when no previous frame exists", () => {
    expect(
      resolveRenderBase({ time: 5, hasLastGoodFrame: false, clips: [] }),
    ).toBe("background");
  });

  it("replaces the frame when a full-frame active video clip exists, even with a previous frame", () => {
    // Regression: with the previous frame as the base, a chroma-keyed frame
    // (large transparent regions) composited over the stale baked frame let
    // the un-keyed pixels shine through — effect changes never showed after
    // the first draw. The policy must force a clean-background redraw here.
    expect(
      resolveRenderBase({
        time: 5,
        hasLastGoodFrame: true,
        clips: [baseClip],
      }),
    ).toBe("background");
  });

  it("keeps the previous frame as base for picture-in-picture video", () => {
    expect(
      resolveRenderBase({
        time: 5,
        hasLastGoodFrame: true,
        clips: [withTransform({ scale: { x: 0.3, y: 0.3 } })],
      }),
    ).toBe("lastFrame");
  });

  it("keeps the previous frame as base for image-only compositions", () => {
    expect(
      resolveRenderBase({
        time: 5,
        hasLastGoodFrame: true,
        clips: [{ ...baseClip, mediaType: "image" }],
      }),
    ).toBe("lastFrame");
  });

  it("keeps the previous frame as base when the video clip is inactive (gap)", () => {
    expect(
      resolveRenderBase({
        time: 15,
        hasLastGoodFrame: true,
        clips: [baseClip],
      }),
    ).toBe("lastFrame");
  });

  it("keeps the previous frame as base when the video track is hidden", () => {
    expect(
      resolveRenderBase({
        time: 5,
        hasLastGoodFrame: true,
        clips: [{ ...baseClip, trackHidden: true }],
      }),
    ).toBe("lastFrame");
  });

  it("simulating chromaKey enable -> disable -> enable: every draw replaces instead of stacking", () => {
    // Draw 1 (project load): no previous frame -> background.
    // Draw 2 (key disabled, previous = raw full-green frame): the clip still
    //   owns the frame -> background (raw frame replaces cleanly).
    // Draw 3 (key re-enabled, previous = baked full-green frame): MUST be
    //   background. The old behaviour ("lastFrame") is exactly the defect:
    //   the keyed frame's transparent green region revealed the baked green.
    let hasLastGoodFrame = false;
    const decision = () =>
      resolveRenderBase({
        time: 5,
        hasLastGoodFrame,
        clips: [baseClip],
      });

    expect(decision()).toBe("background");
    hasLastGoodFrame = true; // every rendered frame re-bakes lastGoodFrame
    expect(decision()).toBe("background");
    expect(decision()).toBe("background");
  });
});
