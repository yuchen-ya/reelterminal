import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import type { OpenReelAnalysisRecord } from "../../types/global";
import { AnalysisRecordsPanel } from "./AnalysisRecordsPanel";

const originalProject = structuredClone(useProjectStore.getState().project);
const originalOpenReel = window.reelterminal;

function record(overrides: Partial<OpenReelAnalysisRecord> = {}): OpenReelAnalysisRecord {
  return {
    schemaVersion: 1,
    id: "analysis-12345678-abcd",
    projectId: "project-analysis",
    createdAt: "2026-09-08T00:00:00.000Z",
    finishedAt: "2026-09-08T00:01:00.000Z",
    subject: {
      mediaId: "media-analysis",
      name: "Interview.mp4",
      sourcePath: "/private/source.mp4",
      sourceFingerprint: { size: 12, lastModified: 10 },
    },
    analysisTypes: ["technicalQuality", "audioSummary"],
    rangeSec: { startSec: 2, endSec: 4 },
    config: {
      analysisTypes: ["technicalQuality", "audioSummary"],
      startSec: 2,
      endSec: 4,
      cloudUpload: false,
    },
    provenance: [{ kind: "local-measurement", provider: "local", analysisType: "audioSummary" }],
    observations: [{ source: "audioSummary", facts: { onsets: [3] } }],
    inferences: [{ note: "candidate rhythm" }],
    recommendations: [{ note: "inspect the onset" }],
    unknowns: [{ field: "semanticMeaning", note: "not measured" }],
    recheckOf: null,
    cloudOpinion: null,
    stale: { kind: "current" },
    recordPath: "/private/analysis.json",
    ...overrides,
  };
}

function installBridge(detail = record()) {
  const list = vi.fn(async () => ({ records: [detail], legacyUnscopedCount: 0 }));
  const recheck = vi.fn(async () => ({
    ok: false as const,
    error: { code: "UNSUPPORTED", message: "Enable Agent Access to run a recheck." },
  }));
  window.reelterminal = {
    platform: "desktop",
    analysisRecords: {
      list,
      get: vi.fn(async () => detail),
      recheck,
      jobStatus: vi.fn(),
    },
  } as unknown as NonNullable<Window["reelterminal"]>;
  return { list, recheck };
}

beforeEach(() => {
  const project = structuredClone(originalProject);
  useProjectStore.setState({
    project: {
      ...project,
      id: "project-analysis",
      mediaLibrary: {
        ...project.mediaLibrary,
        items: [
          {
            id: "media-analysis",
            name: "Interview.mp4",
            type: "video",
            metadata: { duration: 10, width: 1920, height: 1080, frameRate: 30, codec: "h264", sampleRate: 48000, channels: 2, fileSize: 12 },
          },
        ] as typeof project.mediaLibrary.items,
      },
      timeline: {
        ...project.timeline,
        tracks: [
          {
            id: "track-analysis",
            name: "Video",
            type: "video",
            clips: [
              {
                id: "clip-analysis",
                mediaId: "media-analysis",
                trackId: "track-analysis",
                startTime: 10,
                duration: 4,
                inPoint: 2,
                outPoint: 6,
                speed: 1,
                reversed: false,
                effects: [],
                audioEffects: [],
                transform: {
                  position: { x: 0, y: 0 },
                  scale: { x: 1, y: 1 },
                  rotation: 0,
                  opacity: 1,
                  anchor: { x: 0.5, y: 0.5 },
                },
                volume: 1,
                keyframes: [],
              },
            ],
            transitions: [],
            muted: false,
            locked: false,
            hidden: false,
            solo: false,
          },
        ],
      },
    },
  });
  useTimelineStore.setState({ playheadPosition: 0, playbackState: "paused", loopEnabled: false });
});

afterEach(() => {
  window.reelterminal = originalOpenReel;
  useProjectStore.setState({ project: structuredClone(originalProject) });
});

describe("AnalysisRecordsPanel", () => {
  it("shows separated evidence and locates source timestamps on the timeline", async () => {
    const { list } = installBridge();
    // The record is created after the panel mounted; opening must read again.
    list.mockResolvedValueOnce({ records: [], legacyUnscopedCount: 0 });
    render(<AnalysisRecordsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Open analysis records" }));

    expect(await screen.findByText("Observations")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Inferences")).toBeInTheDocument();
    expect(screen.getByText("Recommendations")).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(2);
    expect(screen.getByText(/semanticMeaning:/)).toBeInTheDocument();

    const onset = screen.getByTitle(/facts\.onsets\[0\].*timeline 11s/);
    fireEvent.click(onset);
    expect(useTimelineStore.getState().playheadPosition).toBe(11);

    fireEvent.click(screen.getByRole("button", { name: "Loop range on timeline" }));
    expect(useTimelineStore.getState()).toMatchObject({
      loopEnabled: true,
      loopStart: 10,
      loopEnd: 12,
    });
  });

  it("does not turn cloud opinion status into a pass and consumes upload consent per run", async () => {
    const cloud = record({
      analysisTypes: ["technicalQuality", "videoReview"],
      config: {
        analysisTypes: ["technicalQuality", "videoReview"],
        startSec: 2,
        endSec: 4,
        cloudUpload: true,
      },
      provenance: [{ kind: "cloud-opinion", provider: "qwen", analysisType: "videoReview" }],
      cloudOpinion: {
        provider: "qwen",
        text: "Looks acceptable",
        status: "opinion",
        serverSamplingFps: null,
      },
    });
    const { recheck } = installBridge(cloud);
    render(<AnalysisRecordsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Open analysis records" }));

    expect(await screen.findByText("Cloud opinion · not a pass")).toBeInTheDocument();
    expect(screen.queryByText(/^Pass$/i)).toBeNull();
    const run = screen.getByRole("button", { name: "Run authorized cloud recheck" });
    expect(run).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(run).toBeEnabled();
    fireEvent.click(run);

    await waitFor(() => expect(recheck).toHaveBeenCalledWith({
      projectId: "project-analysis",
      recordId: cloud.id,
      allowCloudUpload: true,
    }));
    expect(run).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Enable Agent Access");
  });
});
