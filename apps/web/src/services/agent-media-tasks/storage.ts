/**
 * IndexedDB persistence for user-level agent media tasks.
 *
 * A dedicated database (`openreel-agent-tasks`), deliberately separate from
 * `openreel-db`, the material library and the preset store so none of their
 * schema versioning or GC semantics are touched. One object store:
 *
 *  - `tasks`: AgentMediaTaskRecord JSON rows keyed by `id`, with secondary
 *    indexes on `requestId`, `status` and `updatedAt`.
 *
 * Records carry no media bytes: `resultPath` is only a pointer into the
 * agent workspace job directory and imported audio lives in the project
 * media store. Deleting a task row therefore has no GC consequences.
 *
 * All writes go through one `commit()` — a single IDB transaction per
 * mutation batch, so a crash can never persist half a batch.
 */
import type { AgentMediaTaskRecord } from "./types";

export const AGENT_TASKS_DB_NAME = "openreel-agent-tasks";
export const AGENT_TASKS_DB_VERSION = 1;
export const AGENT_TASKS_STORE = "tasks";

/** The narrow storage surface the task service depends on. */
export interface AgentTaskStorage {
  loadAll(): Promise<unknown[]>;
  /** One atomic transaction covering this batch of upserts and deletes. */
  commit(
    upserts: readonly AgentMediaTaskRecord[],
    deletes: readonly string[],
  ): Promise<void>;
}

/** Raised when IndexedDB is unavailable or unusable in this environment. */
export class AgentTaskStorageUnavailableError extends Error {
  readonly code = "UNAVAILABLE";

  constructor(reason: string) {
    super(`Agent task storage is unavailable: ${reason}`);
    this.name = "AgentTaskStorageUnavailableError";
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(AGENT_TASKS_DB_NAME, AGENT_TASKS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Create-only upgrades: never drop or rebuild existing stores.
      if (!db.objectStoreNames.contains(AGENT_TASKS_STORE)) {
        const store = db.createObjectStore(AGENT_TASKS_STORE, { keyPath: "id" });
        store.createIndex("requestId", "requestId", { unique: false });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Raw IndexedDB implementation of AgentTaskStorage (renderer only). */
export function createIdbAgentTaskStorage(): AgentTaskStorage {
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  const db = (): Promise<IDBDatabase | null> => {
    if (!dbPromise) dbPromise = openDatabase();
    return dbPromise;
  };

  const requireDb = async (): Promise<IDBDatabase> => {
    const database = await db();
    if (!database) {
      throw new AgentTaskStorageUnavailableError("IndexedDB could not be opened");
    }
    return database;
  };

  const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed"));
    });

  return {
    async loadAll() {
      const database = await requireDb();
      const transaction = database.transaction([AGENT_TASKS_STORE], "readonly");
      return requestToPromise(
        transaction.objectStore(AGENT_TASKS_STORE).getAll() as IDBRequest<unknown[]>,
      );
    },
    async commit(upserts, deletes) {
      if (upserts.length === 0 && deletes.length === 0) return;
      const database = await requireDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([AGENT_TASKS_STORE], "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("IndexedDB commit aborted"));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("IndexedDB commit failed"));
        const store = transaction.objectStore(AGENT_TASKS_STORE);
        for (const record of upserts) store.put(record);
        for (const id of deletes) store.delete(id);
      });
    },
  };
}
