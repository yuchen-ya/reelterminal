/** Advance real edits beyond the live capacity; never resize or clear history. */
export async function saturateHistory(
  read: () => Promise<{ actionCapacity: number; actionUndo: number }>,
  edit: (index: number) => Promise<void>,
): Promise<{ capacity: number; edits: number; plateauCounts: number[] }> {
  const initial = await read();
  const capacity = initial.actionCapacity;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("invalid live history capacity");
  const edits = capacity - initial.actionUndo + 10;
  if (edits < 10) throw new Error("history already exceeds live capacity");
  const plateauCounts: number[] = [];
  for (let index = 0; index < edits; index++) {
    await edit(index);
    if (index >= edits - 10) {
      const current = await read();
      if (current.actionCapacity !== capacity || current.actionUndo !== capacity) throw new Error("real edits did not reach a stable history capacity");
      plateauCounts.push(current.actionUndo);
    }
  }
  return { capacity, edits, plateauCounts };
}
