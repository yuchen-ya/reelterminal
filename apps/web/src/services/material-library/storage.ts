/**
 * IndexedDB persistence for the user-level material library.
 *
 * A dedicated database named `MATERIAL_LIBRARY_DB_NAME`, re-exported from
 * ../legacy-storage-keys and registered in
 * packages/core/src/legacy/physical-identifiers.ts. It is deliberately
 * separate from the project storage engine's own database so its schema
 * versioning is untouched. Three object stores:
 *
 *  - `materials`: MaterialRecord JSON rows keyed by id.
 *  - `journal`:   MaterialJournalEntry rows (library-scoped undo history).
 *  - `blobs`:     explicit copies of web-imported media files (desktop path
 *                 references are NOT copied — the original file stays where
 *                 the user put it).
 *
 * All writes go through one `commit()` — a single IDB transaction per
 * mutation batch, so a crash mid-batch can never persist half a batch.
 */
import type {
  MaterialJournalEntry,
  MaterialRecord,
} from "@reelterminal/core/material/types";
import { normalizeMaterialJournalOrder } from "@reelterminal/core/material/journal-order";
import { LEGACY_MATERIAL_LIBRARY_DB_NAME } from "../legacy-storage-keys";
import { upgradeReviewStores } from "../review-workspace/schema";

// Persisted database name for materials, journal entries, and blobs.
export const MATERIAL_LIBRARY_DB_NAME = LEGACY_MATERIAL_LIBRARY_DB_NAME;
export const MATERIAL_LIBRARY_DB_VERSION = 3;

export interface MaterialStorageCommit {
  /** Raw, atomically read input state. Checked inside the write transaction. */
  readonly expected?: MaterialStorageSnapshot;
  readonly materialUpserts?: readonly MaterialRecord[];
  readonly materialDeletes?: readonly string[];
  readonly blobPuts?: ReadonlyArray<{ readonly id: string; readonly blob: Blob }>;
  readonly blobDeletes?: readonly string[];
  readonly journalUpserts?: readonly MaterialJournalEntry[];
  readonly journalDeletes?: readonly string[];
}

export interface MaterialStorageSnapshot {
  readonly materials: readonly unknown[];
  readonly journal: readonly unknown[];
}

export class MaterialStorageConflict extends Error {
  constructor(message = "Material library changed in another writer; refresh and retry") {
    super(message);
    this.name = "MaterialStorageConflict";
  }
}

const rawId = (row: unknown): unknown => row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
const rawOrder = (row: unknown) => normalizeMaterialJournalOrder(row && typeof row === "object" ? (row as { order?: unknown }).order : undefined);
const snapshotRows = (rows: readonly unknown[]) => JSON.stringify([...rows].sort((a, b) => String(rawId(a)).localeCompare(String(rawId(b)))));

/** One storage-owned ordering rule, shared by IDB and test backends. No
 * independent counter: derive the next order from the rows in this transaction.
 * Legacy rows receive only a proven upper bound, not a fabricated sequence. */
export function planMaterialStorageCommit(current: MaterialStorageSnapshot, change: MaterialStorageCommit):
  { change: MaterialStorageCommit; snapshot: MaterialStorageSnapshot } {
  if (change.expected && (snapshotRows(current.materials) !== snapshotRows(change.expected.materials)
      || snapshotRows(current.journal) !== snapshotRows(change.expected.journal))) throw new MaterialStorageConflict();
  const materials = new Map(current.materials.map(row => [rawId(row), row]));
  const journal = new Map(current.journal.map(row => [rawId(row), row]));
  const newIds = [...new Set((change.journalUpserts ?? []).filter(row => !journal.has(row.id)).map(row => row.id))];
  const maximum = current.journal.reduce<number>((max, row) => {
    const order = rawOrder(row);
    return Math.max(max, order ? ("sequence" in order ? order.sequence : order.legacyBefore) : 0);
  }, 0);
  if (newIds.length && !Number.isSafeInteger(maximum + newIds.length)) {
    throw new MaterialStorageConflict("Material journal commit order is exhausted; no changes were written");
  }
  const allocated = new Map(newIds.map((id, index) => [id, maximum + index + 1]));
  const upserts = new Map<string, MaterialJournalEntry>();
  if (newIds.length) {
    for (const row of current.journal) {
      if (!rawOrder(row) && row && typeof row === "object" && typeof rawId(row) === "string"
          && Array.isArray((row as { changes?: unknown }).changes)) {
        upserts.set(rawId(row) as string, { ...row, order: { legacyBefore: maximum + 1 } } as MaterialJournalEntry);
      }
    }
  }
  for (const row of change.journalUpserts ?? []) {
    const sequence = allocated.get(row.id);
    const order = sequence !== undefined ? { sequence } : rawOrder(journal.get(row.id))
      ?? (newIds.length ? { legacyBefore: maximum + 1 } : undefined);
    const { order: _callerOrder, ...content } = row;
    upserts.set(row.id, { ...content, ...(order ? { order } : {}) });
  }
  for (const row of change.materialUpserts ?? []) materials.set(row.id, row);
  for (const id of change.materialDeletes ?? []) materials.delete(id);
  for (const row of upserts.values()) journal.set(row.id, row);
  for (const id of change.journalDeletes ?? []) journal.delete(id);
  return { change: { ...change, ...(upserts.size ? { journalUpserts: [...upserts.values()] } : {}) },
    snapshot: { materials: [...materials.values()], journal: [...journal.values()] } };
}

/** The narrow storage surface the library service depends on. */
export interface MaterialStorage {
  loadSnapshot(): Promise<MaterialStorageSnapshot>;
  loadAllMaterials(): Promise<unknown[]>;
  loadJournal(): Promise<unknown[]>;
  loadBlob(materialId: string): Promise<Blob | null>;
  /** One atomic transaction covering every store this batch touches. */
  commit(change: MaterialStorageCommit): Promise<MaterialStorageSnapshot>;
}

interface BlobRecord {
  readonly id: string;
  readonly blob: Blob;
}

export function openMaterialDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(
      MATERIAL_LIBRARY_DB_NAME,
      MATERIAL_LIBRARY_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      if (abandoned) { request.transaction!.abort(); return; }
      const db = request.result;
      if (!db.objectStoreNames.contains("materials")) {
        db.createObjectStore("materials", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("journal")) {
        db.createObjectStore("journal", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "id" });
      }
      upgradeReviewStores(db);
      if (!db.objectStoreNames.contains("humanBoards")) {
        db.createObjectStore("humanBoards", { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => {
      abandoned = true;
      reject(Object.assign(new Error("Close other windows using the old material/review database, then retry"), { code: "ACTION_FAILED", details: { reason: "DB_BLOCKED" } }));
    };
  });
}

/** Raw IndexedDB implementation of MaterialStorage (renderer only). */
export function createIdbMaterialStorage(): MaterialStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) dbPromise = openMaterialDatabase();
    return dbPromise;
  };

  const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });

  const readAll = async (store: string): Promise<unknown[]> => {
    const database = await db();
    const transaction = database.transaction([store], "readonly");
    return requestToPromise(
      transaction.objectStore(store).getAll() as IDBRequest<unknown[]>,
    );
  };

  return {
    async loadSnapshot() {
      const database = await db();
      return new Promise<MaterialStorageSnapshot>((resolve, reject) => {
        const transaction = database.transaction(["materials", "journal"], "readonly");
        const materials = transaction.objectStore("materials").getAll();
        const journal = transaction.objectStore("journal").getAll();
        transaction.oncomplete = () => resolve({ materials: materials.result, journal: journal.result });
        transaction.onabort = () => reject(transaction.error ?? new Error("Material snapshot read aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("Material snapshot read failed"));
      });
    },
    async loadAllMaterials() {
      return readAll("materials");
    },
    async loadJournal() {
      return readAll("journal");
    },
    async loadBlob(materialId) {
      const database = await db();
      const transaction = database.transaction(["blobs"], "readonly");
      const record = (await requestToPromise(
        transaction.objectStore("blobs").get(materialId) as IDBRequest<BlobRecord | undefined>,
      )) as BlobRecord | undefined;
      return record?.blob ?? null;
    },
    async commit(change) {
      const database = await db();
      return new Promise<MaterialStorageSnapshot>((resolve, reject) => {
        const transaction = database.transaction(["materials", "journal", "blobs"], "readwrite");
        let result: MaterialStorageSnapshot | undefined;
        let failure: unknown;
        transaction.oncomplete = () => result ? resolve(result) : reject(new Error("Material commit produced no snapshot"));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("IndexedDB commit aborted"));
        // Let IDB abort failed requests; the abort handler retains the cause.
        const materials = transaction.objectStore("materials").getAll();
        const journal = transaction.objectStore("journal").getAll();
        let read = 0;
        const apply = () => {
          if (++read !== 2) return;
          try {
            const plan = planMaterialStorageCommit({ materials: materials.result, journal: journal.result }, change);
            const next = plan.change;
            const materialStore = transaction.objectStore("materials");
            const journalStore = transaction.objectStore("journal");
            const blobStore = transaction.objectStore("blobs");
            for (const record of next.materialUpserts ?? []) materialStore.put(record);
            for (const id of next.materialDeletes ?? []) materialStore.delete(id);
            for (const entry of next.journalUpserts ?? []) journalStore.put(entry);
            for (const id of next.journalDeletes ?? []) journalStore.delete(id);
            for (const put of next.blobPuts ?? []) blobStore.put({ id: put.id, blob: put.blob } satisfies BlobRecord);
            for (const id of next.blobDeletes ?? []) blobStore.delete(id);
            result = plan.snapshot;
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        materials.onsuccess = journal.onsuccess = apply;
      });
    },
  };
}
