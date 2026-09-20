import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Project } from "@reelterminal/core";
import {
  DEFAULT_BACKGROUND_SETTINGS,
  disposeBackgroundRemovalEngine,
  getBackgroundRemovalEngine,
  initializeBackgroundRemovalEngine,
} from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { BackgroundRemovalSection } from "./BackgroundRemovalSection";

const targetClipId = "clip-person";

const DEGRADED_HINT =
  "Non-AI fallback mask: the segmentation model could not be loaded, so a non-AI luminance mask is used (not AI matting).";

const createProjectWithPersistedMatte = (): Project => {
  const project = createEmptyProject("Matte Persistence");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: [
        {
          id: "track-video",
          type: "video",
          name: "V1",
          clips: [
            {
              id: targetClipId,
              mediaId: "media-person",
              trackId: "track-video",
              startTime: 0,
              duration: 5,
              inPoint: 0,
              outPoint: 5,
              effects: [],
              audioEffects: [],
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                anchor: { x: 0.5, y: 0.5 },
                opacity: 1,
              },
              volume: 1,
              keyframes: [],
              backgroundRemoval: {
                ...DEFAULT_BACKGROUND_SETTINGS,
                enabled: true,
              },
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  } as unknown as Project;
};

describe("BackgroundRemovalSection", () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: createProjectWithPersistedMatte(),
    });
  });

  afterEach(() => {
    cleanup();
    disposeBackgroundRemovalEngine();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
  });

  it("mount does not initialize the engine (model download stays GUI-first-use)", () => {
    expect(getBackgroundRemovalEngine()).toBeNull();
    render(<BackgroundRemovalSection clipId={targetClipId} />);
    // The section reads settings from the persisted field but must NOT
    // construct or initialize the engine as a side effect of mounting.
    expect(getBackgroundRemovalEngine()).toBeNull();
    expect(
      useProjectStore
        .getState()
        .project.timeline.tracks.flatMap((track) => track.clips)
        .find((candidate) => candidate.id === targetClipId)?.backgroundRemoval,
    ).toMatchObject({ enabled: true });
  });

  it("discloses the non-AI degraded mask when the engine fell back", () => {
    // Simulate an engine whose segmentation model failed to load (the flag
    // initialize() sets when the model download/load throws).
    const engine = initializeBackgroundRemovalEngine();
    (
      engine as unknown as { aiDegraded: boolean }
    ).aiDegraded = true;

    render(<BackgroundRemovalSection clipId={targetClipId} />);
    expect(screen.getByText(DEGRADED_HINT)).toBeInTheDocument();
  });

  it("toggle-off persists through the undoable core action and undo restores", () => {
    render(<BackgroundRemovalSection clipId={targetClipId} />);
    expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "On" }));

    const clip = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === targetClipId);
    // The disable was an action writing the persisted field (tuning kept)…
    expect(clip?.backgroundRemoval).toMatchObject({ enabled: false });
    expect(clip?.backgroundRemoval?.threshold).toBe(
      DEFAULT_BACKGROUND_SETTINGS.threshold,
    );
    // …so undo restores the enabled matte bit-for-bit.
    useProjectStore.getState().undo();
    const restored = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === targetClipId);
    expect(restored?.backgroundRemoval).toMatchObject({ enabled: true });
  });
});
