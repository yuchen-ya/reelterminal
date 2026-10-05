import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useUIStore } from "../../stores/ui-store";

const actionMocks = vi.hoisted(() => ({
  listRecentProjects: vi.fn(),
  openRecentProject: vi.fn(),
  startNewProject: vi.fn(),
  startNewMotionProject: vi.fn(),
  openProject: vi.fn(),
  saveCurrentProject: vi.fn(),
}));

vi.mock("./desktop-project-actions", async () => {
  const actual = await vi.importActual<typeof import("./desktop-project-actions")>(
    "./desktop-project-actions",
  );
  return {
    ...actual,
    listRecentProjects: actionMocks.listRecentProjects,
    openRecentProject: actionMocks.openRecentProject,
    startNewProject: actionMocks.startNewProject,
    startNewMotionProject: actionMocks.startNewMotionProject,
    openProject: actionMocks.openProject,
    saveCurrentProject: actionMocks.saveCurrentProject,
  };
});

import { DESKTOP_FORMATS } from "./desktop-project-actions";
import { DesktopStartScreen } from "./DesktopStartScreen";

describe("DesktopStartScreen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    actionMocks.listRecentProjects.mockResolvedValue([]);
    actionMocks.openRecentProject.mockResolvedValue(true);
    actionMocks.startNewProject.mockReset();
    actionMocks.startNewMotionProject.mockReset();
    actionMocks.saveCurrentProject.mockReset().mockResolvedValue(undefined);
    actionMocks.openProject.mockReset().mockResolvedValue(false);
    useUIStore.setState({ desktopPage: "edit" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("starts a Video Editor project from the default mode", async () => {
    render(<DesktopStartScreen />);
    await screen.findByText("No recent projects yet. Start a new project above.");

    fireEvent.click(screen.getByRole("button", { name: /Horizontal/ }));

    await waitFor(() => expect(actionMocks.startNewProject).toHaveBeenCalledWith(DESKTOP_FORMATS[1]));
    expect(actionMocks.startNewMotionProject).not.toHaveBeenCalled();
    expect(useUIStore.getState().desktopPage).toBe("edit");
  });

  it("starts a Motion Creator project after selecting the motion mode", async () => {
    render(<DesktopStartScreen />);
    await screen.findByText("No recent projects yet. Start a new project above.");

    fireEvent.click(screen.getByRole("checkbox", { name: /Motion Creator/ }));
    fireEvent.click(screen.getByRole("button", { name: /Square/ }));

    await waitFor(() => expect(actionMocks.startNewMotionProject).toHaveBeenCalledWith(DESKTOP_FORMATS[2]));
    expect(actionMocks.startNewProject).not.toHaveBeenCalled();
    expect(useUIStore.getState().desktopPage).toBe("motion");
  });

  it("opens a recent project using its project id", async () => {
    actionMocks.listRecentProjects.mockResolvedValue([
      { id: "project-123", name: "Recent Cut", lastOpened: Date.now() },
    ]);
    render(<DesktopStartScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Recent Cut" }));
    await waitFor(() => expect(actionMocks.openRecentProject).toHaveBeenCalledWith("project-123"));
    await waitFor(() => expect(useUIStore.getState().desktopPage).toBe("edit"));
    expect(useUIStore.getState().desktopPage).toBe("edit");
  });

  it("keeps the start screen active when opening a recent project fails", async () => {
    actionMocks.openRecentProject.mockResolvedValue(false);
    actionMocks.listRecentProjects.mockResolvedValue([
      { id: "missing-project", name: "Missing project", lastOpened: Date.now() },
    ]);
    useUIStore.setState({ desktopPage: "motion" });
    render(<DesktopStartScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Missing project" }));
    await waitFor(() => expect(actionMocks.openRecentProject).toHaveBeenCalledWith("missing-project"));
    expect(useUIStore.getState().desktopPage).toBe("motion");
  });

  it("preserves the chooser when saving fails, then allows retrying", async () => {
    const onProjectOpened = vi.fn();
    actionMocks.saveCurrentProject.mockRejectedValueOnce(new Error("storage full"));
    render(<DesktopStartScreen onProjectOpened={onProjectOpened} />);
    fireEvent.click(screen.getByRole("button", { name: /Horizontal/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Horizontal/ })).toBeEnabled());
    expect(actionMocks.startNewProject).not.toHaveBeenCalled();
    expect(onProjectOpened).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Horizontal/ }));
    await waitFor(() => expect(onProjectOpened).toHaveBeenCalledOnce());
    expect(actionMocks.startNewProject).toHaveBeenCalledWith(DESKTOP_FORMATS[1]);
  });

  it("keeps the chooser on file cancellation and exits after a successful open", async () => {
    const onProjectOpened = vi.fn();
    render(<DesktopStartScreen onProjectOpened={onProjectOpened} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    await waitFor(() => expect(actionMocks.openProject).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Project" })).toBeEnabled());
    expect(onProjectOpened).not.toHaveBeenCalled();

    actionMocks.openProject.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    await waitFor(() => expect(onProjectOpened).toHaveBeenCalledOnce());
  });
});
