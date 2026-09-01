import { describe, it, expect, beforeEach } from "vitest";
import type { Action } from "@openreel/core";
import { useProjectStore, getProjectRevision } from "./project-store";

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

describe("projectRevision (ADR 0004 Decision 3)", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
  });

  it("starts as a number and is exposed via getProjectRevision()", () => {
    expect(typeof useProjectStore.getState().projectRevision).toBe("number");
    expect(getProjectRevision()).toBe(
      useProjectStore.getState().projectRevision,
    );
  });

  it("bumps by exactly 1 on a manual store edit", async () => {
    const before = getProjectRevision();
    const result = await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    expect(result.success).toBe(true);
    expect(getProjectRevision()).toBe(before + 1);
  });

  it("bumps on undo", async () => {
    await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    const before = getProjectRevision();
    const result = await useProjectStore.getState().undo();
    expect(result.success).toBe(true);
    expect(getProjectRevision()).toBe(before + 1);
  });

  it("bumps on redo", async () => {
    await useProjectStore
      .getState()
      .executeAction(act("track/add", { trackType: "video" }));
    await useProjectStore.getState().undo();
    const before = getProjectRevision();
    const result = await useProjectStore.getState().redo();
    expect(result.success).toBe(true);
    expect(getProjectRevision()).toBe(before + 1);
  });

  it("does NOT bump for non-project state sets", () => {
    const before = getProjectRevision();
    useProjectStore.setState({ isLoading: true, error: "x" });
    useProjectStore.setState({ isLoading: false, error: null });
    expect(getProjectRevision()).toBe(before);
  });

  it("does NOT bump when executeAction fails (no committed mutation)", async () => {
    const before = getProjectRevision();
    const result = await useProjectStore
      .getState()
      .executeAction(act("clip/remove", { clipId: "does-not-exist" }));
    expect(result.success).toBe(false);
    expect(getProjectRevision()).toBe(before);
  });
});
