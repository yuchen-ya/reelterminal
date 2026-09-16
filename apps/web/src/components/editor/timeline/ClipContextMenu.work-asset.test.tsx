import "../../../test/install-local-storage-mock";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, MediaItem, Project, Track } from "@openreel/core";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@openreel/ui";
import { useNotificationStore } from "../../../stores/notification-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useClipContextMenuItems } from "./ClipContextMenu";

const TRACK_ID = "video-track";

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

function mediaClip(
  id: string,
  mediaId: string,
  extras: Partial<Clip> = {},
): Clip {
  return {
    id,
    mediaId,
    trackId: TRACK_ID,
    startTime: 0,
    duration: 2,
    inPoint: 0.5,
    outPoint: 2.5,
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
    ...extras,
  };
}

function testProject(clip: Clip, items: MediaItem[]): Project {
  const empty = createEmptyProject("Work asset capture");
  return {
    ...empty,
    mediaLibrary: { ...empty.mediaLibrary, items },
    timeline: {
      ...empty.timeline,
      tracks: [
        {
          id: TRACK_ID,
          type: "video",
          name: "Video",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
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

describe("clip context menu work-asset capture", () => {
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

  it("captures a plain clip without any confirmation prompt", async () => {
    const clip = mediaClip("clip-a", "media-a");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    useProjectStore.setState({
      hasOpenProject: true,
      project: testProject(clip, [mediaItem("media-a", "take-one.mp4")]),
    });

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip, track }),
    );

    const option = menuOption(result.current, "Save to Work Assets");
    expect(option.isDisabled).toBeFalsy();

    await act(async () => option.onClick?.());

    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    expect(workAssets[0]).toMatchObject({
      kind: "single",
      sourceMediaId: "media-a",
      sourceRange: { inSec: 0.5, outSec: 2.5 },
      createdBy: "user",
      unsupportedParams: [],
    });
    // Derived default name from the source media plus the trimmed range.
    expect(workAssets[0]?.name).toBe("take-one.mp4 (0.5s-2.5s)");
    expect(confirmSpy).not.toHaveBeenCalled();

    const successes = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "success");
    expect(successes.some((n) => n.title === "Saved to work assets")).toBe(
      true,
    );
  });

  it("lists unsupported parameters and only captures after confirmation", async () => {
    const clip = mediaClip("clip-b", "media-a", {
      stabilization: {
        enabled: true,
        strength: 0.5,
        cropMode: "auto",
        analyzed: true,
        analysisVersion: 2,
        profile: {
          clipId: "clip-b",
          samples: [],
          corrections: [],
          maxDisplacement: 1,
          frameInterval: 1,
          duration: 2,
          sourceStartTime: 0,
          analysisDimensions: { width: 320, height: 180 },
        },
      },
      metadata: { templateManaged: true },
    });
    useProjectStore.setState({
      hasOpenProject: true,
      project: testProject(clip, [mediaItem("media-a", "take-one.mp4")]),
    });

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result, rerender } = renderHook(() =>
      useClipContextMenuItems({ clip, track }),
    );

    // Declining the confirmation must leave the project untouched.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () =>
      menuOption(result.current, "Save to Work Assets").onClick?.(),
    );
    expect(
      (useProjectStore.getState().project.workAssets ?? []).length,
    ).toBe(0);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = confirmSpy.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("stabilization.profile");
    expect(prompt).toContain("metadata");

    // Confirming captures the entry with the unsupported list recorded.
    confirmSpy.mockReturnValue(true);
    rerender();
    await act(async () =>
      menuOption(result.current, "Save to Work Assets").onClick?.(),
    );
    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    const fields = workAssets[0]?.unsupportedParams.map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "stabilization.analyzed",
        "stabilization.analysisVersion",
        "stabilization.profile",
        "metadata",
      ]),
    );
    // The stripped analysis artifacts must not sneak into the snapshot.
    expect(workAssets[0]?.clipSnapshot?.stabilization).toEqual({
      enabled: true,
      strength: 0.5,
      cropMode: "auto",
    });
  });

  it("disables capture for engine-generated overlay clips", () => {
    const clip = mediaClip("clip-c", "text-123");
    useProjectStore.setState({
      hasOpenProject: true,
      project: testProject(clip, []),
    });

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip, track }),
    );

    const option = menuOption(result.current, "Save to Work Assets");
    expect(option.isDisabled).toBe(true);
    expect(option.description).toBe(
      "Only clips backed by project media can be captured",
    );
  });
});
