/**
 * The desktop Edit page must mount the shared
 * voiceover/music task dialog + runtime, and the CollabStatusBar entry
 * button must open it through the standard ui-store modal id. Heavy page
 * panels are stubbed; the strip and the dialog run for real.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { EditPage } from "./EditPage";
import { useUIStore } from "../../stores/ui-store";
import { useProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { REQUIREMENT_BOARD_MODAL_ID } from "../editor/RequirementBoardDialog";

vi.mock("../../components/editor/AssetsPanel", () => ({
  AssetsPanel: (): React.ReactElement => <div data-testid="stub-assets" />,
}));
vi.mock("../../components/editor/InspectorPanel", () => ({
  InspectorPanel: (): React.ReactElement => <div data-testid="stub-inspector" />,
}));
vi.mock("../../components/editor/Preview", () => ({
  Preview: (): React.ReactElement => <div data-testid="stub-preview" />,
}));
vi.mock("../../components/editor/Timeline", () => ({
  Timeline: (): React.ReactElement => <div data-testid="stub-timeline" />,
}));
vi.mock("../../components/editor/agent/ExternalAgentFloatingWindow", () => ({
  ExternalAgentFloatingWindow: (): React.ReactElement | null => null,
}));
vi.mock("../editor/AgentInspectionPanel", () => ({
  AgentInspectionPanel: (): React.ReactElement | null => null,
}));
vi.mock("../../components/editor/dialogs/AgentMediaTaskDialog", () => ({
  AgentMediaTaskDialog: (): React.ReactElement | null => null,
}));
vi.mock("../editor/DesktopKeyboardShortcuts", () => ({
  DesktopKeyboardShortcuts: (): React.ReactElement | null => null,
}));

describe("EditPage lower collaboration panel", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: createEmptyProject("Desktop Demo") });
    useUIStore.setState({ activeModal: null });
  });

  afterEach(() => {
    act(() => useUIStore.setState({ activeModal: null }));
    delete (window as unknown as { reelterminal?: unknown }).reelterminal;
  });

  it("opens the requirement board from the strip entry", async () => {
    render(<EditPage />);
    await screen.findByTestId("stub-timeline");

    // The strip hosts the desktop entry button.
    const entry = screen.getByTestId("requirement-board-entry");
    expect(screen.queryByRole("dialog", { name: "Requirements" })).not.toBeInTheDocument();

    fireEvent.click(entry);

    expect(useUIStore.getState().activeModal).toBe(REQUIREMENT_BOARD_MODAL_ID);
    expect(screen.getByRole("dialog", { name: "Requirements" })).toBeInTheDocument();
  });

  it("keeps write authorization separate from the requirement board", async () => {
    render(<EditPage />);
    await screen.findByTestId("stub-timeline");

    fireEvent.click(screen.getByTestId("agent-access-toggle"));

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Requirements" })).not.toBeInTheDocument();
  });
});
