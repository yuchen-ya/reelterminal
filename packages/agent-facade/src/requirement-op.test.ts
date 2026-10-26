import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./project-factory";
import { opToCoreActions, validateEditOp } from "./ops";
import { requirementsListView } from "./requirements";

describe("requirement.update edit op", () => {
  it("resolves a Q reference and translates progress/result fields", () => {
    const project = createEmptyProject("Requirements");
    (project as { requirements?: unknown }).requirements = {
      nextNumber: 2,
      items: [{
        id: "requirement-internal",
        number: 1,
        title: "Generate music",
        description: "Ten seconds",
        priority: "normal",
        status: "ready",
        markerIds: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    (project.mediaLibrary.items as unknown[]).push({ id: "audio-1" });

    const op = validateEditOp({
      op: "requirement.update",
      requirementId: "Q1",
      status: "done",
      agentNote: "Imported",
      resultMediaIds: ["audio-1"],
    }, 0);
    expect(opToCoreActions(op, project)).toMatchObject([{
      type: "requirement/update",
      params: {
        requirementId: "requirement-internal",
        patch: { status: "review", agentNote: "Imported", resultMediaIds: ["audio-1"] },
      },
    }]);
  });

  it("rejects empty updates and unknown result media", () => {
    expect(() => validateEditOp({ op: "requirement.update", requirementId: "Q1" }, 0))
      .toThrow(/at least one/);
    const project = createEmptyProject("Requirements");
    (project as { requirements?: unknown }).requirements = {
      nextNumber: 2,
      items: [{ id: "r1", number: 1, title: "One", description: "", priority: "normal", status: "ready", markerIds: [], createdAt: 1, updatedAt: 1 }],
    };
    const op = validateEditOp({ op: "requirement.update", requirementId: "Q1", resultMediaIds: ["missing"] }, 0);
    expect(() => opToCoreActions(op, project)).toThrow(/result media not found/);
  });

  it("lists cleanup bindings and advances cleanup phases one confirmed stage at a time", () => {
    const project = createEmptyProject("Cleanup requirements");
    const cleanupHandoff = {
      projectId: project.id,
      workspaceId: "workspace-cleanup",
      exportId: "export-cleanup",
      revision: 12,
      nodeIds: ["node-a", "node-b"],
      scope: "Selected outputs",
      retention: "Keep source project and shared media",
      phase: "pending_review" as const,
    };
    (project as { requirements?: unknown }).requirements = {
      nextNumber: 2,
      items: [{
        id: "cleanup-requirement",
        number: 1,
        title: "Review cleanup",
        description: "Review only",
        priority: "normal",
        status: "ready",
        markerIds: [],
        cleanupHandoff,
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    expect(requirementsListView(project.requirements!.items, 4, {}).requirements[0]?.cleanupHandoff)
      .toEqual(cleanupHandoff);

    const reviewing = validateEditOp({ op: "requirement.update", requirementId: "Q1", cleanupPhase: "reviewing" }, 0);
    expect(opToCoreActions(reviewing, project)).toMatchObject([{
      type: "requirement/update",
      params: { patch: { status: "in_progress", cleanupHandoff: { ...cleanupHandoff, phase: "reviewing" } } },
    }]);
    const cannotSkip = validateEditOp({ op: "requirement.update", requirementId: "Q1", cleanupPhase: "executing", confirmedExecution: true }, 0);
    expect(() => opToCoreActions(cannotSkip, project)).toThrow(/one stage at a time/);
    const cannotExecute = validateEditOp({ op: "requirement.update", requirementId: "Q1", cleanupPhase: "reviewing" }, 0);
    const afterReview = { ...project, requirements: { nextNumber: 2, items: [{ ...project.requirements!.items[0]!, cleanupHandoff: { ...cleanupHandoff, phase: "awaiting_confirmation" as const } }] } };
    const execute = validateEditOp({ op: "requirement.update", requirementId: "Q1", cleanupPhase: "executing", confirmedExecution: true }, 0);
    expect(opToCoreActions(execute, afterReview)).toMatchObject([{
      type: "requirement/update",
      params: { patch: { status: "in_progress", cleanupHandoff: { phase: "executing" } } },
    }]);
    expect(() => opToCoreActions(cannotExecute, project)).not.toThrow();
    expect(() => validateEditOp({ op: "requirement.update", requirementId: "Q1", cleanupPhase: "executing" }, 0)).toThrow(/confirmedExecution/);
  });
});
