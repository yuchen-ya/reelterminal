import { expect, test } from "vitest";
import { saturateHistory } from "./history-saturation";

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
