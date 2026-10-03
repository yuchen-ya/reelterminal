/**
 * IndexedDB persistence for user-level custom presets.
 *
 * A dedicated database named `CUSTOM_PRESETS_DB_NAME`, re-exported from
 * ../legacy-storage-keys and registered in
 * packages/core/src/legacy/physical-identifiers.ts), deliberately separate
 * from the project storage engine's own database so its schema versioning is
 * untouched, and separate from the material library so preset CRUD can never
 * interfere with library GC semantics. One object store:
 *
 *  - `presets`: CustomPresetRecord JSON rows keyed by `id`, with non-unique
 *    secondary indexes on `kind`, `updatedAt` and `name`.
 *
 * All writes go through one `commit()` — a single IDB transaction per
 * mutation, so a crash can never persist half a change. Thumbnails are
 * inline data-URL strings on the record; they live and die with the record
 * in the same transaction (deleting a preset is the only reclamation point).
 */
import type { CustomPresetRecord } from "@reelterminal/core/presets/types";
import { LEGACY_CUSTOM_PRESETS_DB_NAME } from "../legacy-storage-keys";

// Persisted database name for user custom presets.
export const CUSTOM_PRESETS_DB_NAME = LEGACY_CUSTOM_PRESETS_DB_NAME;
export const CUSTOM_PRESETS_DB_VERSION = 1;
export const CUSTOM_PRESETS_STORE = "presets";

/** The narrow storage surface the preset service depends on. */
export interface PresetStorage {
  loadAll(): Promise<unknown[]>;
  /** One atomic transaction covering this batch of upserts and deletes. */
  commit(upserts: readonly CustomPresetRecord[], deletes: readonly string[]): Promise<void>;
}

/** Raised when IndexedDB is unavailable or unusable in this environment. */
export class PresetStorageUnavailableError extends Error {
  readonly code = "UNAVAILABLE";

  constructor(reason: string) {
    super(`Custom preset storage is unavailable: ${reason}`);
    this.name = "PresetStorageUnavailableError";
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(CUSTOM_PRESETS_DB_NAME, CUSTOM_PRESETS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Create-only upgrades: never drop or rebuild existing stores.
      if (!db.objectStoreNames.contains(CUSTOM_PRESETS_STORE)) {
        const store = db.createObjectStore(CUSTOM_PRESETS_STORE, { keyPath: "id" });
        store.createIndex("kind", "kind", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("name", "name", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Raw IndexedDB implementation of PresetStorage (renderer only). */
export function createIdbPresetStorage(): PresetStorage {
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const db = (): Promise<IDBDatabase | null> => {
    if (!dbPromise) dbPromise = openDatabase();
    return dbPromise;
  };

  const requireDb = async (): Promise<IDBDatabase> => {
    const database = await db();
    if (!database) {
      throw new PresetStorageUnavailableError("IndexedDB could not be opened");
    }
    return database;
  };

  const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });

  return {
    async loadAll() {
      const database = await requireDb();
      const transaction = database.transaction([CUSTOM_PRESETS_STORE], "readonly");
      return requestToPromise(
        transaction.objectStore(CUSTOM_PRESETS_STORE).getAll() as IDBRequest<unknown[]>,
      );
    },
    async commit(upserts, deletes) {
      if (upserts.length === 0 && deletes.length === 0) return;
      const database = await requireDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([CUSTOM_PRESETS_STORE], "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB commit aborted"));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB commit failed"));
        const store = transaction.objectStore(CUSTOM_PRESETS_STORE);
        for (const record of upserts) store.put(record);
        for (const id of deletes) store.delete(id);
      });
    },
  };
}
