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
    // that instead of reaching the audio/highlight stages. The
    // failure is presented behind a localized title while the raw
    // message stays readable as the detail text.
    const failureLine = await screen.findByText(
      /AI highlight analysis failed/,
    );
    expect(failureLine.textContent).toContain("No transcript words found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HighlightExtractorPanel cloud failure presentation", () => {
  it("presents an unreachable cloud service with a categorized title, the raw detail, and an explicit Retry", async () => {
    clearCloudEnv();
    seedProjectWithMedia();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    stubs.core.initializeTranscriptionService.mockReturnValue({
      transcribeClip: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });

    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Find Highlights" }));

    // Categorized, understandable wording instead of the bare browser
    // message as the headline…
    expect(
      await screen.findByText(
        "Could not reach the OpenReel cloud service. Check your connection and retry; if it persists, the service may be temporarily unavailable.",
      ),
    ).toBeInTheDocument();
    // …with the raw message demoted to the detail line…
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    // …and a manual Retry next to it (no auto-retry ever happens).
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    const service = stubs.core.initializeTranscriptionService.mock
      .results[0].value as { transcribeClip: ReturnType<typeof vi.fn> };
    await screen.findByText(
      "Could not reach the OpenReel cloud service. Check your connection and retry; if it persists, the service may be temporarily unavailable.",
    );
    expect(service.transcribeClip).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("presents a structured rate-limit failure through the same categorized wording", async () => {
    clearCloudEnv();
    seedProjectWithMedia();
    vi.stubGlobal(
      "fetch",
      vi.fn(),
    );
    // Structured errors are matched by their kind field (the service
    // layer throws them; duck-typed here because core is fully mocked).
    stubs.core.initializeTranscriptionService.mockReturnValue({
      transcribeClip: async () => {
        throw Object.assign(
          new Error(
            "Rate limit reached. Please wait a minute before transcribing more audio.",
          ),
          { kind: "rateLimited", detail: "Rate limit reached." },
        );
      },
    });

    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Find Highlights" }));

    expect(
      await screen.findByText(
        "Too many requests. Please wait about a minute and retry.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Rate limit reached.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("aborts the in-flight run when the panel unmounts", async () => {
    clearCloudEnv();
    seedProjectWithMedia();
    vi.stubGlobal("fetch", vi.fn());
    let capturedSignal: AbortSignal | undefined;
    stubs.core.initializeTranscriptionService.mockReturnValue({
      transcribeClip: async (
        _clip: unknown,
        _media: unknown,
        _onProgress: unknown,
        signal: AbortSignal,
      ) => {
        capturedSignal = signal;
        // Upload hangs until aborted.
        await new Promise(() => {});
      },
    });

    const { unmount } = await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Find Highlights" }));
    await Promise.resolve();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    // No orphaned upload outlives the panel.
    expect(capturedSignal?.aborted).toBe(true);
  });
});
