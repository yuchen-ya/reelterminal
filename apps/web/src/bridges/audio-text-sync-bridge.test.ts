import { describe, it, expect, beforeEach, vi } from "vitest";
import { getBeatSyncBridge, BeatSyncBridge } from "./audio-text-sync-bridge";

const { storeMock } = vi.hoisted(() => ({
  storeMock: {
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    getClip: vi.fn(),
    actionHistory: {
      beginGroup: vi.fn(),
      endGroup: vi.fn(),
    },
  },
}));

vi.mock("../stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(() => storeMock),
  },
}));

/** Seed the private preview timings the apply path consumes. */
function seedTimings(bridge: BeatSyncBridge, count: number): void {
  (bridge as unknown as { setState: (u: object) => void }).setState({
    previewTimings: Array.from({ length: count }, (_, i) => ({
      clipId: `clip-${i}`,
      originalStartTime: i * 2,
      originalDuration: 1.5,
      newStartTime: i * 0.5,
      newDuration: 1,
    })),
  });
}

describe("BeatSyncBridge applySync undo grouping", () => {
  let bridge: BeatSyncBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new BeatSyncBridge();
    storeMock.moveClip.mockResolvedValue({ success: true });
    storeMock.trimClip.mockResolvedValue({ success: true });
    storeMock.getClip.mockImplementation((clipId: string) => ({
      id: clipId,
      inPoint: 0,
      startTime: 0,
      duration: 1.5,
    }));
  });

  const beginGroup = storeMock.actionHistory.beginGroup;
  const endGroup = storeMock.actionHistory.endGroup;

  it("wraps every move/trim of the batch in ONE beginGroup/endGroup pair", async () => {
    seedTimings(bridge, 3);
    const order: string[] = [];
    beginGroup.mockImplementation(() => order.push("begin"));
    storeMock.moveClip.mockImplementation(async () => {
      order.push("move");
      return { success: true };
    });
    storeMock.trimClip.mockImplementation(async () => {
      order.push("trim");
      return { success: true };
    });
    endGroup.mockImplementation(() => order.push("end"));

    const ok = await bridge.applySync();

    expect(ok).toBe(true);
    expect(order[0]).toBe("begin");
    expect(order[order.length - 1]).toBe("end");
    expect(order.filter((step) => step === "begin")).toHaveLength(1);
    expect(order.filter((step) => step === "end")).toHaveLength(1);
    // All clip edits happen strictly inside the group.
    const firstEdit = order.indexOf("move");
    const lastEdit = order.lastIndexOf("trim");
    expect(firstEdit).toBeGreaterThan(0);
    expect(lastEdit).toBeLessThan(order.length - 1);
    expect(storeMock.moveClip).toHaveBeenCalledTimes(3);
    expect(storeMock.trimClip).toHaveBeenCalledTimes(3);
  });

  it("still closes the group when a clip edit fails mid-batch", async () => {
    seedTimings(bridge, 2);
    storeMock.moveClip.mockRejectedValueOnce(new Error("overlap"));

    const ok = await bridge.applySync();

    expect(ok).toBe(false);
    expect(bridge.getState().error).toContain("overlap");
    expect(endGroup).toHaveBeenCalledTimes(1);
  });

  it("skips trims in preserve-duration mode but keeps the grouping", async () => {
    bridge.updateConfig({ syncMode: "preserve-duration" });
    seedTimings(bridge, 2);

    const ok = await bridge.applySync();

    expect(ok).toBe(true);
    expect(storeMock.moveClip).toHaveBeenCalledTimes(2);
    expect(storeMock.trimClip).not.toHaveBeenCalled();
    expect(beginGroup).toHaveBeenCalledTimes(1);
    expect(endGroup).toHaveBeenCalledTimes(1);
  });

  it("does not open a group when there is nothing to sync", async () => {
    const ok = await bridge.applySync();
    expect(ok).toBe(false);
    expect(beginGroup).not.toHaveBeenCalled();
    expect(endGroup).not.toHaveBeenCalled();
  });

  it("the shared singleton exposes the same behavior", async () => {
    expect(getBeatSyncBridge()).toBeInstanceOf(BeatSyncBridge);
  });
});
