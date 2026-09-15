import "../../test/install-local-storage-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Project } from "@openreel/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";

/**
 * L3: a persistent cloud-transcription failure must not render the bare
 * raw error message. InspectorPanel composes a localized failure title
 * (cloud.transcribeFailed) with the original error message kept as the
 * detail text, and AiTab renders that message next to the explicit Retry.
 */

const stubs = vi.hoisted(() => ({
  core: {
    initializeTranscriptionService: vi.fn(),
  },
}));

vi.mock("@openreel/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openreel/core")>();
  return {
    ...actual,
    initializeTranscriptionService:
      stubs.core.initializeTranscriptionService,
  };
});

// AutoCaptionPanel mounts a whisper Worker on effect (jsdom has no
// Worker); the caption button under test lives in AiTab itself, so the
// panel is stubbed exactly like AiTab.test does.
vi.mock("./inspector/AutoCaptionPanel", () => ({
  AutoCaptionPanel: () => null,
}));

import { InspectorPanel } from "./InspectorPanel";

const clipId = "clip-vid";
const trackId = "track-vid";

function seedVideoClipWithMedia(): Project {
  const project = createEmptyProject("Inspector Transcription Failure Test");
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

function openAutoCaptionsSection(container: HTMLElement): void {
  const section = container.querySelector<HTMLElement>(
    '[data-section-id="auto-captions"]',
  );
  expect(section).not.toBeNull();
  const toggle = section?.querySelector<HTMLElement>('[role="button"]');
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
}

afterEach(() => {
  cleanup();
  useUIStore.getState().clearSelection();
  useProjectStore.setState({ project: createEmptyProject("Reset") });
  vi.clearAllMocks();
});

describe("InspectorPanel cloud transcription failure presentation (L3)", () => {
  it("renders a localized failure title and keeps the raw error message as the detail text", async () => {
    stubs.core.initializeTranscriptionService.mockReturnValue({
      transcribeClip: async () => {
        throw new Error("Upload failed with status 500");
      },
    });

    seedVideoClipWithMedia();
    const { container } = render(<InspectorPanel />);

    openAutoCaptionsSection(container);
    fireEvent.click(
      screen.getByRole("button", { name: "Generate Captions (Cloud)" }),
    );

    // The localized failure title is present…
    const failureLine = await screen.findByText(
      /Cloud transcription failed/,
    );
    // …and the raw error message is preserved as the detail text.
    expect(failureLine.textContent).toContain("Upload failed with status 500");

    // The failure persists with the explicit Retry (no auto-dismiss).
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(stubs.core.initializeTranscriptionService).toHaveBeenCalledTimes(
      1,
    );
  });
});
