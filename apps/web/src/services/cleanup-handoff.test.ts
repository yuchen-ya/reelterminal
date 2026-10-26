import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyProject } from "../stores/project/project-helpers";
import { useProjectStore } from "../stores/project-store";
import {
  buildCleanupAgentPrompt,
  advanceCleanupReviewPhase,
  publishCleanupReview,
  type CleanupHandoffTarget,
} from "./cleanup-handoff";

const target: CleanupHandoffTarget = {
  projectId: "project-cleanup",
  workspaceId: "workspace-cleanup",
  exportId: "export-cleanup",
  revision: 8,
  scope: "Selected old export files",
  retention: "Keep the source project and all shared media",
};

describe("cleanup handoff", () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: { ...createEmptyProject("Cleanup"), id: target.projectId },
      hasOpenProject: true,
      workspaceId: target.workspaceId,
      workspaceRevision: 9,
    });
  });

  it("persists a review-only requirement bound to the exact project workspace and export", async () => {
    const published = await publishCleanupReview(target, ["node-b", "node-a"]);
    expect(published).toMatchObject({
      status: "ready",
      cleanupHandoff: {
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        exportId: target.exportId,
        revision: target.revision,
        nodeIds: ["node-b", "node-a"],
        phase: "pending_review",
      },
    });
    expect(useProjectStore.getState().project.requirements?.items).toHaveLength(1);
    expect(await publishCleanupReview(target, ["node-b", "node-a"])).toEqual(published);
    expect(useProjectStore.getState().project.requirements?.items).toHaveLength(1);
  });

  it("rejects a switched project or workspace instead of publishing into it", async () => {
    useProjectStore.setState({ workspaceId: "another-workspace" });
    await expect(publishCleanupReview(target, ["node-a"]))
      .rejects.toThrow("not the active project workspace");
    expect(useProjectStore.getState().project.requirements?.items ?? []).toHaveLength(0);
  });

  it("supports unexported targets and produces a review-only prompt without credential-like text", () => {
    const manualTarget: CleanupHandoffTarget = {
      ...target,
      exportId: undefined,
      scope: "review selected files",
      retention: "Keep source files; api_key=abc123secret",
    };
    const prompt = buildCleanupAgentPrompt(manualTarget, ["node-a"]);
    expect(prompt).toContain("Export ID: not bound to an export");
    expect(prompt).toContain("Source revision: 8");
    expect(prompt).toContain("Node IDs: node-a");
    expect(prompt).toContain("api_key=[redacted]");
    expect(prompt).not.toContain("abc123secret");
    expect(prompt).toContain("Review this cleanup request");
    expect(prompt).toContain("Do not delete, move, overwrite, or execute cleanup");
  });

  it("publishes an explicit workspace-level review when no nodes are selected", async () => {
    const workspaceTarget: CleanupHandoffTarget = {
      ...target,
      exportId: undefined,
      scope: "Rebuildable cache in this workspace",
      retention: "Keep project media and all source files",
    };
    const published = await publishCleanupReview(workspaceTarget, []);
    expect(published.title).toContain("workspace cleanup");
    expect(published.cleanupHandoff?.nodeIds).toEqual([]);
    expect(published.description).toContain("workspace-level scope; no node selected");
    const prompt = buildCleanupAgentPrompt(workspaceTarget, []);
    expect(prompt).toContain("workspace-level scope; no node selected");
    expect(prompt).toContain("Never interpret it as permission to scan or clean all projects");
  });

  it("advances lifecycle states in order and requires confirmation before execution", async () => {
    const published = await publishCleanupReview(target, ["node-a"]);
    await expect(advanceCleanupReviewPhase(target, ["node-a"], "awaiting_confirmation"))
      .rejects.toThrow("one step at a time");
    const reviewing = await advanceCleanupReviewPhase(target, ["node-a"], "reviewing");
    expect(reviewing.status).toBe("in_progress");
    const awaiting = await advanceCleanupReviewPhase(target, ["node-a"], "awaiting_confirmation");
    expect(awaiting.status).toBe("review");
    await expect(advanceCleanupReviewPhase(target, ["node-a"], "executing"))
      .rejects.toThrow("User confirmation of the exact cleanup proposal is required");
    const executing = await advanceCleanupReviewPhase(target, ["node-a"], "executing", {
      confirmedExecution: true,
    });
    expect(executing.status).toBe("in_progress");
    const retry = await advanceCleanupReviewPhase(target, ["node-a"], "awaiting_confirmation");
    expect(retry.cleanupHandoff?.phase).toBe("awaiting_confirmation");
    await expect(advanceCleanupReviewPhase(target, ["node-a"], "executing")).rejects.toThrow("User confirmation");
    await advanceCleanupReviewPhase(target, ["node-a"], "executing", { confirmedExecution: true });
    const completed = await advanceCleanupReviewPhase(target, ["node-a"], "completed");
    expect(completed.status).toBe("done");
    expect(completed.cleanupHandoff?.phase).toBe("completed");
    expect(published.cleanupHandoff?.phase).toBe("pending_review");
  });

  it("requires an explicit target, node selection, scope, and retention rule", async () => {
    await expect(publishCleanupReview({ ...target, scope: " " }, ["node-a"]))
      .rejects.toThrow("explicit scope and retention rule");
    await expect(publishCleanupReview(target, [""]))
      .rejects.toThrow("node ids cannot be empty strings");
    await expect(publishCleanupReview(target, ["node-a", "node-a"]))
      .rejects.toThrow("contains duplicates");
  });
});
