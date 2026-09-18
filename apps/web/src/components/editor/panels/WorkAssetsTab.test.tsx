import "../../../test/install-local-storage-mock";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, Project, WorkAsset } from "@openreel/core";
import { useNotificationStore } from "../../../stores/notification-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { WorkAssetsTab } from "./WorkAssetsTab";

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

function workAsset(overrides: Partial<WorkAsset> & { id: string }): WorkAsset {
  return {
    schemaVersion: 1,
    kind: "single",
    name: `Asset ${overrides.id}`,
    sourceMediaId: "media-a",
    sourceRange: { inSec: 1, outSec: 3 },
    clipSnapshot: {
      duration: 2,
      inPoint: 1,
      outPoint: 3,
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
    unsupportedParams: [],
    createdBy: "user",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function memberSnapshot(duration: number) {
  return {
    duration,
    inPoint: 0,
    outPoint: duration,
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
  };
}

function multiWorkAsset(
  overrides: Partial<WorkAsset> & { id: string },
): WorkAsset {
  return {
    schemaVersion: 1,
    kind: "multi",
    name: `Composite ${overrides.id}`,
    sourceMediaId: "media-a",
    sourceRange: { inSec: 0, outSec: 2 },
    members: [
      {
        memberId: "m-1",
        mediaId: "media-a",
        sourceRange: { inSec: 0, outSec: 2 },
        relativeStart: 0,
        lane: { trackType: "video", laneOffset: 0 },
        snapshot: memberSnapshot(2),
      },
      {
        memberId: "m-2",
        mediaId: "media-b",
        sourceRange: { inSec: 1, outSec: 2 },
        relativeStart: 1,
        lane: { trackType: "video", laneOffset: 1 },
        snapshot: memberSnapshot(1),
      },
    ],
    unsupportedParams: [],
    createdBy: "user",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function projectWith(workAssets: WorkAsset[], mediaItems: MediaItem[]): Project {
  const empty = createEmptyProject("Work assets panel");
  return {
    ...empty,
    mediaLibrary: { ...empty.mediaLibrary, items: mediaItems },
    workAssets,
    timeline: {
      ...empty.timeline,
      tracks: [
        {
          id: TRACK_ID,
          type: "video",
          name: "Video",
          clips: [],
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

describe("WorkAssetsTab", () => {
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

  it("shows the empty-state guidance that distinguishes the material library", () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith([], [mediaItem("media-a", "take-one.mp4")]),
    });
    render(<WorkAssetsTab />);
    expect(screen.getByText("No work assets yet")).toBeInTheDocument();
    expect(
      screen.getByText(/use the Library tab for assets you want across projects/i),
    ).toBeInTheDocument();
  });

  it("lists entries with name, source media, range, and count", () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [
          workAsset({ id: "wa-1", name: "Punch-in close-up" }),
          workAsset({ id: "wa-2", name: "Establishing wide" }),
        ],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);
    expect(screen.getByText("Punch-in close-up")).toBeInTheDocument();
    expect(screen.getByText("Establishing wide")).toBeInTheDocument();
    expect(screen.getAllByText("take-one.mp4").length).toBe(2);
    expect(screen.getAllByText("1s–3s").length).toBe(2);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renames an entry inline and commits on Enter", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [workAsset({ id: "wa-1", name: "Punch-in close-up" })],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);

    fireEvent.doubleClick(screen.getByText("Punch-in close-up"));
    const input = screen.getByLabelText("Work asset name");
    fireEvent.change(input, { target: { value: "Hero punch-in" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(
        useProjectStore.getState().project.workAssets?.[0]?.name,
      ).toBe("Hero punch-in");
    });
    expect(screen.getByText("Hero punch-in")).toBeInTheDocument();
  });

  it("filters entries by name through the search box", () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [
          workAsset({ id: "wa-1", name: "Punch-in close-up" }),
          workAsset({ id: "wa-2", name: "Establishing wide" }),
        ],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);

    fireEvent.change(screen.getByLabelText("Search work assets"), {
      target: { value: "punch" },
    });
    expect(screen.getByText("Punch-in close-up")).toBeInTheDocument();
    expect(screen.queryByText("Establishing wide")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search work assets"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No work assets match the search.")).toBeInTheDocument();
  });

  it("deletes an entry only after confirming, and undo restores it", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [workAsset({ id: "wa-1", name: "Punch-in close-up" })],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.mouseEnter(screen.getByText("Punch-in close-up").closest("[data-work-asset-id]")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0]?.[0]).toContain("Punch-in close-up");
    expect(
      useProjectStore.getState().project.workAssets ?? [],
    ).toHaveLength(1);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(useProjectStore.getState().project.workAssets ?? []).toHaveLength(0);
    });

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(
      useProjectStore.getState().project.workAssets?.[0]?.name,
    ).toBe("Punch-in close-up");
  });

  it("marks missing-source entries with an explanation and disables adding them", () => {
    const empty = createEmptyProject("missing source");
    useProjectStore.setState({
      hasOpenProject: true,
      project: {
        ...projectWith(
          [workAsset({ id: "wa-gone", name: "Orphaned capture" })],
          [mediaItem("media-a", "take-one.mp4")],
        ),
        mediaLibrary: { ...empty.mediaLibrary, items: [] },
      },
    });
    render(<WorkAssetsTab />);

    expect(screen.getByText("Orphaned capture")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The source media was deleted — this entry cannot be added to the timeline",
      ),
    ).toBeInTheDocument();

    fireEvent.mouseEnter(
      screen.getByText("Orphaned capture").closest("[data-work-asset-id]")!,
    );
    const add = screen.getByRole("button", { name: "Add to timeline" });
    expect(add).toBeDisabled();
    expect(add.getAttribute("title")).toContain("source media was deleted");

    const row = screen.getByText("Orphaned capture").closest("[data-work-asset-id]");
    expect(row?.getAttribute("draggable")).toBe("false");
  });

  it("adds an entry to the end of the timeline as an isolated clip", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [
          workAsset({
            id: "wa-1",
            name: "Punch-in close-up",
            clipSnapshot: {
              duration: 2,
              inPoint: 1,
              outPoint: 3,
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
              speed: 1.5,
            },
          }),
        ],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);
    const row = () =>
      screen.getByText("Punch-in close-up").closest("[data-work-asset-id]")!;

    fireEvent.mouseEnter(row());
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));

    await waitFor(() => {
      const project = useProjectStore.getState().project;
      const clips = project.timeline.tracks.flatMap((t) => t.clips);
      expect(clips).toHaveLength(1);
      // No target track given: the batch creates a fresh matching lane
      // (instantiate default) and lands the clip at the timeline end (0).
      expect(project.timeline.tracks).toHaveLength(2);
      expect(clips[0]).toMatchObject({
        mediaId: "media-a",
        startTime: 0,
        inPoint: 1,
        outPoint: 3,
        speed: 1.5,
      });
      expect(clips[0]?.trackId).not.toBe(TRACK_ID);
      // The asset entry itself stays untouched by instantiation.
      const asset = project.workAssets?.[0];
      expect(asset?.id).toBe("wa-1");
      expect(asset?.name).toBe("Punch-in close-up");
    });

    // A second add produces a fresh, independent clip.
    fireEvent.mouseLeave(row());
    fireEvent.mouseEnter(row());
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    await waitFor(() => {
      const clips = useProjectStore
        .getState()
        .project.timeline.tracks.flatMap((t) => t.clips);
      expect(clips).toHaveLength(2);
      expect(clips[0]?.id).not.toBe(clips[1]?.id);
      // Timeline end after the first clip (startTime 0 + duration 2).
      expect(clips[1]?.startTime).toBe(2);
    });

    const successes = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "success");
    expect(successes.some((n) => n.title === "Added to timeline")).toBe(true);
  });

  it("reports a clear error when instantiating a missing-source entry", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [workAsset({ id: "wa-gone", name: "Orphaned capture" })],
        [],
      ),
    });
    render(<WorkAssetsTab />);

    const result = await useProjectStore
      .getState()
      .instantiateWorkAsset("wa-gone");
    if (result.ok) throw new Error("expected missing-source instantiation to fail");
    expect(result.code).toBe("MEDIA_NOT_FOUND");
    expect(
      (useProjectStore.getState().project.timeline.tracks[0]?.clips ?? []),
    ).toHaveLength(0);
  });

  it("shows the member badge with the lane summary for multi entries", () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [multiWorkAsset({ id: "wa-multi", name: "Two-up composite" })],
        [mediaItem("media-a", "take-one.mp4")],
      ),
    });
    render(<WorkAssetsTab />);

    expect(screen.getByText("Two-up composite")).toBeInTheDocument();
    expect(screen.getByText("2 members")).toBeInTheDocument();
    expect(screen.getByText("· 2V")).toBeInTheDocument();
  });

  it("turns a multi entry yellow when ANY member's media is missing and disables adding", () => {
    const empty = createEmptyProject("member missing");
    useProjectStore.setState({
      hasOpenProject: true,
      project: {
        ...projectWith(
          [multiWorkAsset({ id: "wa-multi", name: "Two-up composite" })],
          [mediaItem("media-a", "take-one.mp4")],
        ),
        mediaLibrary: {
          ...empty.mediaLibrary,
          // media-b (the second member's source) is gone; media-a remains.
          items: [mediaItem("media-a", "take-one.mp4")],
        },
      },
    });
    render(<WorkAssetsTab />);

    expect(screen.getByText("Two-up composite")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The source media of 1 member was deleted — this entry cannot be added to the timeline",
      ),
    ).toBeInTheDocument();

    fireEvent.mouseEnter(
      screen.getByText("Two-up composite").closest("[data-work-asset-id]")!,
    );
    const add = screen.getByRole("button", { name: "Add to timeline" });
    expect(add).toBeDisabled();

    const row = screen
      .getByText("Two-up composite")
      .closest("[data-work-asset-id]");
    expect(row?.getAttribute("draggable")).toBe("false");
  });

  it("adds a multi entry as independent members on fresh lanes", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith(
        [multiWorkAsset({ id: "wa-multi", name: "Two-up composite" })],
        [
          mediaItem("media-a", "take-one.mp4"),
          mediaItem("media-b", "take-two.mp4"),
        ],
      ),
    });
    render(<WorkAssetsTab />);

    fireEvent.mouseEnter(
      screen.getByText("Two-up composite").closest("[data-work-asset-id]")!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));

    await waitFor(() => {
      const project = useProjectStore.getState().project;
      const clips = project.timeline.tracks.flatMap((t) => t.clips);
      expect(clips).toHaveLength(2);
      // One fresh lane per distinct member lane, anchor time at timeline end.
      expect(project.timeline.tracks).toHaveLength(3);
      // Relative timing is preserved verbatim (0 and 0 + 1).
      const starts = clips.map((clip) => clip.startTime).sort((a, b) => a - b);
      expect(starts).toEqual([0, 1]);
      const anchor = clips.find((clip) => clip.startTime === 0)!;
      const second = clips.find((clip) => clip.startTime === 1)!;
      expect(anchor.mediaId).toBe("media-a");
      expect(second.mediaId).toBe("media-b");
      // The members land on different lanes (their lane relationship).
      expect(anchor.trackId).not.toBe(second.trackId);
      // The asset entry itself is untouched.
      expect(project.workAssets?.[0]?.members).toHaveLength(2);
    });

    const successes = useNotificationStore
      .getState()
      .notifications.filter((n) => n.type === "success");
    expect(successes.some((n) => n.title === "Added to timeline")).toBe(true);
  });

  it("rejects a multi capture with fewer than two clips explicitly", async () => {
    useProjectStore.setState({
      hasOpenProject: true,
      project: projectWith([], [mediaItem("media-a", "take-one.mp4")]),
    });
    const result = await useProjectStore
      .getState()
      .saveClipsAsWorkAsset(["clip-a"]);
    if (result.ok) throw new Error("expected undersized capture set to fail");
    expect(result.code).toBe("INVALID_PARAMS");
    expect(useProjectStore.getState().project.workAssets ?? []).toHaveLength(0);
  });
});
