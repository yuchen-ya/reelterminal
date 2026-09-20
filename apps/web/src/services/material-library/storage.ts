/**
 * IndexedDB persistence for the user-level material library.
 *
 * A dedicated database (its name is the frozen legacy
 * `MATERIAL_LIBRARY_DB_NAME` re-exported below from ../legacy-storage-keys —
 * registry: packages/core/src/legacy/physical-identifiers.ts), deliberately
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
import { LEGACY_MATERIAL_LIBRARY_DB_NAME } from "../legacy-storage-keys";

// Persisted database name — legacy registry re-export, value frozen
// (user materials/journal/blobs). See packages/core/src/legacy/physical-identifiers.ts.
export const MATERIAL_LIBRARY_DB_NAME = LEGACY_MATERIAL_LIBRARY_DB_NAME;
export const MATERIAL_LIBRARY_DB_VERSION = 1;

export interface MaterialStorageCommit {
  readonly materialUpserts?: readonly MaterialRecord[];
  readonly materialDeletes?: readonly string[];
  readonly blobPuts?: ReadonlyArray<{ readonly id: string; readonly blob: Blob }>;
  readonly blobDeletes?: readonly string[];
  readonly journalUpserts?: readonly MaterialJournalEntry[];
  readonly journalDeletes?: readonly string[];
}

/** The narrow storage surface the library service depends on. */
export interface MaterialStorage {
  loadAllMaterials(): Promise<unknown[]>;
  loadJournal(): Promise<unknown[]>;
  loadBlob(materialId: string): Promise<Blob | null>;
  /** One atomic transaction covering every store this batch touches. */
  commit(change: MaterialStorageCommit): Promise<void>;
}

interface BlobRecord {
  readonly id: string;
  readonly blob: Blob;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      MATERIAL_LIBRARY_DB_NAME,
      MATERIAL_LIBRARY_DB_VERSION,
    );
    request.onupgradeneeded = () => {
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/** Raw IndexedDB implementation of MaterialStorage (renderer only). */
export function createIdbMaterialStorage(): MaterialStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) dbPromise = openDatabase();
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
      const storeNames: string[] = [];
      if (change.materialUpserts?.length || change.materialDeletes?.length) {
        storeNames.push("materials");
      }
      if (change.journalUpserts?.length || change.journalDeletes?.length) {
        storeNames.push("journal");
      }
      if (change.blobPuts?.length || change.blobDeletes?.length) {
        storeNames.push("blobs");
      }
      if (storeNames.length === 0) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeNames, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB commit aborted"));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB commit failed"));
        for (const name of storeNames) {
          const store = transaction.objectStore(name);
          if (name === "materials") {
            for (const record of change.materialUpserts ?? []) store.put(record);
            for (const id of change.materialDeletes ?? []) store.delete(id);
          } else if (name === "journal") {
            for (const entry of change.journalUpserts ?? []) store.put(entry);
            for (const id of change.journalDeletes ?? []) store.delete(id);
          } else {
            for (const put of change.blobPuts ?? []) {
              store.put({ id: put.id, blob: put.blob } satisfies BlobRecord);
            }
            for (const id of change.blobDeletes ?? []) store.delete(id);
          }
        }
      });
    },
  };
}
