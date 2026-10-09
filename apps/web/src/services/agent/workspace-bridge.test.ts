import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { workspaceManager } from "../workspace-manager";
import { handleWorkspaceLibraryRequest } from "./workspace-bridge";

describe("workspace node query bridge", () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("keeps node listings lightweight and reads full snapshots on demand", async () => {
    const created = await workspaceManager.createProject(createEmptyProject("Node query"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await workspaceManager.saveNode({
      target,
      expectedRevision: created.revision,
      idempotencyKey: "node-query-save",
    });

    const listing = await handleWorkspaceLibraryRequest("node.list", { projectId: target.projectId });
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const nodes = (listing.result as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: saved.node.id, projectId: target.projectId });
    expect(nodes[0]).not.toHaveProperty("project");

    const detail = await handleWorkspaceLibraryRequest("node.get", {
      projectId: target.projectId,
      nodeId: saved.node.id,
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.result).toMatchObject({
        projectId: target.projectId,
        node: { id: saved.node.id, project: { id: target.projectId } },
      });
    }
  });
});
