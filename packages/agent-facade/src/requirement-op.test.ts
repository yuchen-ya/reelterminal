import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./project-factory";
import { opToCoreActions, validateEditOp } from "./ops";

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
        patch: { status: "done", agentNote: "Imported", resultMediaIds: ["audio-1"] },
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
});
