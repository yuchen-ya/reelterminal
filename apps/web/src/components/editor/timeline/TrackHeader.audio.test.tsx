import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Clip, MediaItem, Track } from "@openreel/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { TrackHeader } from "./TrackHeader";

function audioTrack(id: string, name: string): Track {
  return {
    id,
    type: "audio",
    name,
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function videoTrack(id: string, name: string, clips: Clip[] = []): Track {
  return {
    id,
    type: "video",
    name,
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function videoClip(id: string, trackId: string, mediaId: string): Clip {
  return {
    id,
    mediaId,
    trackId,
    startTime: 0,
    duration: 4,
    inPoint: 0,
    outPoint: 4,
    speed: 1,
    volume: 1,
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    effects: [],
    audioEffects: [],
    keyframes: [],
  };
}

// MediaItem.metadata is persisted as MediaMetadata but carries the import-time
// MediaTrackInfo (including hasAudio) at runtime, so the extra field is added
// through a plain object to keep the literal assignment type-safe.
function mediaMetadata(hasAudio: boolean) {
  return {
    duration: 5,
    width: 320,
    height: 180,
    frameRate: 30,
    codec: "h264",
    sampleRate: 44100,
    channels: 2,
    fileSize: 1024,
    hasAudio,
  };
}

function mediaItem(id: string, hasAudio: boolean): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    type: "video",
    fileHandle: null,
    blob: null,
    metadata: mediaMetadata(hasAudio),
    thumbnailUrl: null,
    waveformData: null,
  };
}

const noop = () => undefined;

function renderHeader(track: Track) {
  return render(
    <TrackHeader
      track={track}
      index={0}
      onDragStart={noop}
      onDragOver={noop}
      onDrop={noop}
      onDragEnd={noop}
    />,
  );
}

describe("TrackHeader audio controls", () => {
  beforeEach(() => {
    const project = createEmptyProject("Audio controls");
    useProjectStore.setState({
      hasOpenProject: true,
      project: {
        ...project,
        timeline: {
          ...project.timeline,
          tracks: [audioTrack("dialogue", "Dialogue"), audioTrack("music", "Music")],
        },
      },
    });
    useProjectStore.getState().actionExecutor.getHistory().clear();
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ hasOpenProject: false });
  });

  it("exposes solo directly in the timeline and persists it undoably", async () => {
    renderHeader(useProjectStore.getState().project.timeline.tracks[0]);

    expect(screen.getByText("Dialogue")).toHaveClass("cursor-grab");

    fireEvent.click(screen.getByRole("button", { name: "Solo Dialogue" }));

    await waitFor(() => {
      expect(useProjectStore.getState().project.timeline.tracks[0]?.solo).toBe(true);
      expect(useProjectStore.getState().actionExecutor.getHistory().canUndo()).toBe(true);
    });
  });

  it("uses explicit mute state and accessible track-specific labels", async () => {
    const view = renderHeader(useProjectStore.getState().project.timeline.tracks[1]);

    fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));
    await waitFor(() => {
      expect(useProjectStore.getState().project.timeline.tracks[1]?.muted).toBe(true);
    });

    view.rerender(
      <TrackHeader
        track={useProjectStore.getState().project.timeline.tracks[1]}
        index={1}
        onDragStart={noop}
        onDragOver={noop}
        onDrop={noop}
        onDragEnd={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Unmute Music" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("TrackHeader video track audio controls", () => {
  beforeEach(() => {
    const project = createEmptyProject("Video audio controls");
    useProjectStore.setState({
      hasOpenProject: true,
      project,
    });
    useProjectStore.getState().actionExecutor.getHistory().clear();
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ hasOpenProject: false });
  });

  function installTracks(tracks: Track[], items: MediaItem[] = []) {
    const project = useProjectStore.getState().project;
    useProjectStore.setState({
      hasOpenProject: true,
      project: {
        ...project,
        mediaLibrary: { ...project.mediaLibrary, items },
        timeline: { ...project.timeline, tracks },
      },
    });
  }

  it("exposes mute and solo on video tracks and persists mute undoably", async () => {
    installTracks([videoTrack("v1", "V1"), audioTrack("a1", "A1")]);
    const view = renderHeader(useProjectStore.getState().project.timeline.tracks[0]);

    fireEvent.click(screen.getByRole("button", { name: "Mute V1" }));
    await waitFor(() => {
      expect(useProjectStore.getState().project.timeline.tracks[0]?.muted).toBe(true);
      expect(useProjectStore.getState().actionExecutor.getHistory().canUndo()).toBe(true);
    });

    view.rerender(
      <TrackHeader
        track={useProjectStore.getState().project.timeline.tracks[0]}
        index={0}
        onDragStart={noop}
        onDragOver={noop}
        onDrop={noop}
        onDragEnd={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Unmute V1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reports solo suppression on the speaker instead of reusing the hidden look", async () => {
    installTracks([videoTrack("v1", "V1"), audioTrack("a1", "A1")]);
    await useProjectStore.getState().soloTrack("v1", true);

    renderHeader(useProjectStore.getState().project.timeline.tracks[1]);

    const muteButton = screen.getByRole("button", { name: "Mute A1" });
    expect(muteButton).toHaveAttribute("title", "Silenced by solo");
    expect(muteButton).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Solo A1" })).not.toHaveAttribute(
      "title",
      "Silenced by solo",
    );
  });

  it("keeps video controls available when audio presence cannot be judged", () => {
    installTracks([videoTrack("v1", "V1")]);
    renderHeader(useProjectStore.getState().project.timeline.tracks[0]);

    expect(screen.getByRole("button", { name: "Mute V1" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Solo V1" })).not.toBeDisabled();
  });

  it("greys mute and solo out only when every clip provably has no audio", () => {
    installTracks(
      [
        videoTrack("v1", "Silent", [videoClip("c1", "v1", "m1")]),
        videoTrack("v2", "Voiced", [videoClip("c2", "v2", "m2")]),
      ],
      [mediaItem("m1", false), mediaItem("m2", true)],
    );

    renderHeader(useProjectStore.getState().project.timeline.tracks[0]);
    const silentMute = screen.getByRole("button", { name: "Mute Silent" });
    expect(silentMute).toBeDisabled();
    expect(silentMute).toHaveAttribute("title", "Track has no audio");
    expect(screen.getByRole("button", { name: "Solo Silent" })).toBeDisabled();

    cleanup();
    renderHeader(useProjectStore.getState().project.timeline.tracks[1]);
    expect(screen.getByRole("button", { name: "Mute Voiced" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Solo Voiced" })).not.toBeDisabled();
  });
});
