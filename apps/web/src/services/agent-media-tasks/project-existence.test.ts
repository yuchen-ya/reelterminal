/**
 * Regression guard: the target-project existence oracle answers from the
 * `projects` object store of `openreel-projects` — never from the evictable
 * recent-projects list. A project that fell out of the recent list must
 * still count as existing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { checkProjectExists } from "./project-existence";

interface FakeRecord {
  key: string;
}

class FakeStore {
  readonly rows = new Map<string, FakeRecord>();
  count(key: string): FakeRequest {
    const request = new FakeRequest();
    const found = this.rows.has(key) ? 1 : 0;
    // Requests settle asynchronously, like real IndexedDB.
    setTimeout(() => {
      request.result = found;
      request.onsuccess?.();
    }, 0);
    return request;
  }
}

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  constructor(private readonly store: FakeStore | null) {}
  objectStore(): FakeStore {
    if (!this.store) throw new Error("no store");
    return this.store;
  }
}

class FakeDb {
  readonly stores: Map<string, FakeStore>;
  constructor(
    readonly version: number,
    storeNames: readonly string[],
  ) {
    this.stores = new Map(storeNames.map((name) => [name, new FakeStore()]));
  }
  get objectStoreNames(): { contains(name: string): boolean } {
    const names = new Set(this.stores.keys());
    return { contains: (name: string) => names.has(name) };
  }
  transaction(): FakeTransaction {
    return new FakeTransaction(this.stores.get("projects") ?? null);
  }
  close(): void {}
}

function installFakeIdb(db: FakeDb | null, failOpen = false): void {
  const indexedDb = {
    open(name: string): FakeRequest {
      const request = new FakeRequest();
      if (failOpen) {
        setTimeout(() => {
          request.error = new Error("open refused");
          request.onerror?.();
        }, 0);
        return request;
      }
      setTimeout(() => {
        request.result = db;
        request.onsuccess?.();
      }, 0);
      void name;
      return request;
    },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = indexedDb;
}


const globalWithIdb = globalThis as { indexedDB?: unknown };
const originalIdb = globalWithIdb.indexedDB;

afterEach(() => {
  // jsdom defines indexedDB non-configurably; restore instead of delete.
  globalWithIdb.indexedDB = originalIdb;
});

describe("checkProjectExists (N1 oracle)", () => {
  it("reports exists for a project id in the projects store", async () => {
    const db = new FakeDb(1, ["projects", "recent"]);
    db.stores.get("projects")!.rows.set("proj-1", { key: "proj-1" });
    installFakeIdb(db);
    await expect(checkProjectExists("proj-1")).resolves.toEqual({ status: "exists" });
  });

  it("reports missing when the id is absent — even if absent from recent too", async () => {
    const db = new FakeDb(1, ["projects", "recent"]);
    db.stores.get("recent")!.rows.set("recent-only", { key: "recent-only" });
    installFakeIdb(db);
    await expect(checkProjectExists("proj-gone")).resolves.toEqual({ status: "missing" });
  });

  it("reports missing on a version-1 database without the projects store", async () => {
    installFakeIdb(new FakeDb(1, ["recent"]));
    await expect(checkProjectExists("proj-1")).resolves.toEqual({ status: "missing" });
  });

  it("answers unknown on an unexpected schema version (never guesses)", async () => {
    installFakeIdb(new FakeDb(2, []));
    await expect(checkProjectExists("proj-1")).resolves.toEqual({ status: "unknown" });
  });

  it("answers unknown when the database cannot be opened", async () => {
    installFakeIdb(null, true);
    await expect(checkProjectExists("proj-1")).resolves.toEqual({ status: "unknown" });
  });

  it("answers unknown without any IndexedDB at all", async () => {
    globalWithIdb.indexedDB = undefined;
    await expect(checkProjectExists("proj-1")).resolves.toEqual({ status: "unknown" });
  });
});
