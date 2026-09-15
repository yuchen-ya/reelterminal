import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B07: cloud transcription disclosure and failure feedback.
 * Child panels are stubbed; this suite only covers the auto-captions
 * section's cloud entry. The build-time cloud switch is read by AiTab
 * on every render from ../../../../config/api-endpoints, which is mocked
 * here behind a mutable switch so both on and off builds are exercisable
 * in one file without module re-imports.
 */

const stubs = vi.hoisted(() => ({
  cloudEnabled: { value: true },
  handleGenerateSubtitles: vi.fn(async () => {}),
}));

// Specifiers match the ones AiTab itself uses (test lives next to the
// component), so the mocker keys line up with the component's imports.
vi.mock("../AutoCaptionPanel", () => ({ AutoCaptionPanel: () => null }));
vi.mock("../CaptionEditorPanel", () => ({
  CaptionEditorPanel: () => null,
}));
vi.mock("../", () => ({ AutoReframeSection: () => null }));
vi.mock("../../../panels/AutoEditPanel", () => ({
  AutoEditPanel: () => null,
}));
vi.mock("../../../panels/HighlightExtractorPanel", () => ({
  HighlightExtractorPanel: () => null,
}));
vi.mock("../../../../config/api-endpoints", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../config/api-endpoints")
    >();
  return {
    ...actual,
    get OPENREEL_CLOUD_ENABLED() {
      return stubs.cloudEnabled.value;
    },
  };
});

import { AiTab } from "./AiTab";
import type { AiTabProps } from "./AiTab";

const baseProps: AiTabProps = {
  clipId: "clip-1",
  clipType: "video",
  showVideoControls: false,
  showAudioEffects: false,
  showVideoEffects: false,
  transcriptionProgress: null,
  isTranscribing: false,
  targetLanguage: "none",
  setTargetLanguage: () => {},
  defaultAnimationStyle: "none",
  setDefaultAnimationStyle: () => {},
  handleGenerateSubtitles: stubs.handleGenerateSubtitles,
  handleSRTImport: async () => {},
  srtInputRef: { current: null },
  handleRemoveBackground: () => {},
  handleEnhanceAudio: async () => {},
  handleAutoColor: async () => {},
  isEnhancingAudio: false,
  audioEnhanced: false,
  isApplyingSelectedClipEffect: false,
  captionWordsPerLine: 12,
  onCaptionWordsPerLineChange: () => {},
};

const UPLOAD_NOTICE =
  "Generating captions uploads this clip's audio to the OpenReel cloud transcription service.";
const BUTTON_LABEL = "Generate Captions (Cloud)";

function renderAiTab(overrides: Partial<AiTabProps> = {}) {
  return render(<AiTab {...baseProps} {...overrides} />);
}

function openAutoCaptionsSection(container: HTMLElement) {
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
  vi.useRealTimers();
  vi.clearAllMocks();
  stubs.cloudEnabled.value = true;
});

describe("AiTab cloud transcription disclosure (B07 D1)", () => {
  it("labels the cloud caption button and explains the upload before it can happen", async () => {
    const { container } = renderAiTab();
    openAutoCaptionsSection(container);

    const button = screen.getByRole("button", { name: BUTTON_LABEL });
    expect(button).toBeEnabled();
    expect(screen.getByText(UPLOAD_NOTICE)).toBeInTheDocument();
  });

  it("keeps the off-build disabled state with its explanation and no upload notice", () => {
    stubs.cloudEnabled.value = false;
    const { container } = renderAiTab();
    openAutoCaptionsSection(container);

    expect(screen.getByRole("button", { name: BUTTON_LABEL })).toBeDisabled();
    expect(
      screen.getByText(
        "Cloud transcription is disabled in this build's configuration.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(UPLOAD_NOTICE)).toBeNull();
  });
});

describe("AiTab transcription failure feedback (B07 D4)", () => {
  const errorProgress = {
    phase: "error",
    progress: 0,
    message: "Upload failed with status 500",
  } as AiTabProps["transcriptionProgress"];

  it("keeps the failure on screen with an explicit Retry that re-issues once", () => {
    vi.useFakeTimers();
    const { container } = renderAiTab({
      transcriptionProgress: errorProgress,
    });
    openAutoCaptionsSection(container);

    expect(
      screen.getByText("Upload failed with status 500"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(stubs.handleGenerateSubtitles).toHaveBeenCalledTimes(1);

    // Long past the old 3-second auto-dismiss window: still visible, and
    // no automatic re-issue happened either.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(
      screen.getByText("Upload failed with status 500"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(stubs.handleGenerateSubtitles).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry in an off build, where the gate (not the network) failed", () => {
    stubs.cloudEnabled.value = false;
    const { container } = renderAiTab({
      transcriptionProgress: errorProgress,
    });
    openAutoCaptionsSection(container);

    expect(
      screen.getByText("Upload failed with status 500"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
