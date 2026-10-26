import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { useUIStore } from "../../stores/ui-store";

vi.mock("../editor/EditorBootstrapGate", () => ({
  EditorBootstrapGate: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("../pages/EditPage", () => ({
  EditPage: () => <div data-testid="edit-page" />,
}));
vi.mock("../pages/MotionPage", () => ({
  MotionPage: () => <div data-testid="motion-page" />,
}));
vi.mock("../pages/ExportCleanupPage", () => ({
  ExportCleanupPage: () => <div data-testid="cleanup-page" />,
}));

import { Workspace } from "./Workspace";

// Workspace is the page container only; the workspace tabs moved up into the
// desktop shell (WorkspaceModeTabs, covered by its own test file).
describe("Workspace", () => {
  beforeEach(() => {
    useUIStore.setState({ desktopPage: "edit" });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders the video editing page for the default desktop page", async () => {
    render(<Workspace />);
    expect(screen.getByTestId("desktop-workspace")).toBeTruthy();
    expect(await screen.findByTestId("edit-page")).toBeTruthy();
  });

  it("renders the motion page when the desktop page switches to motion", async () => {
    useUIStore.getState().setDesktopPage("motion");
    render(<Workspace />);

    expect(await screen.findByTestId("motion-page")).toBeTruthy();
    expect(screen.queryByTestId("edit-page")).toBeNull();
  });

  it("keeps the editor mounted while cleanup is open and returns to the same editor", async () => {
    render(<Workspace />);
    const editor = await screen.findByTestId("edit-page");
    act(() => useUIStore.getState().setDesktopPage("deliver"));
    expect(await screen.findByTestId("cleanup-page")).toBeTruthy();
    expect(editor.closest("[hidden]")).toBeTruthy();
    act(() => useUIStore.getState().setDesktopPage("edit"));
    expect(screen.getByTestId("edit-page")).toBe(editor);
    expect(editor.closest("[hidden]")).toBeNull();
  });
});
