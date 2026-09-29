import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionExecutor, ActionHistory } from "@reelterminal/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { REQUIREMENT_BOARD_MODAL_ID, RequirementBoardDialog } from "./RequirementBoardDialog";

describe("RequirementBoardDialog", () => {
  beforeEach(() => {
    const history = new ActionHistory();
    useProjectStore.setState({
      project: createEmptyProject("Board"),
      hasOpenProject: true,
      actionHistory: history,
      actionExecutor: new ActionExecutor(history),
    });
    useUIStore.setState({ activeModal: REQUIREMENT_BOARD_MODAL_ID });
  });

  it("persists a ready requirement and exposes its stable Q number", async () => {
    render(<RequirementBoardDialog />);
    fireEvent.change(screen.getByPlaceholderText("Describe the outcome in one line"), {
      target: { value: "Tighten the opening" },
    });
    fireEvent.change(screen.getByPlaceholderText("Add editing requirements, goals, and constraints…"), {
      target: { value: "Remove the pause before the first line." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish to board" }));

    await waitFor(() => expect(useProjectStore.getState().project.requirements?.items).toHaveLength(1));
    expect(useProjectStore.getState().project.requirements?.items[0]).toMatchObject({
      number: 1,
      title: "Tighten the opening",
      status: "ready",
    });
    expect(screen.getByText("Q1")).toBeInTheDocument();
  });
});
