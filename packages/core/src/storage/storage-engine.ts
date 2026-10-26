import type { Project } from "../types";
import { serializeProject, deserializeProject } from "../utils/serialization";
import { hashMediaBlob } from "./media-hash";
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  type IStorageEngine,
  type ProjectRecord,
  type ProjectSummary,
  type MediaRecord,
  type CacheRecord,
  type WaveformRecord,
  type StorageUsage,
  type StorageError,
  type StorageErrorCode,
} from "./types";

function createStorageError(
  code: StorageErrorCode,
  message: string,
  quotaInfo?: StorageError["quotaInfo"],
  cause?: unknown,
): StorageError {
  if (cause === undefined) {
    return { code, message, quotaInfo };
  }
  const name = (cause as { name?: unknown } | null | undefined)?.name;
  return {
    code,
    message,
    quotaInfo,
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    cause,
  };
}

/**
 * Wrap an underlying IndexedDB/DOM error into a StorageError while preserving
 * its identity: the original `name` (e.g. "QuotaExceededError", "AbortError",
 * "ConstraintError") and the error itself as `cause`. Quota failures classify
 * as QUOTA_EXCEEDED; everything else stays DATABASE_ERROR.
 */
function wrapStorageError(cause: unknown, message: string): StorageError {
  const name = (cause as { name?: unknown } | null | undefined)?.name;
  return createStorageError(
    name === "QuotaExceededError" ? "QUOTA_EXCEEDED" : "DATABASE_ERROR",
    message,
    undefined,
    cause,
  );
}

export class StorageEngine implements IStorageEngine {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = this.openDatabase();
    this.db = await this.dbPromise;
    return this.db;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(
          createStorageError(
            "BROWSER_NOT_SUPPORTED",
            "IndexedDB is not supported in this environment",
          ),
        );
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(
          wrapStorageError(
            request.error,
            `Failed to open database: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.createStores(db);
        const transaction = (event.target as IDBOpenDBRequest).transaction;
        if (transaction) {
          const mediaStore = transaction.objectStore(STORES.MEDIA);
          if (!mediaStore.indexNames.contains("projectIds")) {
            mediaStore.createIndex("projectIds", "projectIds", { unique: false, multiEntry: true });
          }
          if (event.oldVersion < 4) {
            const cursorRequest = mediaStore.openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const record = cursor.value as MediaRecord;
              if (!record.projectIds || record.projectIds.length === 0) {
                cursor.update({ ...record, projectIds: [record.projectId] });
              }
              cursor.continue();
            };
          }
        }
      };
    });
  }

  private createStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(STORES.PROJECTS)) {
      const projectStore = db.createObjectStore(STORES.PROJECTS, {
        keyPath: "id",
      });
      projectStore.createIndex("modifiedAt", "modifiedAt", { unique: false });
      projectStore.createIndex("name", "name", { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.MEDIA)) {
      const mediaStore = db.createObjectStore(STORES.MEDIA, { keyPath: "id" });
      mediaStore.createIndex("projectId", "projectId", { unique: false });
      mediaStore.createIndex("projectIds", "projectIds", { unique: false, multiEntry: true });
    }

    if (!db.objectStoreNames.contains(STORES.CACHE)) {
      const cacheStore = db.createObjectStore(STORES.CACHE, { keyPath: "key" });
      cacheStore.createIndex("timestamp", "timestamp", { unique: false });
    }

    if (!db.objectStoreNames.contains(STORES.WAVEFORMS)) {
      db.createObjectStore(STORES.WAVEFORMS, { keyPath: "mediaId" });
    }

    if (!db.objectStoreNames.contains(STORES.FILE_HANDLES)) {
      db.createObjectStore(STORES.FILE_HANDLES, { keyPath: "key" });
    }

    if (!db.objectStoreNames.contains(STORES.DIR_HANDLES)) {
      db.createObjectStore(STORES.DIR_HANDLES, { keyPath: "key" });
    }
  }

  /**
   * Generic transaction wrapper for IDB operations.
   * Wraps callback-based IDB API in Promise for easier async/await handling.
   * Automatically creates transaction with specified mode and stores.
   *
   * The promise settles only when the transaction reaches a final outcome:
   * it resolves on `tx.oncomplete` (the point where writes are durable) and
   * rejects on `tx.onabort`. A request error that is not preventDefault'ed
   * aborts the transaction, and the request's `error` event fires before the
   * transaction's `abort` event, so `onabort` is the single failure
   * settlement point and keeps the triggering request error's identity.
   *
   * Note: IDB transactions are short-lived. If the promise doesn't resolve quickly,
   * the transaction may abort. Large operations should batch requests.
   */
  private async transaction<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    operation: (stores: Record<string, IDBObjectStore>) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores: Record<string, IDBObjectStore> = {};

      // Normalize store names to array and create object store map
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      for (const name of names) {
        stores[name] = tx.objectStore(name);
      }

      // Execute the operation callback to get the request
      const request = operation(stores);

      // Record the request error for identity; do not preventDefault so the
      // transaction aborts and settles the promise below.
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };

      // Success of the individual request is not enough — the value is only
      // durable once the transaction commits.
      tx.oncomplete = () => resolve(request.result);

      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Transaction failed: ${(cause as Error).message}`));
      };
    });
  }

  private async transactionGetAll<T>(
    storeName: string,
    indexName?: string,
    query?: IDBValidKey | IDBKeyRange,
  ): Promise<T[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const target = indexName ? store.index(indexName) : store;
      const request = query ? target.getAll(query) : target.getAll();

      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to get all: ${(cause as Error).message}`));
      };
    });
  }

  async saveProject(project: Project): Promise<void> {
    try {
      const serialized = serializeProject(project);
      const record: ProjectRecord = {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        modifiedAt: project.modifiedAt,
        data: serialized,
      };

      await this.transaction(STORES.PROJECTS, "readwrite", (stores) =>
        stores[STORES.PROJECTS].put(record),
      );
    } catch (error) {
      if ((error as StorageError).code) {
        throw error;
      }
      throw createStorageError(
        "SERIALIZATION_FAILED",
        `Failed to serialize project: ${(error as Error).message}`,
        undefined,
        error,
      );
    }
  }

  async loadProject(id: string): Promise<Project | null> {
    try {
      const record = await this.transaction<ProjectRecord | undefined>(
        STORES.PROJECTS,
        "readonly",
        (stores) => stores[STORES.PROJECTS].get(id),
      );

      if (!record) {
        return null;
      }

      return deserializeProject(record.data);
    } catch (error) {
      if ((error as StorageError).code) {
        throw error;
      }
      throw createStorageError(
        "DESERIALIZATION_FAILED",
        `Failed to deserialize project: ${(error as Error).message}`,
        undefined,
        error,
      );
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const records = await this.transactionGetAll<ProjectRecord>(
      STORES.PROJECTS,
    );

    return records
      .map((record) => ({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        modifiedAt: record.modifiedAt,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async deleteProject(id: string): Promise<void> {
    const db = await this.getDb();

    const mediaRecords = await this.getMediaByProject(id);
    for (const media of mediaRecords) {
      const remainingProjectIds = (media.projectIds ?? [media.projectId]).filter((projectId) => projectId !== id);
      if (remainingProjectIds.length === 0) {
        await this.deleteMedia(media.id);
      } else {
        const primaryProjectId = remainingProjectIds.includes(media.projectId)
          ? media.projectId
          : remainingProjectIds[0];
        await this.transaction(STORES.MEDIA, "readwrite", (stores) =>
          stores[STORES.MEDIA].put({
            ...media,
            projectId: primaryProjectId,
            projectIds: remainingProjectIds,
          }),
        );
      }
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.PROJECTS, "readwrite");
      const store = tx.objectStore(STORES.PROJECTS);
      const request = store.delete(id);

      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to delete project: ${(cause as Error).message}`));
      };
    });
  }

  async saveMedia(media: MediaRecord): Promise<void> {
    const contentHash = media.contentHash ?? await hashMediaBlob(media.blob);
    const record: MediaRecord = {
      ...media,
      contentHash,
      projectIds: [...new Set(media.projectIds ?? [media.projectId])],
    };
    const mergeExisting = async (existing: MediaRecord): Promise<void> => {
      const existingHash = existing.contentHash ?? await hashMediaBlob(existing.blob);
      if (existingHash !== contentHash) {
        throw new Error(`Media version ${media.id} is immutable and already contains different bytes`);
      }
      const projectIds = [...new Set([...(existing.projectIds ?? [existing.projectId]), media.projectId])];
      await this.transaction(STORES.MEDIA, "readwrite", (stores) =>
        stores[STORES.MEDIA].put({
          ...existing,
          projectIds,
          contentHash,
          ...(existing.contentUrl || !media.contentUrl ? {} : { contentUrl: media.contentUrl }),
        }),
      );
    };
    try {
      await this.transaction(STORES.MEDIA, "readwrite", (stores) =>
        stores[STORES.MEDIA].add(record),
      );
      return;
    } catch (error) {
      // Another tab may have committed the same new version in parallel, or
      // this may be an idempotent replay. `add` signals a duplicate key with
      // ConstraintError — only that case may run the merge below, and it
      // accepts only byte-identical content. Every other failure (quota,
      // abort, anything else) must propagate untouched: converting it into a
      // lookup/merge would mask the failure as success.
      if ((error as { name?: string } | null | undefined)?.name !== "ConstraintError") {
        throw error;
      }
      const existing = await this.loadMedia(media.id);
      if (!existing) throw error;
      await mergeExisting(existing);
    }
  }

  async loadMedia(id: string): Promise<MediaRecord | null> {
    const record = await this.transaction<MediaRecord | undefined>(
      STORES.MEDIA,
      "readonly",
      (stores) => stores[STORES.MEDIA].get(id),
    );
    return record || null;
  }

  async deleteMedia(id: string): Promise<void> {
    await this.deleteWaveform(id);

    await this.transaction(STORES.MEDIA, "readwrite", (stores) =>
      stores[STORES.MEDIA].delete(id),
    );
  }

  async getMediaByProject(projectId: string): Promise<MediaRecord[]> {
    return this.transactionGetAll<MediaRecord>(
      STORES.MEDIA,
      "projectIds",
      projectId,
    );
  }

  async getAllMedia(): Promise<MediaRecord[]> {
    return this.transactionGetAll<MediaRecord>(STORES.MEDIA);
  }

  async getAllCache(): Promise<CacheRecord[]> {
    return this.transactionGetAll<CacheRecord>(STORES.CACHE);
  }

  /** Delete one cache row only if it still matches the reviewed snapshot. */
  async deleteCacheIfMatches(input: {
    key: string;
    size: number;
    timestamp: number;
  }): Promise<boolean> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.CACHE, "readwrite");
      const store = tx.objectStore(STORES.CACHE);
      const request = store.get(input.key);
      let requestError: unknown = null;
      let deleted = false;
      request.onerror = () => {
        requestError = request.error;
      };
      request.onsuccess = () => {
        const record = request.result as CacheRecord | undefined;
        if (!record || record.data.byteLength !== input.size || record.timestamp !== input.timestamp) return;
        deleted = true;
        const deletion = store.delete(input.key);
        deletion.onerror = () => {
          requestError = deletion.error;
        };
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to delete reviewed cache entry: ${(cause as Error).message}`));
      };
    });
  }

  /**
   * Media ids stored for a project, read through the projectId index without
   * materializing any blob bytes. Use this for GC scans over large libraries.
   */
  async getMediaIdsByProject(projectId: string): Promise<string[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.MEDIA, "readonly");
      const request = tx.objectStore(STORES.MEDIA).index("projectIds").getAllKeys(projectId);
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve(request.result.map((key) => String(key)));
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to list media ids: ${(cause as Error).message}`));
      };
    });
  }

  async saveCache(record: CacheRecord): Promise<void> {
    await this.transaction(STORES.CACHE, "readwrite", (stores) =>
      stores[STORES.CACHE].put(record),
    );
  }

  async loadCache(key: string): Promise<CacheRecord | null> {
    const record = await this.transaction<CacheRecord | undefined>(
      STORES.CACHE,
      "readonly",
      (stores) => stores[STORES.CACHE].get(key),
    );

    if (record) {
      const updated: CacheRecord = {
        ...record,
        timestamp: Date.now(),
      };
      await this.saveCache(updated);
      return updated;
    }

    return null;
  }

  async deleteCache(key: string): Promise<void> {
    await this.transaction(STORES.CACHE, "readwrite", (stores) =>
      stores[STORES.CACHE].delete(key),
    );
  }

  async clearCache(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.CACHE, "readwrite");
      const store = tx.objectStore(STORES.CACHE);
      const request = store.clear();

      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to clear cache: ${(cause as Error).message}`));
      };
    });
  }

  async saveWaveform(record: WaveformRecord): Promise<void> {
    await this.transaction(STORES.WAVEFORMS, "readwrite", (stores) =>
      stores[STORES.WAVEFORMS].put(record),
    );
  }

  async loadWaveform(mediaId: string): Promise<WaveformRecord | null> {
    const record = await this.transaction<WaveformRecord | undefined>(
      STORES.WAVEFORMS,
      "readonly",
      (stores) => stores[STORES.WAVEFORMS].get(mediaId),
    );
    return record || null;
  }

  async deleteWaveform(mediaId: string): Promise<void> {
    await this.transaction(STORES.WAVEFORMS, "readwrite", (stores) =>
      stores[STORES.WAVEFORMS].delete(mediaId),
    );
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const db = await this.getDb();

    const projectCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORES.PROJECTS, "readonly");
      const store = tx.objectStore(STORES.PROJECTS);
      const request = store.count();
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to count projects: ${(cause as Error).message}`));
      };
    });

    const mediaCount = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORES.MEDIA, "readonly");
      const store = tx.objectStore(STORES.MEDIA);
      const request = store.count();
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to count media: ${(cause as Error).message}`));
      };
    });

    let used = 0;
    let quota = 0;

    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        used = estimate.usage || 0;
        quota = estimate.quota || 0;
      } catch {}
    }

    return {
      used,
      quota,
      projects: projectCount,
      mediaItems: mediaCount,
    };
  }

  async saveFileHandle(name: string, size: number, handle: FileSystemFileHandle): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.FILE_HANDLES, "readwrite");
      const store = tx.objectStore(STORES.FILE_HANDLES);
      const request = store.put({ key: `${name}:${size}`, handle });
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to save file handle: ${(cause as Error).message}`));
      };
    });
  }

  async loadFileHandle(name: string, size: number): Promise<FileSystemFileHandle | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.FILE_HANDLES, "readonly");
      const store = tx.objectStore(STORES.FILE_HANDLES);
      const request = store.get(`${name}:${size}`);
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () =>
        resolve((request.result as { handle: FileSystemFileHandle } | undefined)?.handle ?? null);
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to load file handle: ${(cause as Error).message}`));
      };
    });
  }

  async saveDirectoryHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.DIR_HANDLES, "readwrite");
      const store = tx.objectStore(STORES.DIR_HANDLES);
      const request = store.put({ key: projectId, handle, folderName: handle.name });
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to save directory handle: ${(cause as Error).message}`));
      };
    });
  }

  async loadDirectoryHandle(projectId: string): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.DIR_HANDLES, "readonly");
      const store = tx.objectStore(STORES.DIR_HANDLES);
      const request = store.get(projectId);
      let requestError: unknown = null;
      request.onerror = () => {
        requestError = request.error;
      };
      tx.oncomplete = () => {
        const rec = request.result as { handle: FileSystemDirectoryHandle; folderName: string } | undefined;
        resolve(rec ? { handle: rec.handle, folderName: rec.folderName } : null);
      };
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to load directory handle: ${(cause as Error).message}`));
      };
    });
  }

  async clearAllData(): Promise<void> {
    const db = await this.getDb();
    const storeNames = [
      STORES.PROJECTS,
      STORES.MEDIA,
      STORES.CACHE,
      STORES.WAVEFORMS,
      STORES.FILE_HANDLES,
      STORES.DIR_HANDLES,
    ];

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      let requestError: unknown = null;
      for (const storeName of storeNames) {
        const request = tx.objectStore(storeName).clear();
        // Record the triggering request error (do not preventDefault — the
        // default abort settles the promise below with identity intact).
        request.onerror = () => {
          requestError = request.error;
        };
      }
      tx.oncomplete = () => resolve();
      // An abort without an error event (explicit tx.abort(), forced
      // connection close) must settle too — otherwise the promise hangs.
      tx.onabort = () => {
        const cause = requestError ?? tx.error ?? new DOMException("The transaction was aborted", "AbortError");
        reject(wrapStorageError(cause, `Failed to clear all data: ${(cause as Error).message}`));
      };
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }
}

export function createStorageEngine(): IStorageEngine {
  return new StorageEngine();
}
