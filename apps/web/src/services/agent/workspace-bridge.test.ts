import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { workspaceManager, WorkspaceManagerError } from "../workspace-manager";
import { failureCode, handleWorkspaceLibraryRequest } from "./workspace-bridge";
import { codedError } from "./bridge-error";

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
  const MUTATED = "the flox was bruffled while nobody was looking";

  it("classifies manager errors by code even when the message text is mutated", () => {
    expect(failureCode(new WorkspaceManagerError("CONFLICT", MUTATED, { expected: 1 }))).toBe("CONFLICT");
    expect(failureCode(new WorkspaceManagerError("NOT_FOUND", MUTATED, { id: "x" }))).toBe("NOT_FOUND");
    expect(failureCode(new WorkspaceManagerError("INVALID_PARAMS", MUTATED))).toBe("INVALID_PARAMS");
    // Duck-typed coded errors (the bridge's own guard throws) classify too.
    expect(failureCode(codedError("INVALID_PARAMS", "projectId is required"))).toBe("INVALID_PARAMS");
    expect(failureCode(codedError("NOT_FOUND", `Unknown node node-1`))).toBe("NOT_FOUND");
  });

  it("surfaces manager conflicts through handleWorkspaceLibraryRequest by code", async () => {
    const created = await workspaceManager.createProject(createEmptyProject("Coded conflict"));
    const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
    const reply = await handleWorkspaceLibraryRequest("node.save", {
      ...target,
      expectedRevision: created.revision + 5,
      idempotencyKey: "coded-conflict-save",
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: expect.stringContaining("Workspace revision conflict") },
    });
  });

  it("no longer classifies uncoded errors by message shape", () => {
    for (const message of [
      "workspace revision mismatch: expected 3, current 5",
      "workspace changed while preparing the action batch",
      "workspace runtime changed before the batch was persisted",
      "idempotency key k was already committed with a different payload",
      "unknown node node-1",
      "recovery draft not found",
      "node does not belong to this project",
      "projectId is required",
      "root node cannot be deleted",
      "checksum does not match",
    ]) {
      expect(failureCode(new Error(message))).toBe("BRIDGE_ERROR");
      expect(failureCode(message)).toBe("BRIDGE_ERROR");
    }
  });

  it("keeps the plain project-media-gc failures classified (module has no codes yet)", () => {
    expect(failureCode(new Error("Version node was not found in this project"))).toBe("NOT_FOUND");
    expect(failureCode(new Error("Cleanup project does not match the reviewed plan"))).toBe("INVALID_PARAMS");
    expect(failureCode(new Error("Both version nodes must belong to the requested project"))).toBe("INVALID_PARAMS");
    // Its uncoded failures were BRIDGE_ERROR before and stay BRIDGE_ERROR.
    expect(failureCode(new Error("Cleanup plan is unknown, expired, or was modified after review"))).toBe("BRIDGE_ERROR");
    expect(failureCode(new Error("Cleanup plan is unknown or expired; create a fresh plan before execution"))).toBe("BRIDGE_ERROR");
  });

  it("never misclassifies ordinary failures as retryable conflicts", () => {
    expect(failureCode(new Error("disk write failed"))).toBe("BRIDGE_ERROR");
  });
});
