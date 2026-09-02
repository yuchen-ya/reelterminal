import "../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEngineStore } from "../../stores/engine-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { AssetsPanel } from "./AssetsPanel";

describe("AssetsPanel graphics workflow", () => {
  beforeEach(() => {
    useEngineStore.getState().getGraphicsEngine()?.clearCache();
    useProjectStore.setState({
      hasOpenProject: true,
      project: createEmptyProject("Graphics workflow"),
    });
    useTimelineStore.setState({ playheadPosition: 2.25 });
    useUIStore.getState().clearSelection();
  });

  afterEach(() => {
    cleanup();
    useEngineStore.getState().getGraphicsEngine()?.clearCache();
    useUIStore.getState().clearSelection();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("places a new shape at the playhead and opens it in the inspector", async () => {
    render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Graphics" }));

    expect(
      screen.getByRole("button", { name: "Import & Add Sticker" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));

    await waitFor(() => {
      const shapes =
        useEngineStore.getState().getGraphicsEngine()?.getAllShapeClips() ?? [];
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toMatchObject({
        shapeType: "rectangle",
        startTime: 2.25,
      });
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([shapes[0]?.id]);
    });
  });

  it("keeps a live-revealed media target keyboard-focusable", () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [
            {
              id: "media-focus",
              name: "focus.mp4",
              type: "video",
              fileHandle: null,
              blob: null,
              metadata: {
                duration: 1,
                width: 320,
                height: 180,
                frameRate: 30,
                codec: "h264",
                sampleRate: 0,
                channels: 0,
                fileSize: 1,
              },
              thumbnailUrl: null,
              waveformData: null,
            },
          ],
        },
      },
    });

    const { container } = render(<AssetsPanel />);
    const target = container.querySelector<HTMLElement>(
      '[data-live-media-id="media-focus"]',
    );
    expect(target).not.toBeNull();
    expect(target?.tabIndex).toBe(0);
  });
});
