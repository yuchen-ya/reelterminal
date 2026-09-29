import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const renameProject = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({
    project: { id: "project-1", name: "My Project" },
    createNewProject: vi.fn(),
    renameProject,
  }),
}));

vi.mock("../../desktop/start/desktop-project-actions", () => ({
  listRecentProjects: vi.fn().mockResolvedValue([]),
  openProject: vi.fn(),
  openRecentProject: vi.fn(),
}));

vi.mock("../../stores/notification-store", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

import { DesktopProjectNameControl } from "./DesktopProjectNameControl";

describe("DesktopProjectNameControl", () => {
  beforeEach(() => {
    renameProject.mockReset().mockResolvedValue({ success: true });
    toastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the project name once and one rename entry", () => {
    render(<DesktopProjectNameControl />);

    expect(screen.getByRole("button", { name: "My Project" })).toBeTruthy();
    expect(screen.getAllByText("My Project")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Rename project" })).toHaveLength(1);
  });

  it("opens the inline editor from the pencil button", () => {
    render(<DesktopProjectNameControl />);

    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
    const input = screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement;

    expect(input).toHaveValue("My Project");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "My Project" })).toBeNull();
  });

  it("commits a typed name on Enter through renameProject", async () => {
    render(<DesktopProjectNameControl />);
    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "  Renamed Project " } });
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith("Renamed Project"));
  });

  it("commits on blur", async () => {
    render(<DesktopProjectNameControl />);
    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Blurred Name" } });
    fireEvent.blur(input);

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith("Blurred Name"));
  });

  it("Escape cancels the draft without renaming", () => {
    render(<DesktopProjectNameControl />);
    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByRole("button", { name: "My Project" })).toBeTruthy();
    expect(renameProject).not.toHaveBeenCalled();
  });

  it("restores the current name and toasts when the rename fails", async () => {
    renameProject.mockResolvedValue({
      success: false,
      error: { message: "name rejected" },
    });
    render(<DesktopProjectNameControl />);
    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Bad Name" } });
    fireEvent.blur(input);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Rename project", "name rejected"));
    await waitFor(() => expect(screen.getByRole("button", { name: "My Project" })).toBeTruthy());
  });
});
