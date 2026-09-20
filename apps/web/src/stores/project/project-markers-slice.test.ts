import { describe, it, expect, beforeEach, vi } from "vitest";
import { normalizeProjectStoredFields } from "@reelterminal/core";
import { useProjectStore } from "../project-store";

vi.mock("../../bridges/effects-bridge", () => ({
  getEffectsBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => false),
  })),
}));

vi.mock("../../bridges/transition-bridge", () => ({
  getTransitionBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => false),
  })),
}));

const pointTarget = (time: number) =>
  ({ kind: "timeRange", start: time, end: time }) as const;

const markersState = () => useProjectStore.getState().project.markers;
const markerNumbers = () =>
  (markersState()?.items ?? []).map((marker) => marker.number);

describe("project-markers-slice", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
  });

  it("assigns stable numbers 1, 2, 3 on successive adds", async () => {
    const store = useProjectStore.getState();

    const first = await store.addProjectMarker(pointTarget(1));
    const second = await store.addProjectMarker(pointTarget(2));
    const third = await store.addProjectMarker(pointTarget(3));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(third.success).toBe(true);
    expect(markerNumbers()).toEqual([1, 2, 3]);
    expect(markersState()?.nextNumber).toBe(4);

    const [marker] = markersState()!.items;
    expect(marker.id).toMatch(/^marker-/);
    expect(marker.color).toBe("#f59e0b");
    expect(marker.createdAt).toBeGreaterThan(0);
    expect(marker.target).toEqual({ kind: "timeRange", start: 1, end: 1 });
  });

  it("removes a marker by its number without retiring nextNumber", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1));
    await store.addProjectMarker(pointTarget(2));
    await store.addProjectMarker(pointTarget(3));

    const result = await store.removeProjectMarker(2);

    expect(result.success).toBe(true);
    expect(markerNumbers()).toEqual([1, 3]);
    expect(markersState()?.nextNumber).toBe(4);
  });

  it("fails removal of an unknown number listing the assigned numbers", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1));
    await store.addProjectMarker(pointTarget(2));
    await store.removeProjectMarker(1);

    const result = await store.removeProjectMarker(99);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("no marker with number 99");
    expect(result.error?.message).toContain("2");
    expect(result.error?.details).toEqual({
      number: 99,
      assignedNumbers: [2],
    });
  });

  it("reports (none) when no markers are assigned at all", async () => {
    const result = await useProjectStore.getState().removeProjectMarker(1);

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("(none)");
    expect(result.error?.details).toEqual({
      number: 1,
      assignedNumbers: [],
    });
  });

  it("never reuses a number after remove + add", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1));
    await store.addProjectMarker(pointTarget(2));
    await store.removeProjectMarker(2);

    await store.addProjectMarker(pointTarget(5));

    expect(markerNumbers()).toEqual([1, 3]);
    expect(markersState()?.nextNumber).toBe(4);
  });

  it("keeps numbers stable through undo/redo of add", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1));
    await store.addProjectMarker(pointTarget(2));

    const undo = await store.undo();
    expect(undo.success).toBe(true);
    expect(markerNumbers()).toEqual([1]);

    const redo = await store.redo();
    expect(redo.success).toBe(true);
    expect(markerNumbers()).toEqual([1, 2]);
    expect(markersState()?.nextNumber).toBe(3);
  });

  it("restores the same number on undo of remove", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1));
    await store.addProjectMarker(pointTarget(2));
    await store.removeProjectMarker(2);
    expect(markerNumbers()).toEqual([1]);

    const undo = await store.undo();
    expect(undo.success).toBe(true);
    expect(markerNumbers()).toEqual([1, 2]);

    // A subsequent add must still skip the restored number.
    await store.addProjectMarker(pointTarget(7));
    expect(markerNumbers()).toEqual([1, 2, 3]);
  });

  it("survives a simulated save/load round trip", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(1.5));
    await store.addProjectMarker({ kind: "timeRange", start: 2, end: 4 });
    await store.removeProjectMarker(1);
    await store.addProjectMarker(pointTarget(9));

    const stored = JSON.parse(
      JSON.stringify(useProjectStore.getState().project),
    );
    const normalized = normalizeProjectStoredFields(stored);
    useProjectStore.getState().loadProject(normalized);

    const markers = markersState();
    expect(markers?.items.map((marker) => marker.number)).toEqual([2, 3]);
    expect(markers?.nextNumber).toBe(4);
    expect(markers?.items[0].target).toEqual({
      kind: "timeRange",
      start: 2,
      end: 4,
    });
    expect(markers?.items[1].target).toEqual({
      kind: "timeRange",
      start: 9,
      end: 9,
    });
  });

  it("defaults markers state when loading a project without the field", async () => {
    const store = useProjectStore.getState();
    await store.addProjectMarker(pointTarget(3));

    const stored = JSON.parse(
      JSON.stringify(useProjectStore.getState().project),
    );
    delete stored.markers;
    const normalized = normalizeProjectStoredFields(stored);
    useProjectStore.getState().loadProject(normalized);

    expect(markersState()).toEqual({ nextNumber: 1, items: [] });

    // Numbering restarts cleanly for a project that never had markers.
    await useProjectStore.getState().addProjectMarker(pointTarget(0.5));
    expect(markerNumbers()).toEqual([1]);
  });
});
