import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const renameProject = vi.hoisted(() => vi.fn());

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({
    project: {
      id: "project-1",
      name: "My Project",
      settings: { width: 1920, height: 1080, frameRate: 30 },
      timeline: undefined,
    },
    renameProject,
    importMedia: vi.fn(),
  }),
}));

vi.mock("../services/export-runner", () => ({
  useExportRunner: () => ({
    state: { isExporting: false, progress: 0, phase: "", error: null, complete: false },
    runExport: vi.fn(),
    showSavePicker: vi.fn(),
    reportProgress: vi.fn(),
    markComplete: vi.fn(),
    beginExport: vi.fn(),
    finishExportSoon: vi.fn(),
    failExport: vi.fn(),
    cancel: vi.fn(),
    resetError: vi.fn(),
  }),
  extForFormat: vi.fn(() => "mp4"),
  exportFilename: vi.fn(() => "export.mp4"),
  writeBlobToWritable: vi.fn(),
}));

vi.mock("@reelterminal/core", () => ({
  getExportEngine: vi.fn(),
  getDeviceProfile: vi.fn(),
  estimateExportTime: vi.fn(),
}));


// Toolbar mounts several dialogs/panels beside the name input; stub them so
// this suite exercises only the header's project-name behavior.
vi.mock("./ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./CompressDialog", () => ({ CompressDialog: () => null }));
vi.mock("./ScreenRecorder", () => ({ ScreenRecorder: () => null }));
vi.mock("./settings/SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("./ProjectSwitcher", () => ({
  ProjectSwitcher: () => <div data-testid="project-switcher" />,
}));
vi.mock("./inspector/HistoryPanel", () => ({ HistoryPanel: () => null }));

import { Toolbar } from "./Toolbar";

describe("Toolbar project name", () => {
  beforeEach(() => {
    renameProject.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the current project name", () => {
    render(<Toolbar />);

    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
      "My Project",
    );
    expect(screen.getByTestId("project-switcher")).toBeTruthy();
  });

  it("Escape cancels the draft without renaming", () => {
    render(<Toolbar />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Discarded" } });
    // Real sequence: the input is focused while typing, and the Escape
    // keydown handler itself blurs it — the blur must not commit the
    // discarded draft through the stale onBlur closure.
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("My Project");
    expect(renameProject).not.toHaveBeenCalled();
  });

  it("still commits a typed name on Enter", async () => {
    render(<Toolbar />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Renamed Project" } });
    input.focus(); // Enter blurs the focused input; jsdom needs real focus
    fireEvent.keyDown(input, { key: "Enter" });

    // The rename is async; give it a tick.
    await Promise.resolve();
    await Promise.resolve();
    expect(renameProject).toHaveBeenCalledWith("Renamed Project");
  });
});
