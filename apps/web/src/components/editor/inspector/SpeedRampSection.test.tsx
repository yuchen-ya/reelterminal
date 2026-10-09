import "../../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getSpeedEngine, ProjectSerializer, SPEED_CURVE_PRESETS, type Clip, type Project } from "@reelterminal/core";
import type { IStorageEngine } from "@reelterminal/core/storage/types";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { SpeedRampSection } from "./SpeedRampSection";
import { SpeedSection } from "./SpeedSection";

const clipOf = () => useProjectStore.getState().project.timeline.tracks[0].clips[0];

function seed(): Clip {
  const clip: Clip = {
    id: "speed-clip", mediaId: "media", trackId: "video", startTime: 3,
    duration: 10, inPoint: 5, outPoint: 15,
    speed: 1, reversed: false, pitchCorrection: true,
    effects: [], audioEffects: [], keyframes: [], volume: 1,
    transform: {
      position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
      anchor: { x: 0.5, y: 0.5 }, opacity: 1,
    },
  };
  const project: Project = {
    ...createEmptyProject("Speed regression"),
    timeline: {
      duration: 13, markers: [], subtitles: [],
      tracks: [{ id: "video", name: "Video", type: "video", clips: [clip],
        transitions: [], locked: false, hidden: false, muted: false, solo: false }],
    },
  };
  useProjectStore.getState().loadProject(project);
  return clip;
}

beforeEach(() => useProjectStore.getState().createNewProject());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("canonical inspector speed edits", () => {
  it("commits speed/reverse/pitch/freeze/reset, and restores preview mapping on undo, redo and load", async () => {
    render(<SpeedRampSection clip={seed()} />);
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    expect(clipOf()).toMatchObject({ speed: 2, duration: 5 });
    expect(getSpeedEngine().getSourceTimeAtPlaybackTime("speed-clip", 1)).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
    fireEvent.click(screen.getByRole("button", { name: "Pitch Correct" }));
    expect(clipOf()).toMatchObject({ reversed: true, pitchCorrection: false });
    act(() => useTimelineStore.setState({ playheadPosition: 4 }));
    fireEvent.click(screen.getByRole("button", { name: "Freeze Frames" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Freeze Frame at Playhead" }));
    expect(clipOf().freezeFrames?.[0]).toMatchObject({ sourceTime: 8, startTime: 1, duration: 2 });
    expect(clipOf().duration).toBe(7);
    expect(useProjectStore.getState().project.timeline.duration).toBe(10);
    const saved = structuredClone(clipOf());
    const serializer = new ProjectSerializer({} as IStorageEngine);
    const json = serializer.exportToJson(useProjectStore.getState().project);
    fireEvent.click(screen.getByRole("button", { name: "Reset Speed & Effects" }));
    expect(clipOf()).toMatchObject({ speed: 1, reversed: false, duration: 10, freezeFrames: [] });
    await act(async () => { expect((await useProjectStore.getState().undo()).success).toBe(true); });
    expect(clipOf()).toEqual(saved);
    expect(getSpeedEngine().getSourceTimeAtPlaybackTime("speed-clip", 2)).toBe(8);
    await act(async () => { expect((await useProjectStore.getState().redo()).success).toBe(true); });
    expect(getSpeedEngine().getSourceTimeAtPlaybackTime("speed-clip", 2)).toBe(2);
    act(() => useProjectStore.getState().loadProject(serializer.importFromJson(json)));
    expect(clipOf()).toEqual(saved);
    expect(getSpeedEngine().getEffectiveDuration("speed-clip")).toBe(7);
    expect(getSpeedEngine().getSourceTimeAtPlaybackTime("speed-clip", 2)).toBe(8);
    expect(screen.getByText(/Effective duration:/)).toHaveTextContent("0:07.00");
  });

  it("removes a freeze and shifts subsequent holds within the clip without moving other clips", () => {
    const clip = seed();
    const project = useProjectStore.getState().project;
    useProjectStore.setState({ project: {
      ...project, timeline: { ...project.timeline, tracks: [{
        ...project.timeline.tracks[0],
        clips: [clip, { ...clip, id: "next", startTime: 13, duration: 1, outPoint: 6 }],
      }] },
    } });
    useProjectStore.getState().executeActionBatch([{
      type: "speed/setRampData", id: "holds", timestamp: 0, params: {
        clipId: clip.id, speed: 2,
        freezeFrames: [
          { id: "a", clipId: clip.id, sourceTime: 2, startTime: 1, duration: 2 },
          { id: "b", clipId: clip.id, sourceTime: 6, startTime: 5, duration: 1 },
        ],
      },
    }], { groupLabel: "Seed freezes", historyOwner: "human" });
    render(<SpeedRampSection clip={clipOf()} />);
    fireEvent.click(screen.getByRole("button", { name: /Freeze Frames/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove freeze frame" })[0]);
    expect(clipOf().freezeFrames).toEqual([{ id: "b", clipId: clip.id, sourceTime: 6, startTime: 3, duration: 1 }]);
    expect(clipOf()).toMatchObject({ startTime: 3, duration: 6 });
    expect(getSpeedEngine().getSourceTimeAtPlaybackTime(clip.id, 3.5)).toBe(6);
    expect(useProjectStore.getState().project.timeline.tracks[0].clips[1].startTime).toBe(13);
    expect(useProjectStore.getState().project.timeline.duration).toBe(14);
  });

  it("uses the source span for a curve preset after a prior speed edit", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const clip = seed();
    render(<SpeedRampSection clip={clip} />);
    fireEvent.click(screen.getByRole("button", { name: "2x" }));
    const preset = SPEED_CURVE_PRESETS[0];
    fireEvent.click(screen.getByRole("button", { name: preset.name }));
    expect(clipOf().speedKeyframes?.map((kf) => kf.time)).toEqual(preset.keyframes.map((kf) => kf.time * 10));
    expect(clipOf().duration).toBeCloseTo(getSpeedEngine().getEffectiveDuration(clip.id));
  });

  it("repairs a saved legacy freeze duration on load", () => {
    const clip = seed();
    const project = useProjectStore.getState().project;
    useProjectStore.getState().loadProject({
      ...project, timeline: { ...project.timeline, tracks: [{
        ...project.timeline.tracks[0], clips: [{
          ...clip, speed: 2, duration: 10,
          freezeFrames: [{ id: "f", clipId: clip.id, sourceTime: 2, startTime: 1, duration: 2 }],
        }],
      }] },
    });
    expect(clipOf().duration).toBe(7);
    expect(useProjectStore.getState().project.timeline.duration).toBe(10);
    expect(getSpeedEngine().getEffectiveDuration(clip.id)).toBe(7);
  });

  it("the basic speed panel observes canonical updates including undo", async () => {
    render(<SpeedSection clip={seed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set speed to 2×" }));
    expect(clipOf()).toMatchObject({ speed: 2, duration: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Reverse Clip" }));
    expect(screen.getByRole("button", { name: "Reversed" })).toBeInTheDocument();
    await act(async () => { await useProjectStore.getState().undo(); });
    expect(clipOf().reversed).toBe(false);
    expect(screen.getByRole("button", { name: "Reverse Clip" })).toBeInTheDocument();
  });
});
