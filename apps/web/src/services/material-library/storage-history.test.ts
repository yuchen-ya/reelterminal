/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { applyMaterialUpdate, buildMaterialJournalEntry, buildMaterialRecord, latestMaterialJournalEntry,
  normalizeMaterialJournalEntry, type MaterialJournalEntry, type MaterialRecord } from "@reelterminal/core";
import { MaterialLibraryService } from "./library-service";
import { createIdbMaterialStorage, MATERIAL_LIBRARY_DB_NAME, MATERIAL_LIBRARY_DB_VERSION,
  MaterialStorageConflict, type MaterialStorage } from "./storage";

const NOW = "2026-10-19T12:00:00.000Z";
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function instruction(service: MaterialLibraryService, title = "Preview") {
  const result = await service.create({ kind: "instruction", title, prompt: "Show a sample" }, "user");
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}
function entry(id: string, before: MaterialRecord | null, after: MaterialRecord | null) {
  return buildMaterialJournalEntry({ id, actor: "user", label: id, nowIso: NOW,
    changes: [{ materialId: (after ?? before)!.id, before, after }] });
}

/** Seed a genuine old-format database, bypassing today's allocator only here. */
async function seedLegacy(storage: MaterialStorage, journal: readonly MaterialJournalEntry[],
  materials: readonly MaterialRecord[] = [], blob?: { id: string; blob: Blob }) {
  await storage.loadSnapshot();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(MATERIAL_LIBRARY_DB_NAME, MATERIAL_LIBRARY_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["materials", "journal", "blobs"], "readwrite");
      for (const row of journal) transaction.objectStore("journal").put(row);
      for (const row of materials) transaction.objectStore("materials").put(row);
      if (blob) transaction.objectStore("blobs").put(blob);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

describe("material history through actual IndexedDB transactions", () => {
  it("keeps the original reload/default-undo assertion under tied and backward clocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    const storage = createIdbMaterialStorage();
    const service = new MaterialLibraryService(storage);
    const created = await instruction(service);
    const updated = await service.update(created.material.id, { prompt: "Compare two samples" }, "user", created.material.revision);
    if (!updated.ok) throw new Error(updated.message);
    const before = await storage.loadSnapshot();
    expect(new Set((before.journal as MaterialJournalEntry[]).map(row => row.at)).size).toBe(1);
    const reloaded = new MaterialLibraryService(createIdbMaterialStorage());
    const undone = await reloaded.undo(undefined, "user");
    expect(undone).toMatchObject({ ok: true, value: { undoneEntryId: updated.value.journalEntryId } });
    expect(await reloaded.get(created.material.id)).toMatchObject({ ok: true, value: { prompt: "Show a sample" } });
    vi.setSystemTime("2000-01-01T00:00:00.000Z");
    const backward = await reloaded.update(created.material.id, { prompt: "Backward clock edit" }, "user");
    if (!backward.ok) throw new Error(backward.message);
    const again = new MaterialLibraryService(createIdbMaterialStorage());
    expect(await again.undo()).toMatchObject({ ok: true, value: { undoneEntryId: backward.value.journalEntryId } });
    expect(await again.get(created.material.id)).toMatchObject({ ok: true, value: { prompt: "Show a sample" } });
    const rows = (await storage.loadSnapshot()).journal as MaterialJournalEntry[];
    expect(rows.find(row => row.id === updated.value.journalEntryId)?.order).toEqual({ sequence: 2 });
    expect(rows.map(row => (row.order as { sequence: number }).sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("serializes allocation across connections and rejects a stale writer without half-writing", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    const writer = () => {
      const storage = createIdbMaterialStorage();
      return new MaterialLibraryService({ ...storage, commit: async change => {
        if (++entered === 2) release();
        await gate;
        return storage.commit(change);
      } });
    };
    const a = writer(), b = writer();
    const input = { kind: "instruction" as const, title: "Concurrent", prompt: "Sample" };
    const results = await Promise.all([a.create(input, "user"), b.create(input, "agent")]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.code === "CONFLICT")).toHaveLength(1);
    const retry = await (results[0].ok ? b : a).create(input, "user");
    expect(retry.ok).toBe(true);
    const snapshot = await createIdbMaterialStorage().loadSnapshot();
    expect(snapshot.materials).toHaveLength(2);
    expect((snapshot.journal as MaterialJournalEntry[]).map(row => row.order).sort((a, b) =>
      (a as { sequence: number }).sequence - (b as { sequence: number }).sequence)).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("guards unjournaled usage writes even though they do not increment material revision", async () => {
    const storage = createIdbMaterialStorage();
    const base = new MaterialLibraryService(storage);
    const created = await instruction(base);
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let pause = true;
    const delayed = new MaterialLibraryService({ ...storage, commit: async change => {
      if (pause) { pause = false; enter(); await gate; }
      return storage.commit(change);
    } });
    const pending = delayed.update(created.material.id, { prompt: "Changed" }, "user", 1);
    await entered;
    const other = new MaterialLibraryService(createIdbMaterialStorage());
    expect((await other.recordUsage(created.material.id, { projectId: "project-a", mediaIdInProject: "media-a",
      attachedAt: NOW, attachedBy: "user", status: "current" })).ok).toBe(true);
    resume();
    expect(await pending).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await delayed.get(created.material.id)).toMatchObject({ ok: true, value: { revision: 1,
      prompt: "Show a sample", usages: [{ projectId: "project-a" }] } });
    expect((await delayed.update(created.material.id, { prompt: "Changed" }, "user", 1)).ok).toBe(true);
    expect(await other.get(created.material.id)).toMatchObject({ ok: true, value: { revision: 2,
      prompt: "Changed", usages: [{ projectId: "project-a" }] } });
  });

  it("aborts queued record writes when a later journal put cannot be cloned, then retries cleanly", async () => {
    const storage = createIdbMaterialStorage();
    const record = buildMaterialRecord({ kind: "instruction", actor: "user", title: "Atomic", prompt: "Sample" });
    const journal = entry("mjr_atomic", null, record);
    const bad = { ...journal, uncloneable: () => 1 } as MaterialJournalEntry;
    await expect(storage.commit({ materialUpserts: [record], journalUpserts: [bad] })).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await storage.loadSnapshot()).toEqual({ materials: [], journal: [] });
    await storage.commit({ materialUpserts: [record], journalUpserts: [journal] });
    expect((await storage.loadSnapshot()).journal).toMatchObject([{ id: journal.id, order: { sequence: 1 } }]);
  });

  it("refuses to guess old same-time order, preserves explicit undo, and anchors legacy without inventing sequence", async () => {
    const storage = createIdbMaterialStorage();
    const original = buildMaterialRecord({ kind: "instruction", actor: "user", title: "Legacy", prompt: "Show a sample", nowIso: NOW });
    const updated = applyMaterialUpdate(original, { prompt: "Compare two samples" }, "user", NOW);
    const createId = "mjr_ffffffff-ffff-4fff-bfff-ffffffffffff", updateId = "mjr_00000000-0000-4000-8000-000000000001";
    await seedLegacy(storage, [entry(createId, null, original), entry(updateId, original, updated)], [updated]);
    const service = new MaterialLibraryService(storage);
    const before = await storage.loadSnapshot();
    expect(await service.undo()).toMatchObject({ ok: false, code: "CONFLICT", details: { reason: "ambiguous_journal_order" } });
    expect(await storage.loadSnapshot()).toEqual(before);
    expect((await service.undo(updateId)).ok).toBe(true);
    expect(await service.get(original.id)).toMatchObject({ ok: true, value: { prompt: "Show a sample" } });
    const rows = (await storage.loadSnapshot()).journal as MaterialJournalEntry[];
    expect(rows.find(row => row.id === createId)?.order).toEqual({ legacyBefore: 1 });
    expect(rows.find(row => row.id === updateId)?.order).toEqual({ legacyBefore: 1 });
    expect(rows.filter(row => row.order && "sequence" in row.order)).toHaveLength(1);
    const roundtrip = normalizeMaterialJournalEntry(JSON.parse(JSON.stringify(rows.find(row => row.id === createId))));
    expect(roundtrip?.order).toEqual({ legacyBefore: 1 });
  });

  it("re-anchors unsequenced mixed-version rows conservatively, without rewriting known commit order", async () => {
    const storage = createIdbMaterialStorage();
    const service = new MaterialLibraryService(storage);
    const first = await instruction(service);
    const legacy = entry("mjr_old_writer", null, first.material);
    await seedLegacy(storage, [legacy]);
    expect(await service.undo()).toMatchObject({ ok: false, code: "CONFLICT" });
    await instruction(service, "New after legacy");
    const rows = (await storage.loadSnapshot()).journal as MaterialJournalEntry[];
    expect(rows.find(row => row.id === first.journalEntryId)?.order).toEqual({ sequence: 1 });
    expect(rows.find(row => row.id === legacy.id)?.order).toEqual({ legacyBefore: 2 });
    expect(latestMaterialJournalEntry(rows).entry?.order).toEqual({ sequence: 2 });
    expect(latestMaterialJournalEntry(rows.filter(row => !(row.order && "sequence" in row.order && row.order.sequence === 2))).ambiguous).toBe(true);
  });

  it("retains uncertain legacy bytes until 100 known later commits prove them outside the undo window", async () => {
    const storage = createIdbMaterialStorage();
    const media = buildMaterialRecord({ kind: "media", actor: "user", title: "Legacy bytes", mediaType: "video",
      fileRef: { type: "blob", fileName: "legacy.mp4" }, nowIso: NOW });
    await seedLegacy(storage, [entry("mjr_legacy_create", null, media), entry("mjr_legacy_remove", media, null)], [],
      { id: media.id, blob: new Blob(["retained-bytes"]) });
    const service = new MaterialLibraryService(storage);
    for (let index = 0; index < 99; index++) await instruction(service, `Noise ${index}`);
    expect((await storage.loadSnapshot()).journal).toHaveLength(101);
    expect(await storage.loadBlob(media.id)).not.toBeNull();
    await instruction(service, "Noise 100");
    expect((await storage.loadSnapshot()).journal).toHaveLength(100);
    expect(await storage.loadBlob(media.id)).toBeNull();
  });

  it("rejects stale GC after a different connection restores a blob-backed record", async () => {
    const storage = createIdbMaterialStorage();
    const service = new MaterialLibraryService(storage);
    const created = await service.create({ kind: "media", title: "Bytes", mediaType: "video",
      fileRef: { type: "blob", fileName: "source.mp4" }, blob: new Blob(["keep"]) }, "user");
    if (!created.ok) throw new Error(created.message);
    const removed = await service.remove(created.value.material.id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    const stale = await storage.loadSnapshot();
    expect((await new MaterialLibraryService(createIdbMaterialStorage()).undo(removed.value.journalEntryId)).ok).toBe(true);
    const current = await storage.loadSnapshot();
    await expect(storage.commit({ expected: stale, journalDeletes: stale.journal.map(row => (row as MaterialJournalEntry).id),
      blobDeletes: [created.value.material.id] })).rejects.toBeInstanceOf(MaterialStorageConflict);
    expect(await storage.loadSnapshot()).toEqual(current);
    expect(await storage.loadBlob(created.value.material.id)).not.toBeNull();
  });

  it("blocks an explicit old undo from overwriting later user edits, but allows the compatible undo chain", async () => {
    const storage = createIdbMaterialStorage();
    const service = new MaterialLibraryService(storage);
    const created = await instruction(service);
    const agent = await service.update(created.material.id, { prompt: "Agent edit" }, "agent");
    if (!agent.ok) throw new Error(agent.message);
    const human = await service.update(created.material.id, { userNotes: "Keep this later note" }, "user");
    if (!human.ok) throw new Error(human.message);
    const before = await storage.loadSnapshot();
    expect(await service.undo(agent.value.journalEntryId)).toMatchObject({ ok: false, code: "CONFLICT",
      details: { reason: "undo_target_changed" } });
    expect(await service.undo(created.journalEntryId)).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await storage.loadSnapshot()).toEqual(before);
    expect((await service.undo(human.value.journalEntryId)).ok).toBe(true);
    expect((await service.undo(agent.value.journalEntryId)).ok).toBe(true);
    expect(await service.get(created.material.id)).toMatchObject({ ok: true, value: { prompt: "Show a sample" } });
  });

  it("keeps retained legacy bounds valid when the latest ordered row is deleted; full purge has no surviving anchors", async () => {
    const storage = createIdbMaterialStorage();
    const service = new MaterialLibraryService(storage);
    const first = await instruction(service);
    await seedLegacy(storage, [entry("mjr_legacy_bound", null, first.material)]);
    const second = await instruction(service, "Second");
    const atTwo = await storage.loadSnapshot();
    expect((atTwo.journal as MaterialJournalEntry[]).find(row => row.id === "mjr_legacy_bound")?.order).toEqual({ legacyBefore: 2 });
    await storage.commit({ expected: atTwo, journalDeletes: [second.journalEntryId] });
    const third = await instruction(service, "Third");
    const atThree = await storage.loadSnapshot();
    expect((atThree.journal as MaterialJournalEntry[]).find(row => row.id === third.journalEntryId)?.order).toEqual({ sequence: 3 });
    await storage.commit({ expected: atThree, journalDeletes: atThree.journal.map(row => (row as MaterialJournalEntry).id) });
    await expect(storage.commit({ expected: atThree, journalUpserts: [entry("mjr_stale", null, first.material)] })).rejects.toBeInstanceOf(MaterialStorageConflict);
    const fresh = await instruction(service, "After complete purge");
    expect(fresh.journalEntryId).not.toBe(first.journalEntryId);
    expect((await storage.loadSnapshot()).journal).toMatchObject([{ id: fresh.journalEntryId, order: { sequence: 1 } }]);
  });

  it("owns allocation regardless of caller metadata and refuses numeric overflow atomically", async () => {
    const storage = createIdbMaterialStorage();
    const record = buildMaterialRecord({ kind: "instruction", actor: "user", title: "Order", prompt: "Sample" });
    const row = { ...entry("mjr_owned", null, record), order: { sequence: 9999 } };
    await storage.commit({ journalUpserts: [row] });
    await storage.commit({ journalUpserts: [{ ...row, label: "Updated metadata", order: { sequence: 8888 } }] });
    expect((await storage.loadSnapshot()).journal).toMatchObject([{ id: row.id, order: { sequence: 1 } }]);
    await seedLegacy(storage, [{ ...entry("mjr_overflow", null, record), order: { legacyBefore: Number.MAX_SAFE_INTEGER } }]);
    const before = await storage.loadSnapshot();
    await expect(storage.commit({ materialUpserts: [record], journalUpserts: [entry("mjr_no_space", null, record)] })).rejects.toBeInstanceOf(MaterialStorageConflict);
    expect(await storage.loadSnapshot()).toEqual(before);
  });

  it("does not reclaim bytes referenced by a raw legacy row that the display normalizer cannot recognize", async () => {
    const storage = createIdbMaterialStorage();
    const media = buildMaterialRecord({ kind: "media", actor: "user", title: "Unknown legacy", mediaType: "video",
      fileRef: { type: "blob", fileName: "retained.mp4" }, nowIso: NOW });
    const unknown = { id: media.id, kind: "unknown-legacy-kind", fileRef: { type: "blob" } } as unknown as MaterialRecord;
    await seedLegacy(storage, [entry("mjr_unknown_create", null, media), entry("mjr_unknown_remove", media, null)], [unknown],
      { id: media.id, blob: new Blob(["must survive"]) });
    const service = new MaterialLibraryService(storage);
    for (let index = 0; index < 100; index++) await instruction(service, `New ${index}`);
    expect((await storage.loadSnapshot()).journal).toHaveLength(100);
    expect(await storage.loadBlob(media.id)).not.toBeNull();
  });
});
