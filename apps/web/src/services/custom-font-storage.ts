import { LEGACY_CUSTOM_FONTS_DB_NAME } from "./legacy-storage-keys";

interface StoredCustomFontRecord {
  readonly family?: unknown;
  readonly data?: unknown;
}

const DB_VERSION = 1;
const FONT_STORE = "fonts";
const sessionFontBytes = new Map<string, ArrayBuffer>();

export function cacheCustomFontBytes(family: string, data: ArrayBuffer): void {
  sessionFontBytes.set(family, data.slice(0));
}

export function forgetCustomFontBytes(family: string): void {
  sessionFontBytes.delete(family);
}

/** Read stored or session-only bytes so a frozen project can embed the face. */
export async function getCustomFontBytes(family: string): Promise<ArrayBuffer | null> {
  const inMemory = sessionFontBytes.get(family);
  if (inMemory) return inMemory.slice(0);
  if (typeof indexedDB === "undefined") return null;

  const db = await openFontsDatabase();
  if (!db) return null;
  try {
    const record = await new Promise<StoredCustomFontRecord | undefined>((resolve, reject) => {
      const request = db.transaction(FONT_STORE, "readonly")
        .objectStore(FONT_STORE)
        .get(family) as IDBRequest<StoredCustomFontRecord | undefined>;
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not read custom font bytes"));
    });
    if (record?.data instanceof ArrayBuffer) return record.data.slice(0);
    if (record?.data instanceof Blob) return await record.data.arrayBuffer();
    return null;
  } finally {
    db.close();
  }
}

function openFontsDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(LEGACY_CUSTOM_FONTS_DB_NAME, DB_VERSION);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FONT_STORE)) {
        db.createObjectStore(FONT_STORE, { keyPath: "family" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/** Persisted font families only; in-memory-only FontFaces are not recoverable after restart. */
export async function listPersistedCustomFontFamilies(): Promise<Set<string>> {
  if (typeof indexedDB === "undefined") return new Set();

  return new Promise((resolve) => {
    void openFontsDatabase().then((db) => {
      if (!db) {
        resolve(new Set());
        return;
      }
      try {
        const transaction = db.transaction(FONT_STORE, "readonly");
        const read = transaction.objectStore(FONT_STORE).getAll() as IDBRequest<StoredCustomFontRecord[]>;
        read.onsuccess = () => {
          resolve(new Set(read.result
            .map((record) => record.family)
            .filter((family): family is string => typeof family === "string" && family.length > 0)));
          db.close();
        };
        read.onerror = () => {
          db.close();
          resolve(new Set());
        };
      } catch {
        db.close();
        resolve(new Set());
      }
    });
  });
}
