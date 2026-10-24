import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WorkspaceModeTabs } from "./WorkspaceModeTabs";

describe("WorkspaceModeTabs", () => {
  it("renders the two workspace modes and reports selection", () => {
    const onSelectMode = vi.fn();

    render(
      <WorkspaceModeTabs
        activeMode="video"
        ariaLabel="Editor workspaces"
        onSelectMode={onSelectMode}
      />,
    );

    expect(screen.getByRole("tab", { name: "Video Editor" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("tab", { name: "Review Workspace" }),
    ).toHaveAttribute("aria-selected", "false");

    expect(screen.queryByRole("tab", { name: "Motion Design" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Review Workspace" }));

    expect(onSelectMode).toHaveBeenCalledWith("workbench");
  });
});
