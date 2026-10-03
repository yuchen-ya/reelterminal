import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MultiCamEngine, type Action, type Project } from "@reelterminal/core";
import { useEngineStore } from "../../../stores/engine-store";
import { useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { MultiCameraPanel } from "./MultiCameraPanel";

// Clip ids are deliberately <= 6 chars so the panel's `clip.id.slice(-6)`
// display-name logic yields predictable labels ("Clip camaa1" etc.).
function clip(id: string, trackId: string, mediaId: string) {
  return {
    id,
    mediaId,
    trackId,
    startTime: 1,
    duration: 4,
    inPoint: 0,
    outPoint: 4,
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    effects: [],
    audioEffects: [],
    volume: 1,
    keyframes: [],
  };
}

function projectWithTwoVideoTracks(): Project {
  const project = createEmptyProject("Multi-cam workflow");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 8,
      tracks: [
        {
          id: "track-cam-a",
          type: "video",
          name: "Cam A",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [clip("camaa1", "track-cam-a", "media-a")],
        },
        {
          id: "track-cam-b",
          type: "video",
          name: "Cam B",
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
          transitions: [],
          clips: [clip("cambb2", "track-cam-b", "media-b")],
        },
      ],
    },
  };
}

describe("MultiCameraPanel workflow", () => {
  const engine = new MultiCamEngine();
  const originalGetMultiCamEngine =
    useEngineStore.getState().getMultiCamEngine;
  let actions: Action[] = [];

  beforeEach(() => {
    engine.clearAll();
    actions = [];
    useEngineStore.setState({ getMultiCamEngine: async () => engine });
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWithTwoVideoTracks(),
      executeAction: vi.fn(async (action: Action) => {
        actions.push(action);
        // Mirror the real store: applied actions bump project.modifiedAt,
        // which is what makes the panel's groups memo recompute and the
        // created group section render.
        if (action.type === "multicam/setAll") {
          useProjectStore.setState((state) => ({
            project: { ...state.project, modifiedAt: Date.now() },
          }));
        }
        return { success: true };
      }),
    });
  });

  afterEach(() => {
    cleanup();
    useEngineStore.setState({ getMultiCamEngine: originalGetMultiCamEngine });
    useProjectStore.setState({ hasOpenProject: false });
  });

  // One click selects the clip and enables Create Group.
  it("toggles a clip exactly once per click", async () => {
    render(<MultiCameraPanel />);

    const rowA = await screen.findByRole("checkbox", {
      name: "Clip camaa1 Cam A",
    });
    fireEvent.click(rowA);

    expect(
      screen.getByRole("button", { name: "Create Group (1 selected)" }),
    ).toBeInTheDocument();

    fireEvent.click(rowA);

    expect(
      screen.getByRole("button", { name: "Create Group (0 selected)" }),
    ).toBeInTheDocument();
  });

  it("enables Create Group at 2 selected, creates a group and clears the selection", async () => {
    render(<MultiCameraPanel />);

    const rowA = await screen.findByRole("checkbox", {
      name: "Clip camaa1 Cam A",
    });
    const rowB = screen.getByRole("checkbox", { name: "Clip cambb2 Cam B" });

    fireEvent.click(rowA);
    fireEvent.click(rowB);

    const createButton = screen.getByRole("button", {
      name: "Create Group (2 selected)",
    });
    expect(createButton).not.toBeDisabled();

    fireEvent.click(createButton);

    await waitFor(() => {
      expect(engine.getAllGroups()).toHaveLength(1);
    });
    expect(actions.some((action) => action.type === "multicam/setAll")).toBe(
      true,
    );
    expect(
      engine.getAllGroups()[0]?.angles.map((angle) => angle.clipId),
    ).toEqual(["camaa1", "cambb2"]);

    // Selection resets after creation.
    expect(
      screen.getByRole("button", { name: "Create Group (0 selected)" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Multi-Cam 1" }),
    ).toBeInTheDocument();
  });
});
