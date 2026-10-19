import type { MaterialJournalEntry } from "./types";

export function normalizeMaterialJournalOrder(value: unknown): MaterialJournalEntry["order"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const valid = (number: unknown): number is number => Number.isSafeInteger(number) && (number as number) > 0;
  if (valid(raw.sequence) && raw.legacyBefore === undefined) return { sequence: raw.sequence };
  if (valid(raw.legacyBefore) && raw.sequence === undefined) return { legacyBefore: raw.legacyBefore };
  return undefined;
}

/** Stable presentation only for incomparable legacy rows. Undo and eviction
 * below use proven ordering relationships, never the timestamp/ID fallback. */
export function sortMaterialJournal(entries: readonly MaterialJournalEntry[]): MaterialJournalEntry[] {
  const position = (entry: MaterialJournalEntry) => entry.order
    ? ("sequence" in entry.order ? entry.order.sequence : entry.order.legacyBefore)
    : Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => position(a) - position(b)
    || Number(Boolean(a.order && "sequence" in a.order)) - Number(Boolean(b.order && "sequence" in b.order))
    || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function latestMaterialJournalEntry(entries: readonly MaterialJournalEntry[]):
  { readonly entry: MaterialJournalEntry | undefined; readonly ambiguous: boolean } {
  const active = entries.filter(entry => !entry.undone);
  if (active.length < 2) return { entry: active[0], ambiguous: false };
  const exact = active.filter(entry => entry.order && "sequence" in entry.order);
  const last = exact.sort((a, b) => (b.order as { sequence: number }).sequence - (a.order as { sequence: number }).sequence)[0];
  if (!last || !last.order || !("sequence" in last.order)) return { entry: undefined, ambiguous: true };
  const sequence = last.order.sequence;
  if (active.some(entry => !entry.order || ("legacyBefore" in entry.order && entry.order.legacyBefore > sequence))
      || exact.filter(entry => (entry.order as { sequence: number }).sequence === sequence).length !== 1) {
    return { entry: undefined, ambiguous: true };
  }
  return { entry: last, ambiguous: false };
}

/** Keep uncertain legacy rows until at least `limit` known commits prove they
 * are outside the window. This can temporarily retain extra old rows/bytes. */
export function materialJournalWindow(entries: readonly MaterialJournalEntry[], limit: number):
  { kept: MaterialJournalEntry[]; evicted: MaterialJournalEntry[] } {
  const ordered = sortMaterialJournal(entries);
  const sequences = entries.flatMap(entry => entry.order && "sequence" in entry.order ? [entry.order.sequence] : []).sort((a, b) => a - b);
  if (new Set(sequences).size !== sequences.length) return { kept: ordered, evicted: [] };
  const laterCount = (boundary: number, inclusive: boolean) => {
    let low = 0, high = sequences.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sequences[middle] < boundary || (!inclusive && sequences[middle] === boundary)) low = middle + 1;
      else high = middle;
    }
    return sequences.length - low;
  };
  const kept: MaterialJournalEntry[] = [], evicted: MaterialJournalEntry[] = [];
  for (const entry of ordered) {
    const order = entry.order;
    const later = !order ? 0 : "sequence" in order
      ? laterCount(order.sequence, false) : laterCount(order.legacyBefore, true);
    (later >= limit ? evicted : kept).push(entry);
  }
  return { kept, evicted };
}
