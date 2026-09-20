import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useEngineStore } from "../../../stores/engine-store";
import { GreenScreenSection } from "./GreenScreenSection";

// The green-screen panel must persist every change through the
// clip/setChromaKey action so the keyer is undoable AND rendered: that action
// writes both the clip.chromaKey settings field and the chromaKey effect item
// in clip.effects that the frame pipeline consumes.

const clipId = "clip-green";
const trackId = "track-video";

const createProjectWithClip = (
  id = clipId,
  chromaKey?: Project["timeline"]["tracks"][number]["clips"][number]["chromaKey"],
): Project => {
  const project = createEmptyProject("Green Screen Persistence");
  return {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 5,
      tracks: [
        {
          id: trackId,
          type: "video",
          name: "Primary",
          clips: [
            {
              id,
              mediaId: "media-1",
              trackId,
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
              ...(chromaKey ? { chromaKey } : {}),
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

const clipOf = (project: Project) =>
  project.timeline.tracks[0]!.clips[0]! as unknown as {
    chromaKey?: { enabled: boolean; tolerance: number };
    effects: Array<{
      id: string;
      type: string;
      enabled: boolean;
      params: Record<string, unknown>;
    }>;
  };

describe("GreenScreenSection persistence", () => {
  beforeEach(async () => {
    // The engine is a module-cached singleton; keep tests independent.
    const engine = await useEngineStore.getState().getChromaKeyEngine();
    engine.disableChromaKey(clipId);
    // Deterministic undo granularity: the GUI coalesces rapid slider/toggle
    // batches (AUTO_GROUPABLE proximity window); widen it so the coalesced
    // two-step assertions below do not depend on test execution speed.
    useProjectStore
      .getState()
      .actionExecutor.getHistory()
      .setAutoGroupWindow(60_000);
    useProjectStore.setState({ project: createProjectWithClip() });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
  });

  it("enabling persists both the settings field and the render-side chromaKey effect item", async () => {
    render(<GreenScreenSection clipId={clipId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable Green Screen" }),
    );

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        true,
      );
    });

    const clip = clipOf(useProjectStore.getState().project);
    const items = clip.effects.filter((e) => e.type === "chromaKey");
    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(true);
    expect(items[0]!.params).toMatchObject({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: 0.3,
      edgeSoftness: 0.1,
      spillSuppression: 0.5,
    });
  });

  it("disabling keeps the item with its params; undo reverts the coalesced run", async () => {
    render(<GreenScreenSection clipId={clipId} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Enable Green Screen" }),
    );
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        true,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Disable chroma key" }));
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).chromaKey?.enabled).toBe(
        false,
      );
    });

    // Panel-toggle semantics: the render item stays (disabled), params intact.
    const clip = clipOf(useProjectStore.getState().project);
    const items = clip.effects.filter((e) => e.type === "chromaKey");
    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(false);
    expect(items[0]!.params).toMatchObject({ tolerance: 0.3 });

    // The enable+disable runs coalesce into ONE undo unit (AUTO_GROUPABLE
    // proximity, restored for the batched commit path): undo reverts both.
    await useProjectStore.getState().undo();
    const undone = clipOf(useProjectStore.getState().project);
    expect(undone.chromaKey).toBeUndefined();
    expect(
      undone.effects.filter((e) => e.type === "chromaKey"),
    ).toHaveLength(0);
  });

  it("a reopened project seeds the panel from the persisted field (no default reset)", async () => {
    const reopenClipId = "clip-reopen";
    // Simulate a reopened project: the persisted keyer runs with saved
    // tuning while the (loadProject-unseeded) engine Map holds nothing.
    await act(async () => {
      useProjectStore.setState({
        project: createProjectWithClip(reopenClipId, {
          enabled: true,
          keyColor: { r: 0, g: 1, b: 0 },
          tolerance: 0.42,
          edgeSoftness: 0.2,
          spillSuppression: 0.6,
        }),
      });
    });
    render(<GreenScreenSection clipId={reopenClipId} />);

    // Field-first display shows the saved tuning, not engine defaults.
    expect(await screen.findByText("42%")).toBeInTheDocument();

    // Flushing the load microtask seeds the engine from the field, so the
    // next toggle carries the persisted tuning instead of defaults.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Disable chroma key" }));

    await waitFor(() => {
      expect(
        clipOf(useProjectStore.getState().project).chromaKey?.enabled,
      ).toBe(false);
    });
    const clip = clipOf(useProjectStore.getState().project);
    expect(clip.chromaKey?.tolerance).toBe(0.42);
    const items = clip.effects.filter((e) => e.type === "chromaKey");
    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(false);
    expect(items[0]!.params).toMatchObject({ tolerance: 0.42, spillSuppression: 0.6 });
  });
});
