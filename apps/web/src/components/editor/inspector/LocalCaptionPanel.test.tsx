import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  clip: null as any,
  media: null as any,
  start: vi.fn(),
  settings: vi.fn(),
  ready: { qwen: true, sensevoice: true },
}));
vi.mock("../../../stores/project-store", () => {
  const state = {
    project: { id: "project" },
    getClip: () => fixture.clip,
    getMediaItem: () => fixture.media,
  };
  return {
    useProjectStore: Object.assign((select: any) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock("../../../stores/ui-store", () => ({
  useUIStore: (select: any) =>
    select({ selectedItems: [{ type: "clip", id: "clip" }] }),
}));
vi.mock("../../../stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ openSettings: fixture.settings }) },
}));
vi.mock("../../../services/audio-environment", () => ({
  useAudioEnvironment: () => ({
    report: { captionEngines: fixture.ready },
    checking: false,
    error: "",
    check: vi.fn(),
  }),
}));
vi.mock("../../../services/caption-job", () => ({
  startCaptionJob: fixture.start,
  cancelCaptionJob: vi.fn(),
  useCaptionJob: (select?: any) =>
    select ? select({ state: "idle" }) : { state: "idle" },
}));
import { LocalCaptionPanel } from "./LocalCaptionPanel";
beforeEach(() => {
  fixture.clip = {
    id: "clip",
    mediaId: "media",
    duration: 353,
    audioTrackIndex: 1,
  };
  fixture.media = { name: "Pi.mp4", type: "video" };
  fixture.ready = { qwen: true, sensevoice: true };
  fixture.start.mockReset();
  fixture.settings.mockReset();
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: { captions: {} },
  });
});
it("defaults to Qwen, describes memory, and switches to SenseVoice without exposing Whisper", () => {
  render(<LocalCaptionPanel />);
  expect(screen.getByRole("button", { name: /Qwen/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText("May use several GB of RAM")).toBeVisible();
  expect(screen.queryByText(/Whisper/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Generate captions" }));
  expect(fixture.start).toHaveBeenLastCalledWith(
    "clip",
    "auto",
    "default",
    1,
    "qwen",
  );
  fireEvent.click(screen.getByRole("button", { name: /SenseVoice/ }));
  fireEvent.click(screen.getByRole("button", { name: "Generate captions" }));
  expect(fixture.start).toHaveBeenLastCalledWith(
    "clip",
    "auto",
    "default",
    1,
    "sensevoice",
  );
});
it("routes a missing selected engine to application settings instead of starting inference", () => {
  fixture.ready.qwen = false;
  render(<LocalCaptionPanel />);
  fireEvent.click(
    screen.getByRole("button", { name: "Configure environment" }),
  );
  expect(fixture.settings).toHaveBeenCalledWith("models");
  expect(fixture.start).not.toHaveBeenCalled();
});
it("has a single disabled action in the empty state", () => {
  fixture.clip = null;
  fixture.media = null;
  render(<LocalCaptionPanel />);
  expect(
    screen.getByRole("button", { name: "Select a clip first" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Configure environment" }),
  ).not.toBeInTheDocument();
});
