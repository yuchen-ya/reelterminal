import "../../test/install-local-storage-mock";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, Project } from "@reelterminal/core";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
import { useNotificationStore } from "../../stores/notification-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { AssetsPanel, useMediaContextMenuItems } from "./AssetsPanel";

function mediaItem(id: string, name: string): MediaItem {
  return {
    id,
    name,
    type: "video",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 10,
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
  };
}

function testProject(items: MediaItem[]): Project {
  const empty = createEmptyProject("Media work asset capture");
  return {
    ...empty,
    mediaLibrary: { ...empty.mediaLibrary, items },
  };
}

type MenuActionOption = Extract<
  ContextMenuOption,
  { onClick?: () => void }
>;

function menuOption(items: ContextMenuOption[], label: string): MenuActionOption {
  const found = items.find(
    (candidate) => "label" in candidate && candidate.label === label,
  );
  if (!found) throw new Error(`Missing menu option: ${label}`);
  return found as MenuActionOption;
}

describe("media context menu work-asset capture", () => {
  beforeEach(() => {
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUIStore.getState().clearSelection();
    useNotificationStore.getState().clearAll();
    useProjectStore.setState({
      hasOpenProject: false,
      project: createEmptyProject("Reset"),
    });
  });

  it("saves a media item as a work asset with default parameters — no timeline needed", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: testProject([mediaItem("media-a", "take-one.mp4")]),
    });
    const item = useProjectStore.getState().project.mediaLibrary.items[0];
    const { result } = renderHook(() =>
      useMediaContextMenuItems({ item, startRename: () => {} }),
    );

    const option = menuOption(result.current, "Save to Work Assets");
    await act(async () => option.onClick?.());

    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    expect(workAssets[0]).toMatchObject({
      kind: "single",
      sourceMediaId: "media-a",
      sourceRange: { inSec: 0, outSec: 10 },
      createdBy: "user",
      unsupportedParams: [],
    });
    // Derived default name from the source media plus the captured range.
    expect(workAssets[0]?.name).toBe("take-one.mp4 (0s-10s)");
    expect(workAssets[0]?.clipSnapshot).toMatchObject({
      duration: 10,
      inPoint: 0,
      outPoint: 10,
      volume: 1,
    });
    expect(workAssets[0]?.clipSnapshot?.effects).toEqual([]);
    expect(workAssets[0]?.clipSnapshot?.keyframes).toEqual([]);

    const successes = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "success");
    expect(successes.some((n) => n.title === "Saved to work assets")).toBe(true);
  });
  it("saves a named timeline selection into the unified project assets panel", async () => {
    useProjectStore.setState({ hasOpenProject: true, project: testProject([mediaItem("media-a", "take-one.mp4")]) });
    await useProjectStore.getState().addClipToNewTrack("media-a");
    const track = useProjectStore.getState().project.timeline.tracks.find((item) => item.clips.length > 0)!;
    useUIStore.getState().select({ type: "clip", id: track.clips[0].id, trackId: track.id });
    render(<AssetsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Save timeline selection" }));
    fireEvent.change(screen.getByPlaceholderText("Name this clip or combination"), { target: { value: "Opening edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useProjectStore.getState().project.workAssets?.[0].name).toBe("Opening edit"));
    expect(screen.getByText("Opening edit")).toBeInTheDocument();
    expect(useProjectStore.getState().project.mediaLibrary.items).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Work Assets" })).not.toBeInTheDocument();
  });

});
