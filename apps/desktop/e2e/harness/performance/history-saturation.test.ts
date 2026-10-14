import { expect, test, vi } from "vitest";
import { saturateHistory, HISTORY_WARMUP_INTERVAL_MS } from "./history-saturation";
import { ActionHistory } from "../../../../../packages/core/src/actions/action-history";

test("real production rapid grouping can exceed the cap; spaced warmup reaches ten bounded independent units", async () => {
  let clock = 10_000;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const exercise = async (spaced: boolean) => {
    const history = new ActionHistory(7);
    return saturateHistory(async () => ({ actionCapacity: history.getMaxHistorySize(), actionUndo: history.getUndoStackSize() }), async (index) => {
      clock += 50; // Fast hosted IPC can keep all moves in one proximity group.
      history.pushGroup([{ action: { type: "clip/move", id: `move-${index}`, timestamp: clock, params: { clipId: "fixed", newStartTime: index % 2 } }, inverseAction: null }], "real edit", "agent");
    }, spaced ? async () => { clock += HISTORY_WARMUP_INTERVAL_MS; } : undefined);
  };
  try {
    await expect(exercise(false)).rejects.toThrow("observed=8");
    const result = await exercise(true);
    expect(result.capacity).toBe(7);
    expect(result.plateauCounts).toEqual(Array(10).fill(7));
  } finally { now.mockRestore(); }
});

test("uses the live capacity and requires ten further edits at that capacity", async () => {
  let undo = 2;
  let edits = 0;
  const result = await saturateHistory(async () => ({ actionCapacity: 7, actionUndo: undo }), async () => { edits++; undo = Math.min(7, undo + 1); });
  expect(edits).toBe(15);
  expect(result).toEqual({ capacity: 7, edits: 15, plateauCounts: Array(10).fill(7) });
});

test("rejects growing retention and capacity changes before observation starts", async () => {
  let undo = 0;
  await expect(saturateHistory(async () => ({ actionCapacity: 3, actionUndo: undo }), async () => { undo++; })).rejects.toThrow("stable history");
  let reads = 0;
  await expect(saturateHistory(async () => ({ actionCapacity: ++reads === 1 ? 3 : 4, actionUndo: 3 }), async () => {})).rejects.toThrow("stable history");
});
