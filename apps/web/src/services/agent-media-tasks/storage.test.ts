/**
 * Exercises the real IndexedDB storage implementation against a compact
 * in-memory emulation of the IDB surface this module uses (open/upgrade,
 * getAll, put, delete, transaction completion). jsdom has no IndexedDB and
 * adding an emulator dependency is out of scope for this package.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_TASKS_DB_NAME,
  AgentTaskStorageUnavailableError,
  createIdbAgentTaskStorage,
} from "./storage";
import type { AgentMediaTaskRecord } from "./types";

type Row = Record<string, unknown>;

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, Row>>;
}

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onupgradeneeded: ((event?: unknown) => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

function makeRecord(id: string, requestId: string): AgentMediaTaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    recordVersion: 1,
    requestId,
    kind: "tts",
    promptText: "text",
    status: "queued",
    targetProjectId: "proj-1",
    insertIntent: "timeline",
    autoConfirm: "receipt",
    attempt: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Minimal IDB emulation: open+upgrade, single-store reads/writes inside one
 * transaction whose `complete` event fires after every queued request
 * succeeded.
 */
/** Current fake install's saved original (restored after each test). */
let previousIndexedDb: unknown;

function installFakeIndexedDb(options: { failOpen?: boolean } = {}) {
  const databases = new Map<string, FakeDbState>();

  const makeDb = (state: FakeDbState) => ({
    objectStoreNames: {
      contains: (name: string) => state.stores.has(name),
    },
    createObjectStore(name: string) {
      state.stores.set(name, new Map());
      return { createIndex: () => undefined };
    },
    transaction(
      _storeNames: readonly string[],
      _mode: "readonly" | "readwrite",
    ) {
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore(name: string) {
          const rows = state.stores.get(name);
          if (!rows) {
            throw new Error(`no such store ${name}`);
          }
          let pending = 0;
          let failed = false;
          const settle = (request: FakeRequest, produce: () => void) => {
            pending += 1;
            queueMicrotask(() => {
              try {
                produce();
                request.onsuccess?.();
              } catch (error) {
                failed = true;
                request.error = error instanceof Error ? error : new Error(String(error));
                request.onerror?.();
                transaction.onabort?.();
              } finally {
                pending -= 1;
                if (pending === 0 && !failed) {
                  queueMicrotask(() => transaction.oncomplete?.());
                }
              }
            });
            return request;
          };
          return {
            getAll() {
              const request: FakeRequest = {
                result: undefined,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
              };
              return settle(request, () => {
                request.result = [...rows.values()];
              });
            },
            get(key: string) {
              const request: FakeRequest = {
                result: undefined,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
              };
              return settle(request, () => {
                request.result = rows.get(key);
              });
            },
            put(value: Row) {
              const request: FakeRequest = {
                result: undefined,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
              };
              return settle(request, () => {
                rows.set(value.id as string, value);
              });
            },
            delete(key: string) {
              const request: FakeRequest = {
                result: undefined,
                error: null,
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
                onblocked: null,
              };
              return settle(request, () => {
                rows.delete(key);
              });
            },
          };
        },
      };
      return transaction;
    },
  });

  const fake = {
    open(name: string, version: number) {
      const request: FakeRequest = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (options.failOpen) {
          request.error = new Error("open refused");
          request.onerror?.();
          return;
        }
        let state = databases.get(name);
        if (!state) {
          state = { version: 0, stores: new Map() };
          databases.set(name, state);
        }
        if (version > state.version) {
          state.version = version;
        }
        const db = makeDb(state);
        request.result = db;
        if (state.version === version && !state.stores.has("tasks")) {
          // Upgrade runs against request.result, exactly like real IDB.
          request.onupgradeneeded?.({ target: request });
        }
        request.onsuccess?.();
      });
      return request;
    },
  };

  // jsdom exposes `indexedDB` as writable-but-not-configurable, so the fake
  // is swapped in by assignment (vi.stubGlobal would throw on redefine).
  previousIndexedDb = globalThis.indexedDB;
  globalThis.indexedDB = fake as unknown as IDBFactory;
  return databases;
}

describe("createIdbAgentTaskStorage", () => {
  beforeEach(() => {
    installFakeIndexedDb();
  });

  afterEach(() => {
    globalThis.indexedDB = previousIndexedDb as IDBFactory;
  });

  it("creates the store on first open and loads an empty list", async () => {
    const storage = createIdbAgentTaskStorage();
    await expect(storage.loadAll()).resolves.toEqual([]);
  });

  it("commits upserts and deletes atomically, then reads them back", async () => {
    const storage = createIdbAgentTaskStorage();
    const first = makeRecord("amt_1", "req_1");
    const second = makeRecord("amt_2", "req_2");

    await storage.commit([first, second], []);
    let rows = (await storage.loadAll()) as AgentMediaTaskRecord[];
    expect(rows.map((row) => row.id).sort()).toEqual(["amt_1", "amt_2"]);

    const updated = { ...first, status: "submitted" as const, revision: 2 };
    await storage.commit([updated], ["amt_2"]);
    rows = (await storage.loadAll()) as AgentMediaTaskRecord[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("amt_1");
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].revision).toBe(2);
  });

  it("survives a storage instance reload (database persists across opens)", async () => {
    const first = createIdbAgentTaskStorage();
    await first.commit([makeRecord("amt_keep", "req_keep")], []);
    const second = createIdbAgentTaskStorage();
    const rows = (await second.loadAll()) as AgentMediaTaskRecord[];
    expect(rows.map((row) => row.id)).toEqual(["amt_keep"]);
  });

  it("rejects with UNAVAILABLE when IndexedDB is missing", async () => {
    globalThis.indexedDB = undefined as unknown as IDBFactory;
    const storage = createIdbAgentTaskStorage();
    await expect(storage.loadAll()).rejects.toBeInstanceOf(AgentTaskStorageUnavailableError);
    await expect(storage.commit([makeRecord("a", "b")], [])).rejects.toBeInstanceOf(
      AgentTaskStorageUnavailableError,
    );
  });

  it("rejects with UNAVAILABLE when open fails", async () => {
    installFakeIndexedDb({ failOpen: true });
    const storage = createIdbAgentTaskStorage();
    await expect(storage.loadAll()).rejects.toBeInstanceOf(AgentTaskStorageUnavailableError);
  });

  it("uses the documented database name", () => {
    expect(AGENT_TASKS_DB_NAME).toBe("openreel-agent-tasks");
  });
});
