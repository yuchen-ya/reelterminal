import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FontDependencyReference } from "./workspace-manager";

const workspace = vi.hoisted(() => ({
  getFontDependencyReferences: vi.fn(async (_family: string) => [] as FontDependencyReference[]),
}));

vi.mock("./workspace-manager", () => ({ workspaceManager: workspace }));

import { getFontDependencyReferences } from "./project-dependencies";

describe("font dependency references", () => {
  beforeEach(() => workspace.getFontDependencyReferences.mockReset());

  it("delegates the family query to the workspace manager singleton", async () => {
    const references: FontDependencyReference[] = [
      {
        family: "custom font",
        projectId: "p1",
        kind: "node",
        referenceId: "node-1",
        label: "Saved cut",
      },
      {
        family: "custom font",
        projectId: "p2",
        kind: "history",
        referenceId: "workspace-2",
      },
    ];
    workspace.getFontDependencyReferences.mockResolvedValue(references);

    expect(await getFontDependencyReferences("Custom Font")).toEqual(references);
    expect(workspace.getFontDependencyReferences).toHaveBeenCalledTimes(1);
    expect(workspace.getFontDependencyReferences).toHaveBeenCalledWith("Custom Font");
  });
});
