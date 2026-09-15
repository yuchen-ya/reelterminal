import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The AI Highlights panel runs cloud transcription followed by the
 * highlight AI, so it owns the off-gate for both (no transcription
 * service is constructed, no audio is decoded, no request is sent).
 * The panel reads the build-time cloud switch at module scope, so the
 * opt-out case re-imports it against a stubbed environment.
 */

const stubs = vi.hoisted(() => {
  const state = {
    project: null as unknown,
    getMediaItem: (() => undefined) as (id: string) => unknown,
  };
  const core = {
    getTranscriptionService: vi.fn(() => null),
    initializeTranscriptionService: vi.fn(),
  };
  return { state, core };
});

vi.mock("../../../stores/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector(stubs.state),
}));

vi.mock("../../../stores/timeline-store", () => ({
  useTimelineStore: (selector: (s: unknown) => unknown) =>
    selector({ seekTo: () => {} }),
}));

vi.mock("@openreel/core", () => ({
  getTranscriptionService: stubs.core.getTranscriptionService,
  initializeTranscriptionService: stubs.core.initializeTranscriptionService,
  analyzeAudioForHighlights: vi.fn(() => ({ segments: [], duration: 12 })),
}));

function clearCloudEnv(): void {
  delete (import.meta.env as Record<string, unknown>).VITE_OPENREEL_CLOUD;
}

function seedProjectWithMedia(): void {
  stubs.state.project = {
    timeline: {
      tracks: [{ clips: [{ id: "clip-1", mediaId: "media-1" }] }],
    },
  };
  stubs.state.getMediaItem = (id: string) =>
    id === "media-1" ? { blob: new Blob(["x"]) } : undefined;
}

async function renderPanel() {
  vi.resetModules();
  const { HighlightExtractorPanel } = await import(
    "./HighlightExtractorPanel"
  );
  return render(<HighlightExtractorPanel clipId="clip-1" />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCloudEnv();
  vi.clearAllMocks();
  stubs.state.project = null;
  stubs.state.getMediaItem = () => undefined;
});

describe("HighlightExtractorPanel cloud opt-out", () => {
  it("disables analysis with an explicit explanation and zero work when the cloud is off", async () => {
    clearCloudEnv();
    vi.stubEnv("VITE_OPENREEL_CLOUD", "off");
    seedProjectWithMedia();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await renderPanel();

    const button = screen.getByRole("button", { name: "Find Highlights" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(
        "AI highlight analysis is disabled in this build's configuration.",
      ),
    ).toBeInTheDocument();

    // Even a forced click must not start transcription, audio decoding,
    // or any network traffic. (Audio decode sits after transcription
    // init in the flow, so the zero-init assertion covers it too; the
    // static explanation is asserted above instead of a runtime error.)
    fireEvent.click(button);

    expect(
      stubs.core.initializeTranscriptionService,
    ).not.toHaveBeenCalled();
    expect(stubs.core.getTranscriptionService).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts the cloud transcription as before by default (no env set)", async () => {
    clearCloudEnv();
    seedProjectWithMedia();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    stubs.core.initializeTranscriptionService.mockReturnValue({
      transcribeClip: async () => [],
    });

    await renderPanel();

    const button = screen.getByRole("button", { name: "Find Highlights" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(
      stubs.core.initializeTranscriptionService,
    ).toHaveBeenCalledTimes(1);
    const options = stubs.core.initializeTranscriptionService.mock.calls[0][0] as {
      apiEndpoint: string;
    };
    expect(options.apiEndpoint).toContain("/transcribe");
    // The stubbed transcription yields no words, so the panel reports
    // that instead of reaching the audio/highlight stages.
    expect(await screen.findByText("No transcript words found")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
