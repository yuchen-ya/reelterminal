import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { AudioDuckingSection } from "./AudioDuckingSection";

const targetClipId = "clip-music";
const triggerTrackId = "track-dialogue";

const createProjectWithPersistedDucking = (): Project => {
  const project = createEmptyProject("Audio Ducking Persistence");

  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 8,
      tracks: [
        {
          id: "track-music",
          type: "audio",
          name: "Music Bed",
          clips: [
            {
              id: targetClipId,
              mediaId: "media-music",
              trackId: "track-music",
              startTime: 0,
              duration: 8,
              inPoint: 0,
              outPoint: 8,
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
              automation: {
                volume: [
                  { time: 0, value: 1 },
                  { time: 0.25, value: 0.3 },
                  { time: 1.2, value: 1 },
                ],
              },
              keyframes: [],
              metadata: {
                audioDucking: {
                  enabled: true,
                  sourceTrackId: triggerTrackId,
                  threshold: -28,
                  reduction: 0.7,
                  attack: 0.08,
                  release: 0.4,
                  holdTime: 0.2,
                },
              },
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
        {
          id: triggerTrackId,
          type: "video",
          name: "Dialogue Track",
          clips: [
            {
              id: "clip-dialogue",
              mediaId: "media-dialogue",
              trackId: triggerTrackId,
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
  };
};

describe("AudioDuckingSection", () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: createProjectWithPersistedDucking(),
    });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
  });

  it("rehydrates persisted ducking and shows video tracks as valid trigger sources", () => {
    render(<AudioDuckingSection clipId={targetClipId} />);

    expect(screen.getByText("Ducking Applied")).toBeInTheDocument();
    expect(screen.getByText("Ducking Enabled")).toBeInTheDocument();
    expect(screen.getByText("Dialogue Track")).toBeInTheDocument();
    expect(screen.getByText("Trigger Source (Voice Track)")).toBeInTheDocument();
  });

  it("remove goes through the undoable core action and undo restores the readback state", async () => {
    render(<AudioDuckingSection clipId={targetClipId} />);
    expect(screen.getByText("Ducking Applied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(screen.queryByText("Ducking Applied")).not.toBeInTheDocument();
    });

    const clip = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === targetClipId);
    expect(clip?.metadata?.audioDucking).toBeUndefined();
    expect(clip?.automation?.volume ?? []).toHaveLength(0);

    // The removal was an action, not a raw write: undo brings the panel
    // readback (metadata snapshot + non-empty volume points) back.
    await useProjectStore.getState().undo();
    const restored = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((track) => track.clips)
      .find((candidate) => candidate.id === targetClipId);
    expect(restored?.metadata?.audioDucking).toMatchObject({ enabled: true });
    expect((restored?.automation?.volume?.length ?? 0) > 0).toBe(true);
    await waitFor(() => {
      expect(screen.getByText("Ducking Applied")).toBeInTheDocument();
    });
  });
});