import "../../../test/install-local-storage-mock";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, MediaItem, Project, Track } from "@reelterminal/core";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
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

describe("clip context menu multi-clip work-asset capture", () => {
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

  function twoClipProject(first: Clip, second: Clip): Project {
    const empty = createEmptyProject("Multi capture");
    return {
      ...empty,
      mediaLibrary: {
        ...empty.mediaLibrary,
        items: [mediaItem("media-a", "take-one.mp4")],
      },
      timeline: {
        ...empty.timeline,
        tracks: [
          {
            id: TRACK_ID,
            type: "video",
            name: "Video",
            clips: [first],
            transitions: [],
            locked: false,
            hidden: false,
            muted: false,
            solo: false,
          },
          {
            id: "video-track-2",
            type: "video",
            name: "Video 2",
            clips: [second],
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

  function selectClips(ids: string[]) {
    useUIStore.setState({
      selectedItems: ids.map((id) => ({ id, type: "clip" as const })),
    });
  }

  it("offers the multi form for a selection and captures ONE multi asset", async () => {
    const first = mediaClip("clip-a", "media-a", { startTime: 0 });
    const second = mediaClip("clip-b", "media-a", {
      startTime: 1,
      trackId: "video-track-2",
    });
    useProjectStore.setState({
      hasOpenProject: true,
      project: twoClipProject(first, second),
    });
    selectClips(["clip-a", "clip-b"]);

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip: first, track }),
    );

    const option = menuOption(
      result.current,
      "Save 2 Selected Clips as Work Asset",
    );
    expect(option.isDisabled).toBeFalsy();

    await act(async () => option.onClick?.());

    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    const asset = workAssets[0];
    expect(asset).toMatchObject({
      kind: "multi",
      createdBy: "user",
      sourceMediaId: "media-a",
    });
    expect(asset.members).toHaveLength(2);
    // The earliest clip is the anchor (relativeStart 0); the layout keeps the
    // 1s offset and the two-lane relationship.
    expect(asset.members?.[0]).toMatchObject({
      mediaId: "media-a",
      relativeStart: 0,
      lane: { trackType: "video", laneOffset: 0 },
    });
    expect(asset.members?.[1]).toMatchObject({
      mediaId: "media-a",
      relativeStart: 1,
      lane: { trackType: "video", laneOffset: 1 },
    });

    const successes = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "success");
    expect(successes.some((n) => n.title === "Saved to work assets")).toBe(
      true,
    );
  });

  it("disables the multi entry with a reason when a member cannot be captured", () => {
    const first = mediaClip("clip-a", "media-a", { startTime: 0 });
    const orphan = mediaClip("clip-b", "media-gone", {
      startTime: 1,
      trackId: "video-track-2",
    });
    useProjectStore.setState({
      hasOpenProject: true,
      project: twoClipProject(first, orphan),
    });
    selectClips(["clip-a", "clip-b"]);

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip: first, track }),
    );

    const option = menuOption(
      result.current,
      "Save 2 Selected Clips as Work Asset",
    );
    // The pre-capture explanation, not a silent drop at commit time.
    expect(option.isDisabled).toBe(true);
    expect(option.description).toBe(
      "Some selected clips cannot be captured — check for missing media, placeholders, or engine-generated overlays",
    );
    expect(
      useProjectStore.getState().project.workAssets ?? [],
    ).toHaveLength(0);
  });

  it("keeps the single-clip entry for a one-clip selection", () => {
    const first = mediaClip("clip-a", "media-a");
    useProjectStore.setState({
      hasOpenProject: true,
      project: testProject(first, [mediaItem("media-a", "take-one.mp4")]),
    });
    selectClips(["clip-a"]);

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip: first, track }),
    );

    expect(
      result.current.some(
        (candidate) =>
          "label" in candidate && candidate.label === "Save to Work Assets",
      ),
    ).toBe(true);
  });

  it("captures exactly ONE single asset when a right-click reselect collapsed the selection before the click", async () => {
    // The reported GUI repro: multi selection opens the menu, a right-click
    // reselect collapses it to the clicked clip, and the user then clicks.
    // The label must honestly flip with the selection, and the click must
    // produce the single form for the right-clicked clip — never a phantom
    // multi, never a second entry.
    const first = mediaClip("clip-a", "media-a", { startTime: 0 });
    const second = mediaClip("clip-b", "media-a", {
      startTime: 1,
      trackId: "video-track-2",
      inPoint: 1,
      outPoint: 2,
    });
    useProjectStore.setState({
      hasOpenProject: true,
      project: twoClipProject(first, second),
    });
    selectClips(["clip-a", "clip-b"]);

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result, rerender } = renderHook(() =>
      useClipContextMenuItems({ clip: second, track }),
    );
    // Menu opened with the multi label (selection still intact).
    expect(
      result.current.some(
        (candidate) =>
          "label" in candidate &&
          candidate.label === "Save 2 Selected Clips as Work Asset",
      ),
    ).toBe(true);

    // Right-click reselect: the selection collapses to the clicked clip.
    act(() => {
      useUIStore.setState({
        selectedItems: [{ id: "clip-b", type: "clip" as const }],
      });
    });
    rerender();

    // The multi entry is gone — the label never lies about the form.
    expect(
      result.current.some(
        (candidate) =>
          "label" in candidate &&
          candidate.label === "Save 2 Selected Clips as Work Asset",
      ),
    ).toBe(false);

    await act(async () =>
      menuOption(result.current, "Save to Work Assets").onClick?.(),
    );

    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    expect(workAssets[0]).toMatchObject({
      kind: "single",
      sourceMediaId: "media-a",
      sourceRange: { inSec: 1, outSec: 2 },
    });
  });

  it("honors the LIVE selection when a stale multi-labeled item is clicked after the selection collapsed", async () => {
    // Same repro, harsher timing: the click lands on the option object
    // captured by the multi render (no re-render in between). The handler
    // must route by the selection as it stands AT CLICK TIME.
    const first = mediaClip("clip-a", "media-a", { startTime: 0 });
    const second = mediaClip("clip-b", "media-a", {
      startTime: 1,
      trackId: "video-track-2",
      inPoint: 1,
      outPoint: 2,
    });
    useProjectStore.setState({
      hasOpenProject: true,
      project: twoClipProject(first, second),
    });
    selectClips(["clip-a", "clip-b"]);

    const track = useProjectStore.getState().project.timeline
      .tracks[0] as Track;
    const { result } = renderHook(() =>
      useClipContextMenuItems({ clip: second, track }),
    );
    const staleOption = menuOption(
      result.current,
      "Save 2 Selected Clips as Work Asset",
    );

    // The collapse lands after the render but before the click.
    act(() => {
      useUIStore.setState({
        selectedItems: [{ id: "clip-b", type: "clip" as const }],
      });
    });

    await act(async () => staleOption.onClick?.());

    // Exactly ONE single asset of the right-clicked clip — the reported
    // "multi label, single asset" outcome is now the honest single form.
    const workAssets = useProjectStore.getState().project.workAssets ?? [];
    expect(workAssets).toHaveLength(1);
    expect(workAssets[0]).toMatchObject({
      kind: "single",
      sourceRange: { inSec: 1, outSec: 2 },
    });
  });
});
