import { describe, expect, it } from "vitest";
import type { Action, Project, ProjectRequirement } from "../types";
import { ActionExecutor } from "./action-executor";
import { ActionHistory } from "./action-history";

function project(): Project {
  return {
    id: "p1",
    name: "Requirements",
    createdAt: 1,
    modifiedAt: 1,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48_000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
  };
}

const requirement: ProjectRequirement = {
  id: "requirement-1",
  number: 1,
  title: "Tighten opening",
  description: "Remove the pause before the first line.",
  priority: "normal",
  status: "ready",
  markerIds: [],
  createdAt: 10,
  updatedAt: 10,
};

function action(type: Action["type"], params: Action["params"]): Action {
  return { type, params, id: crypto.randomUUID(), timestamp: Date.now() } as Action;
}

describe("project requirement actions", () => {
  it("adds, updates and removes requirements while preserving the Q watermark", async () => {
    const value = project();
    const executor = new ActionExecutor();
    expect((await executor.execute(action("requirement/add", { requirement }), value)).success).toBe(true);
    expect(value.requirements).toMatchObject({ nextNumber: 2, items: [{ status: "ready" }] });
    expect((await executor.execute(action("requirement/update", { requirementId: requirement.id, patch: { status: "done", agentNote: "Finished" } }), value)).success).toBe(true);
    expect(value.requirements?.items[0]).toMatchObject({ status: "done", agentNote: "Finished" });
    expect((await executor.execute(action("requirement/remove", { requirementId: requirement.id }), value)).success).toBe(true);
    expect(value.requirements).toEqual({ nextNumber: 2, items: [] });
  });

  it("restores the complete prior requirement on undo", async () => {
    const value = project();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    await executor.execute(action("requirement/add", { requirement }), value);
    await executor.execute(action("requirement/update", { requirementId: requirement.id, patch: { status: "blocked", agentNote: "Need input" } }), value);
    expect(value.requirements?.items[0].status).toBe("blocked");
    expect((await executor.undo(value)).success).toBe(true);
    expect(value.requirements?.items[0]).toEqual(requirement);
  });
  it("rejects malformed object references at the action boundary", async () => {
    const value = project();
    const executor = new ActionExecutor();
    const result = await executor.execute(action("requirement/add", { requirement: { ...requirement, references: [{ ref: "A1", kind: "media", entityId: "", label: "Bad", timing: { startSeconds: null, endSeconds: null } }] } }), value);
    expect(result.success).toBe(false);
    expect(value.requirements?.items ?? []).toHaveLength(0);
  });

});
