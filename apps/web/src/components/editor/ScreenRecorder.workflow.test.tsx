import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRecorderStore } from "../../stores/recorder-store";
import { ScreenRecorder } from "./ScreenRecorder";

// jsdom has no getDisplayMedia/MediaRecorder, so ScreenRecorderService would
// report unsupported and every audio card would render disabled. Override the
// capability probe only; keep the real module exports (recorder-store imports
// DEFAULT_RECORDING_OPTIONS from it).
vi.mock("../../services/screen-recorder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/screen-recorder")>();
  return {
    ...actual,
    ScreenRecorderService: {
      ...actual.ScreenRecorderService,
      isSupported: () => true,
      getSupportedFeatures: () => ({
        screenCapture: true,
        systemAudio: true,
        webcam: true,
        vp9: true,
        h264: true,
      }),
    },
  };
});

// F06 context: the investigation report alleged the audio cards here were
// double-bound (onClick + onChange to the same toggle) like MultiCameraPanel.
// That is not the case at HEAD — both cards pass onChange only, so the
// component-level double-dispatch contract never bit this component. These
// tests lock the single-toggle behavior in against the fixed contract.
describe("ScreenRecorder audio options workflow", () => {
  beforeEach(() => {
    useRecorderStore.setState({
      status: "idle",
      error: null,
      webcamStream: null,
      options: {
        video: { resolution: "1080p", frameRate: 30 },
        audio: { systemAudio: false, microphone: false },
        webcam: { enabled: false, resolution: "720p" },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles the microphone option exactly once per click", () => {
    render(
      <ScreenRecorder
        isOpen
        onClose={vi.fn()}
        onRecordingComplete={vi.fn()}
      />,
    );

    const micCard = screen.getByRole("checkbox", { name: "Microphone" });
    expect(micCard).toHaveAttribute("aria-checked", "false");

    fireEvent.click(micCard);
    expect(micCard).toHaveAttribute("aria-checked", "true");
    expect(useRecorderStore.getState().options.audio.microphone).toBe(true);

    fireEvent.click(micCard);
    expect(micCard).toHaveAttribute("aria-checked", "false");
    expect(useRecorderStore.getState().options.audio.microphone).toBe(false);
  });

  it("toggles the system audio option exactly once per click", () => {
    render(
      <ScreenRecorder
        isOpen
        onClose={vi.fn()}
        onRecordingComplete={vi.fn()}
      />,
    );

    const systemAudioCard = screen.getByRole("checkbox", {
      name: "System Audio",
    });
    expect(systemAudioCard).not.toBeDisabled();

    fireEvent.click(systemAudioCard);
    expect(systemAudioCard).toHaveAttribute("aria-checked", "true");
    expect(useRecorderStore.getState().options.audio.systemAudio).toBe(true);
  });
});
