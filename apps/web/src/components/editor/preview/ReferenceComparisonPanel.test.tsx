// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const fixture = vi.hoisted(() => ({
  project: { settings: { frameRate: 30 }, mediaLibrary: { items: [] as unknown[] }, referenceComparison: {
    referenceMediaId: "ref", refStartSec: 1, refEndSec: 3, timelineStartSec: 2,
    rate: 1, audioSide: "reference", layout: "overlay", overlayOpacity: 0.35,
  } },
  timeline: { playheadPosition: 2.5, playbackState: "paused", togglePlayback: vi.fn(), seekRelative: vi.fn(), seekToStart: vi.fn() },
  executeAction: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("../../../stores/project-store", () => ({ useProjectStore: (selector: (s: unknown) => unknown) => selector(fixture) }));
vi.mock("../../../stores/timeline-store", () => ({ useTimelineStore: Object.assign((selector: (s: unknown) => unknown) => selector(fixture.timeline), { getState: () => fixture.timeline }) }));
import { ReferenceComparisonPanel } from "./ReferenceComparisonPanel";

describe("reference comparison interaction", () => {
  beforeEach(() => {
    fixture.timeline.playheadPosition = 2.5;
    fixture.timeline.playbackState = "paused";
    fixture.project.referenceComparison.layout = "overlay";
    fixture.project.referenceComparison.audioSide = "reference";
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("renders both real surfaces, applies overlay opacity and persists layout edits", () => {
    render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    const video = screen.getByLabelText("Comparison reference video");
    expect(screen.getByLabelText("Comparison timeline frame").tagName).toBe("CANVAS");
    expect(video.style.opacity).toBe("0.35");
    fireEvent.click(screen.getByText("L | R"));
    expect(fixture.executeAction).toHaveBeenCalledWith(expect.objectContaining({ params: { config: expect.objectContaining({ layout: "side-by-side" }) } }));
  });
  it("seeks after metadata, follows seeks while playing and holds/mutes beyond reference out", () => {
    const ref = { current: null };
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={ref} />);
    const video = screen.getByLabelText<HTMLVideoElement>("Comparison reference video");
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(1.5);
    fixture.timeline.playbackState = "playing";
    fixture.timeline.playheadPosition = 3.5;
    rerender(<ReferenceComparisonPanel timelineCanvasRef={ref} />);
    expect(video.currentTime).toBe(2.5);
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
    fixture.timeline.playheadPosition = 6;
    rerender(<ReferenceComparisonPanel timelineCanvasRef={ref} />);
    expect(video.currentTime).toBeCloseTo(3, 3);
    expect(video.muted).toBe(true);
    expect(video.pause).toHaveBeenCalled();
    expect(screen.getByText(/clamped after/)).toBeTruthy();
  });
  it("honors the user mute even when reference audio is selected", () => {
    fixture.timeline.playbackState = "playing";
    render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} userMuted />);
    const video = screen.getByLabelText<HTMLVideoElement>("Comparison reference video");
    Object.defineProperty(video, "duration", { value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.muted).toBe(true);
  });
});
