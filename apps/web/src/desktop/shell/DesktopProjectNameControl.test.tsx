import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const renameProject = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("../../stores/project-store", () => ({
  useProjectStore: () => ({
    project: { id: "project-1", name: "My Project" },
    createNewProject: vi.fn(),
    recoverFromAutoSave: vi.fn(),
    renameProject,
  }),
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

  it("renders the project name input and the pencil rename entry", () => {
    render(<DesktopProjectNameControl />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    expect(input).toHaveValue("My Project");
    // Mouse-discoverable rename affordance: explicit pencil button.
    expect(screen.getByRole("button", { name: "Rename project" })).toBeTruthy();
  });

  it("focuses and selects the name from the pencil button", () => {
    render(<DesktopProjectNameControl />);

    const input = screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);

    fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("My Project".length);
  });

  it("commits a typed name on Enter through renameProject", async () => {
    render(<DesktopProjectNameControl />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "  Renamed Project " } });
    input.focus(); // Enter blurs the focused input; jsdom needs real focus
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameProject).toHaveBeenCalledWith("Renamed Project");
    });
  });

  it("commits on blur with the same semantics", async () => {
    render(<DesktopProjectNameControl />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Blurred Name" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(renameProject).toHaveBeenCalledWith("Blurred Name");
    });
  });

  it("Escape cancels the draft without renaming", () => {
    render(<DesktopProjectNameControl />);

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

  it("restores the current name and toasts when the rename fails", async () => {
    renameProject.mockResolvedValue({
      success: false,
      error: { message: "name rejected" },
    });
    render(<DesktopProjectNameControl />);

    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.change(input, { target: { value: "Bad Name" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Rename project", "name rejected");
    });
    await waitFor(() => {
      expect(input).toHaveValue("My Project");
    });
  });
});
