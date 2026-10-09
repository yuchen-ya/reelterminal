import { describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  getDependencyProjectSnapshots: vi.fn(async () => [{
    projectId: "p1",
    kind: "node",
    referenceId: "node-1",
    project: { textClips: [{ style: { fontFamily: "Saved Font" } }] },
  }]),
}));

vi.mock("../../../services/workspace-manager", () => ({ workspaceManager: workspace }));

describe("custom font retention", () => {
  it("prevents removing a font referenced by a saved node", async () => {
    vi.resetModules();
    const { removeCustomFont } = await import("./font-options");

    await expect(removeCustomFont("Saved Font"))
      .rejects.toThrow(/cannot remove font .* node node-1 in project p1/i);
    expect(workspace.getDependencyProjectSnapshots).toHaveBeenCalled();
  });
});
