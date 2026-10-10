import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { workspaceManager } from "../workspace-manager";
import { failureCode, handleWorkspaceLibraryRequest } from "./workspace-bridge";

describe("workspace node query bridge", () => {
  beforeAll(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  it("returns the allocated name and full target IDs when an Agent creates a same-name project", async () => {
    await workspaceManager.createProject(createEmptyProject("Agent cut"));
    const project = createEmptyProject("Agent cut");
    const reply = await handleWorkspaceLibraryRequest("project.create", { project });
    expect(reply).toMatchObject({
      ok: true,
      result: {
        projectId: project.id,
        defaultWorkspaceId: expect.any(String),
        project: { id: project.id, name: "Agent cut 2" },
      },
    });
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

  it("renames a node through the bridge (mutating verb)", async () => {
    const created = await workspaceManager.createProject(createEmptyProject("Node rename"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const saved = await workspaceManager.saveNode({
      target,
      expectedRevision: created.revision,
      idempotencyKey: "node-rename-setup",
    });

    const reply = await handleWorkspaceLibraryRequest("node.rename", {
      projectId: target.projectId,
      nodeId: saved.node.id,
      name: "Renamed node",
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result).toMatchObject({
      projectId: target.projectId,
      nodeId: saved.node.id,
      node: { id: saved.node.id, name: "Renamed node" },
    });
  });
});

describe("failureCode classification", () => {
  it.each([
    ["revision conflict while committing the batch", "CONFLICT"],
    ["workspace revision mismatch: expected 3, current 5", "CONFLICT"],
    ["workspace changed while preparing the action batch", "CONFLICT"],
    ["workspace runtime changed before the batch was persisted", "CONFLICT"],
    ["idempotency key k was already committed with a different payload", "CONFLICT"],
    ["input was already retained with different metadata", "CONFLICT"],
    ["unknown node node-1", "NOT_FOUND"],
    ["unknown workspace ws-1", "NOT_FOUND"],
    ["recovery draft not found", "NOT_FOUND"],
    ["node does not belong to this project", "NOT_FOUND"],
    ["projectId is required", "INVALID_PARAMS"],
    ["expectedRevision must be a non-negative integer", "INVALID_PARAMS"],
    ["root node cannot be deleted", "INVALID_PARAMS"],
    ["checksum does not match", "INVALID_PARAMS"],
    // Branch order decides: NOT_FOUND keywords are tested before
    // INVALID_PARAMS, so a message carrying both classifies as NOT_FOUND
    // even though "required" also appears (incidentally in "draft-required").
    ["the required snapshot was not found", "NOT_FOUND"],
    ["node draft-required does not belong to this workspace", "NOT_FOUND"],
    ["the storage engine gave up for an unrelated reason", "BRIDGE_ERROR"],
  ])("classifies %j as %s", (message, expected) => {
    expect(failureCode(new Error(message))).toBe(expected);
    // Plain string rejections take the same path as Error instances.
    expect(failureCode(message)).toBe(expected);
  });
});
