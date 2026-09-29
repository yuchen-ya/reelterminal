// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fixture = vi.hoisted(() => ({
  project: {
    settings: { frameRate: 30 },
    mediaLibrary: {
      items: [{
        id: "ref",
        name: "Reference cut",
        type: "video",
        originalUrl: "blob:reference-video",
        metadata: { duration: 8 },
      }],
    },
    referenceComparison: {
      referenceMediaId: "ref",
      refStartSec: 1,
      refEndSec: 3,
      timelineStartSec: 2,
      rate: 1,
      audioSide: "reference",
      layout: "overlay",
      overlayOpacity: 0.35,
    },
  },
  timeline: {
    playheadPosition: 2.5,
    playbackState: "paused",
    togglePlayback: vi.fn(),
    seekRelative: vi.fn(),
    seekToStart: vi.fn(),
  },
  executeAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../../stores/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector(fixture),
}));
vi.mock("../../../stores/timeline-store", () => ({
  useTimelineStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(fixture.timeline),
    { getState: () => fixture.timeline },
  ),
}));

import { ReferenceComparisonPanel, resolveReferenceMediaUrl } from "./ReferenceComparisonPanel";

describe("in-player reference comparison", () => {
  beforeEach(() => {
    fixture.timeline.playheadPosition = 2.5;
    fixture.timeline.playbackState = "paused";
    fixture.project.referenceComparison.layout = "overlay";
    fixture.project.referenceComparison.audioSide = "reference";
    fixture.project.mediaLibrary.items = [{
      id: "ref",
      name: "Reference cut",
      type: "video",
      originalUrl: "blob:reference-video",
      metadata: { duration: 8 },
    }];
    fixture.executeAction.mockClear();
    fixture.executeAction.mockResolvedValue({ success: true });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places both frames inside the player and keeps timeline transport out of the comparison UI", async () => {
    render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    const surfaces = screen.getByTestId("comparison-surfaces");
    const video = screen.getByLabelText("Reference video");
    expect(surfaces.contains(screen.getByLabelText("Timeline video"))).toBe(true);
    expect(video.style.opacity).toBe("0.35");
    expect(screen.queryByRole("button", { name: /play|pause/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Side by side" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
      await Promise.resolve();
    });
    expect(fixture.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      params: { config: expect.objectContaining({ layout: "side-by-side" }) },
    }));
  });

  it("syncs the reference from the main playhead and aligns the chosen reference frame", async () => {
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    const video = screen.getByLabelText<HTMLVideoElement>("Reference video");
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(1.5);

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByRole("slider", { name: "Reference position" }), { target: { value: "2.4" } });
    expect(video.currentTime).toBe(2.4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Align this reference frame to the timeline playhead" }));
      await Promise.resolve();
    });
    expect(fixture.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      params: { config: expect.objectContaining({ refStartSec: 2.4, timelineStartSec: 2.5 }) },
    }));

    fixture.timeline.playbackState = "playing";
    fixture.timeline.playheadPosition = 3.5;
    rerender(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    expect(video.currentTime).toBeCloseTo(2.5, 3);
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
  });

  it("honors user mute and shows a recovery state when the source cannot be resolved", async () => {
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} userMuted />);
    const video = screen.getByLabelText<HTMLVideoElement>("Reference video");
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.muted).toBe(true);

    fixture.project.mediaLibrary.items = [];
    rerender(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} userMuted />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Reference media is unavailable"));
  });

  it("prefers a blob URL and falls back to originalUrl", () => {
    const blob = new Blob(["video"]);
    expect(resolveReferenceMediaUrl({ blob, originalUrl: "https://media.test/ref.mp4" }, () => "blob:local")).toEqual({
      url: "blob:local",
      revoke: true,
    });
    expect(resolveReferenceMediaUrl({ originalUrl: "https://media.test/ref.mp4" })).toEqual({
      url: "https://media.test/ref.mp4",
      revoke: false,
    });
    expect(resolveReferenceMediaUrl(undefined)).toEqual({ url: null, revoke: false });
  });
});
