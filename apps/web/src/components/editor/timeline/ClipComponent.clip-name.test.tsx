import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MediaItem, Project } from "@reelterminal/core";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { ClipComponent } from "./ClipComponent";

// Renaming media must also update the timeline clip label. The
// assets panel already prefers the media's displayName; the clip label is
// the timeline half of that promise (fallback chain: motion composition >
// compound clip name > displayName > source filename > mediaId prefix).

const trackId = "track-video";

const makeMediaItem = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: "media-1",
  name: "source-footage.mp4",
  type: "video",
  fileHandle: null,
  blob: null,
  metadata: {
    duration: 6,
    width: 1920,
    height: 1080,
    frameRate: 30,
    codec: "h264",
    sampleRate: 48000,
    channels: 2,
    fileSize: 5,
  },
  thumbnailUrl: null,
  waveformData: null,
  ...overrides,
});

const buildProject = (mediaItem: MediaItem): Project => {
  const project = createEmptyProject("Clip Label");
  return {
    ...project,
    mediaLibrary: { items: [mediaItem] },
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
              id: "clip-1",
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

const renderClip = () => {
  const { project } = useProjectStore.getState();
  const track = project.timeline.tracks.find((t) => t.id === trackId)!;
  const clip = track.clips[0]!;
  return render(
    <ClipComponent
      clip={clip}
      track={track}
      allTracks={[track]}
      pixelsPerSecond={60}
      isSelected={false}
      trackHeights={new Map([[trackId, 72]])}
      timelineRef={{ current: null }}
      onSelect={() => {}}
      onMoveClip={() => {}}
      onSnapIndicator={() => {}}
    />,
  );
};

describe("ClipComponent clip label", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: buildProject(makeMediaItem()) });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
  });

  it("prefers the media displayName over the source filename", () => {
    useProjectStore.setState({
      project: buildProject(makeMediaItem({ displayName: "Interview A" })),
    });

    renderClip();

    expect(
      screen.getByRole("button", { name: "Select clip Interview A" }),
    ).toBeInTheDocument();
  });

  it("falls back to the source filename when no displayName is set", () => {
    renderClip();

    expect(
      screen.getByRole("button", { name: "Select clip source-footage.mp4" }),
    ).toBeInTheDocument();
  });
});
