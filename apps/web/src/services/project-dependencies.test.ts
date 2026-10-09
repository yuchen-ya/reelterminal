import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  getDependencyProjectSnapshots: vi.fn(async () => [] as Array<Record<string, unknown>>),
}));

vi.mock("./workspace-manager", () => ({ workspaceManager: workspace }));

import { getFontDependencyReferences } from "./project-dependencies";

describe("font dependency references", () => {
  beforeEach(() => workspace.getDependencyProjectSnapshots.mockReset());

  it("checks saved project roots and undo history before allowing removal", async () => {
    workspace.getDependencyProjectSnapshots.mockResolvedValue([
      {
        projectId: "p1",
        kind: "node",
        referenceId: "node-1",
        label: "Saved cut",
        project: { textClips: [{ style: { fontFamily: "Custom Font" } }] },
      },
      {
        projectId: "p2",
        kind: "history",
        referenceId: "workspace-2",
        label: "Runtime history",
        project: { textClips: [] },
        historyEntries: [{ params: { fontFamily: "Custom Font" } }],
      },
      {
        projectId: "p3",
        kind: "node",
        referenceId: "unrelated-node",
        project: { textClips: [{ style: { fontFamily: "Other Font" } }] },
      },
    ]);

    const references = await getFontDependencyReferences("custom font");

    expect(references).toEqual([
      expect.objectContaining({
        family: "custom font",
        projectId: "p1",
        kind: "node",
        referenceId: "node-1",
      }),
      expect.objectContaining({
        family: "custom font",
        projectId: "p2",
        kind: "history",
        referenceId: "workspace-2",
      }),
    ]);
  });
});
