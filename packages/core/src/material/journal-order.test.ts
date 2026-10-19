import { describe, expect, it } from "vitest";
import { buildMaterialJournalEntry } from "./logic";
import { latestMaterialJournalEntry, materialJournalWindow, normalizeMaterialJournalOrder } from "./journal-order";
import type { MaterialJournalEntry } from "./types";
const row = (id: string, order?: MaterialJournalEntry["order"]): MaterialJournalEntry => ({
  ...buildMaterialJournalEntry({ id, actor: "user", label: id, changes: [], nowIso: "2026-10-19T00:00:00.000Z" }),
  ...(order ? { order } : {}),
});
describe("material journal proven ordering", () => {
  it("does not treat invalid or contradictory metadata as commit order", () => {
    for (const value of [undefined, null, {}, { sequence: 0 }, { sequence: -1 }, { sequence: 1.2 },
      { sequence: Infinity }, { sequence: 1, legacyBefore: 2 }]) expect(normalizeMaterialJournalOrder(value)).toBeUndefined();
    expect(normalizeMaterialJournalOrder({ sequence: 1 })).toEqual({ sequence: 1 });
    expect(normalizeMaterialJournalOrder({ legacyBefore: 2 })).toEqual({ legacyBefore: 2 });
  });
  it("requires a unique provably latest entry instead of timestamp or ID guesses", () => {
    const legacy = row("legacy", { legacyBefore: 2 }), old = row("old", { sequence: 1 }), next = row("next", { sequence: 2 });
    expect(latestMaterialJournalEntry([legacy, old]).ambiguous).toBe(true);
    expect(latestMaterialJournalEntry([legacy, old, next]).entry?.id).toBe("next");
    expect(latestMaterialJournalEntry([next, row("unplaced")]).ambiguous).toBe(true);
    expect(latestMaterialJournalEntry([next, row("duplicate", { sequence: 2 })]).ambiguous).toBe(true);
    expect(latestMaterialJournalEntry([legacy]).entry?.id).toBe("legacy");
  });
  it("does not split uncertain legacy at the window cutoff or reclaim corrupt duplicate order", () => {
    const legacy = row("legacy", { legacyBefore: 2 }), old = row("old", { sequence: 1 });
    const two = row("two", { sequence: 2 }), three = row("three", { sequence: 3 });
    expect(materialJournalWindow([legacy, old, two], 2).evicted).toEqual([]);
    expect(materialJournalWindow([legacy, old, two, three], 2).evicted.map(entry => entry.id).sort()).toEqual(["legacy", "old"]);
    expect(materialJournalWindow([two, three, row("duplicate", { sequence: 3 })], 1).evicted).toEqual([]);
  });
});
