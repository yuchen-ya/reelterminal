import { useAgentReferencesStore } from "../../stores/agent-references-store";
import { openBoardForEntities } from "../../services/requirement-board";
import type { MediaItem } from "@reelterminal/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionExecutor, ActionHistory } from "@reelterminal/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import {
  REQUIREMENT_BOARD_MODAL_ID,
  RequirementBoardDialog,
} from "./RequirementBoardDialog";

describe("RequirementBoardDialog", () => {
  beforeEach(() => {
    useAgentReferencesStore.getState().reset();
    const history = new ActionHistory();
    useProjectStore.setState({
      project: createEmptyProject("Board"),
      hasOpenProject: true,
      actionHistory: history,
      actionExecutor: new ActionExecutor(history),
    });
    useUIStore.setState({
      activeModal: REQUIREMENT_BOARD_MODAL_ID,
      modalData: null,
    });
  });

  it("persists a ready requirement and exposes its stable Q number", async () => {
    render(<RequirementBoardDialog />);
    fireEvent.change(
      screen.getByPlaceholderText("Describe the outcome in one line"),
      {
        target: { value: "Tighten the opening" },
      },
    );
    fireEvent.click(screen.getByText("Details and acceptance criteria"));
    fireEvent.change(
      screen.getByPlaceholderText(
        "Add editing requirements, goals, and constraints…",
      ),
      {
        target: { value: "Remove the pause before the first line." },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish to board" }));

    await waitFor(() =>
      expect(
        useProjectStore.getState().project.requirements?.items,
      ).toHaveLength(1),
    );
    expect(
      useProjectStore.getState().project.requirements?.items[0],
    ).toMatchObject({
      number: 1,
      title: "Tighten the opening",
      status: "ready",
    });
    expect(screen.getByText("Q1")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Task title" })).toHaveValue("Tighten the opening");
    expect(screen.getByText("Description")).toBeInTheDocument();
  });
  it("keeps object references after a session reset and locates the saved object", async () => {
    const media = {
      id: "source-1",
      name: "Opening",
      type: "video",
    } as MediaItem;
    useProjectStore.setState((state) => ({
      project: {
        ...state.project,
        mediaLibrary: { ...state.project.mediaLibrary, items: [media] },
      },
    }));
    openBoardForEntities([media.id]);
    render(<RequirementBoardDialog />);
    expect(
      screen.getByRole("checkbox", { name: "A1 · Opening" }),
    ).toBeChecked();
    fireEvent.change(
      screen.getByPlaceholderText("Describe the outcome in one line"),
      { target: { value: "Trim opening" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish to board" }));
    await waitFor(() =>
      expect(
        useProjectStore.getState().project.requirements?.items,
      ).toHaveLength(1),
    );
    const persisted = JSON.parse(
      JSON.stringify(useProjectStore.getState().project),
    );
    expect(persisted.requirements.items[0].references[0]).toMatchObject({
      entityId: "source-1",
      ref: "A1",
      label: "Opening",
    });
    cleanup();
    useAgentReferencesStore.getState().reset();
    useProjectStore.setState({ project: persisted });
    useUIStore.setState({ modalData: null });
    render(<RequirementBoardDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Q1 Trim opening/ }));
    fireEvent.click(screen.getByRole("button", { name: "A1 · Opening" }));
    expect(useUIStore.getState().selectedItems).toContainEqual({
      type: "media",
      id: "source-1",
      trackId: undefined,
    });
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it("shows missing references and lets the user accept an agent result", async () => {
    await useProjectStore
      .getState()
      .addProjectRequirement({
        title: "Review result",
        status: "review",
        references: [
          {
            ref: "A2",
            kind: "media",
            entityId: "gone",
            label: "Deleted",
            timing: { startSeconds: null, endSeconds: null },
          },
        ],
      });
    render(<RequirementBoardDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Q1 Review result/ }));
    expect(screen.getByRole("button", { name: /A2 · Deleted/ })).toBeDisabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Accept result" })),
    );
    expect(
      useProjectStore.getState().project.requirements?.items[0].status,
    ).toBe("done");
    expect(screen.getByRole("dialog").parentElement).toHaveClass(
      "reelterminal-desktop",
    );
  });
});
