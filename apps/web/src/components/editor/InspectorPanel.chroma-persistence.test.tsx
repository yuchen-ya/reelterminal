import "../../test/install-local-storage-mock";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";

/**
 * Every chroma entry point in InspectorPanel — the Effects-tab toggle and the
 * AI-tab "Remove Background" quick action — must persist through the
 * clip/setChromaKey action (one undoable write of the clip.chromaKey settings
 * field AND the chromaKey effect item in clip.effects that the frame pipeline
 * renders), instead of only mutating the in-memory engine Map.
 */

vi.mock("./inspector/AutoCaptionPanel", () => ({
  AutoCaptionPanel: () => null,
}));

import { InspectorPanel } from "./InspectorPanel";

const clipId = "clip-vid";
const trackId = "track-vid";

function seedVideoClip(): Project {
  const project = createEmptyProject("Inspector Chroma Persistence Test");
  const seeded: Project = {
    ...project,
    mediaLibrary: {
      ...project.mediaLibrary,
      items: [
        {
          id: "media-vid",
          name: "Clip Media",
        } as unknown as Project["mediaLibrary"]["items"][number],
      ],
    },
    timeline: {
      ...project.timeline,
      duration: 10,
      tracks: [
        {
          id: trackId,
          type: "video",
          name: "Track",
          clips: [
            {
              id: clipId,
              mediaId: "media-vid",
              trackId,
              startTime: 0,
              duration: 10,
              inPoint: 0,
              outPoint: 10,
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
  useProjectStore.setState({ project: seeded });
  useUIStore.getState().select({ type: "clip", id: clipId, trackId });
  return seeded;
}

const clipOf = (project: Project) =>
  project.timeline.tracks[0]!.clips[0]! as unknown as {
    chromaKey?: { enabled: boolean; tolerance: number };
    effects: Array<{
      type: string;
      enabled: boolean;
      params: Record<string, unknown>;
    }>;
  };

const chromaItemsOf = (project: Project) =>
  clipOf(project).effects.filter((e) => e.type === "chromaKey");

beforeEach(() => {
  // Deterministic undo granularity: the GUI coalesces rapid same-target
  // keyer batches (AUTO_GROUPABLE proximity window).
  useProjectStore
    .getState()
    .actionExecutor.getHistory()
    .setAutoGroupWindow(60_000);
});

afterEach(() => {
  cleanup();
  useUIStore.getState().clearSelection();
  useProjectStore.setState({ project: createEmptyProject("Reset") });
  vi.clearAllMocks();
});

describe("InspectorPanel chroma persistence", () => {
  it("the Effects-tab toggle persists field + render item; undo reverts the coalesced run", async () => {
    seedVideoClip();
    const { container } = render(<InspectorPanel />);

    // Sections render collapsed; expand "Chroma Key (Green Screen)" first.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand Chroma Key (Green Screen) section",
      }),
    );

    const toggle = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>(
        '[aria-label="Enable chroma key"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        true,
      );
    });

    const items = chromaItemsOf(useProjectStore.getState().project);
    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(true);
    expect(items[0]!.params).toMatchObject({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.3,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    });

    // Toggling off keeps the item with its params (panel toggle semantics).
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        false,
      );
    });
    const offItems = chromaItemsOf(useProjectStore.getState().project);
    expect(offItems).toHaveLength(1);
    expect(offItems[0]!.enabled).toBe(false);

    // The on+off toggles coalesce into ONE undo unit (AUTO_GROUPABLE
    // proximity, restored for the batched commit path): undo reverts both.
    await useProjectStore.getState().undo();
    const undone = clipOf(useProjectStore.getState().project);
    expect(undone.chromaKey).toBeUndefined();
    expect(
      undone.effects.filter((e) => e.type === "chromaKey"),
    ).toHaveLength(0);
  });

  it("the AI quick Remove Background action persists with the quick tolerance", async () => {
    seedVideoClip();
    render(<InspectorPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Background" }));

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        true,
      );
    });

    const clip = clipOf(useProjectStore.getState().project);
    // The quick action keeps its signature tuning: fixed green key, 0.35.
    expect(clip.chromaKey?.tolerance).toBe(0.35);
    const items = chromaItemsOf(useProjectStore.getState().project);
    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(true);
    expect(items[0]!.params).toMatchObject({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.35,
    });
  });
});
