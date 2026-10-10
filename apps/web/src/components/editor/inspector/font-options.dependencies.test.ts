import { describe, expect, it, vi } from "vitest";
import type { FontDependencyReference } from "../../../services/workspace-manager";

const workspace = vi.hoisted(() => ({
  getFontDependencyReferences: vi.fn(async (_family: string) => [
    {
      family: "Saved Font",
      projectId: "p1",
      kind: "node" as const,
      referenceId: "node-1",
    } satisfies FontDependencyReference,
  ]),
}));

vi.mock("../../../services/workspace-manager", () => ({ workspaceManager: workspace }));

describe("custom font retention", () => {
  it("prevents removing a font referenced by a saved node", async () => {
    vi.resetModules();
    const { removeCustomFont } = await import("./font-options");

    await expect(removeCustomFont("Saved Font"))
      .rejects.toThrow(/cannot remove font .* node node-1 in project p1/i);
    expect(workspace.getFontDependencyReferences).toHaveBeenCalledWith("Saved Font");
  });
});
