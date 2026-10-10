import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { StorageEngine } from "./storage-engine";
import type { MediaRecord } from "./types";
import type { MediaMetadata } from "../types";

const metadata: MediaMetadata = {
  duration: 1,
  width: 640,
  height: 360,
  frameRate: 30,
  codec: "h264",
  sampleRate: 0,
  channels: 0,
  fileSize: 3,
};

function mediaRecord(
  id: string,
  projectId: string,
  bytes: number[],
  contentHash: string,
): MediaRecord {
  return {
    id,
    projectId,
    blob: new Blob([new Uint8Array(bytes)]),
    metadata,
    contentHash,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/**
 * The engine observes a plain request object with `error`/`onsuccess`/
 * `onerror`, so the simulated failure is delivered through such an object
 * while the real request drives the transaction lifecycle (the engine's
 * request error is recorded before the abort settles the promise, exactly
 * like a real IndexedDB request failure).
 */
function simulatedRequest() {
  return {
    error: null as unknown,
    result: undefined as unknown,
    onsuccess: undefined as unknown,
    onerror: undefined as unknown,
    deliver(errorName: string): void {
      this.error = new DOMException(`simulated ${errorName}`, errorName);
      (this.onerror as ((event: Event) => void) | undefined)?.(new Event("error"));
    },
  };
}

/**
 * Make the next `add` (a fresh write that really succeeds) report
 * `errorName` to the engine and abort the transaction from inside the real
 * request's success event — legal per the IndexedDB spec — mirroring a
 * failure between request success and commit (e.g. quota at commit time).
 */
function failNextFreshAdd(errorName: string): void {
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
    IDBObjectStore.prototype.add = originalAdd;
    const realRequest = originalAdd.apply(this, args);
    const simulated = simulatedRequest();
    realRequest.addEventListener("success", () => {
      simulated.deliver(errorName);
      this.transaction.abort();
    });
    return simulated as unknown as IDBRequest<IDBValidKey>;
  };
}

/**
 * Make the next `add` (a replay that really fails the duplicate key) report
 * `errorName` instead: the real ConstraintError event fires the simulated
 * request error first and then aborts the transaction through its default
 * action, exactly as a real request failure does (request `error` before
 * transaction `abort`).
 */
function failNextDuplicateAdd(errorName: string): void {
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
    IDBObjectStore.prototype.add = originalAdd;
    const realRequest = originalAdd.apply(this, args);
    const simulated = simulatedRequest();
    realRequest.addEventListener("error", () => {
      simulated.deliver(errorName);
    });
    return simulated as unknown as IDBRequest<IDBValidKey>;
  };
}

/** Abort the transaction from inside the next `add` request's success event. */
function abortTransactionAfterNextAddCompletes(): void {
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<typeof originalAdd>) {
    IDBObjectStore.prototype.add = originalAdd;
    const realRequest = originalAdd.apply(this, args);
    realRequest.addEventListener("success", () => {
      this.transaction.abort();
    });
    return realRequest;
  };
}

describe("StorageEngine media immutability and transaction semantics", () => {
  let engine: StorageEngine;

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    engine = new StorageEngine();
  });

  afterEach(() => {
    engine.close();
    vi.unstubAllGlobals();
  });

  it("merges a byte-identical replay of the same media id across projects", async () => {
    await engine.saveMedia(mediaRecord("media-1", "project-a", [1, 2, 3], "hash-a"));
    // Second add hits the real duplicate key (ConstraintError) and must take the merge path.
    await engine.saveMedia(mediaRecord("media-1", "project-b", [1, 2, 3], "hash-a"));

    const stored = await engine.loadMedia("media-1");
    expect(stored).not.toBeNull();
    expect([...(stored?.projectIds ?? [])].sort()).toEqual(["project-a", "project-b"]);
  });

  it("rejects a different-bytes write for an existing media id", async () => {
    await engine.saveMedia(mediaRecord("media-1", "project-a", [1, 2, 3], "hash-a"));

    const failure = await rejectionOf(
      engine.saveMedia(mediaRecord("media-1", "project-a", [9, 9, 9], "hash-b")),
    );
    expect((failure as Error).message).toContain("is immutable and already contains different bytes");

    const stored = await engine.loadMedia("media-1");
    expect(stored?.contentHash).toBe("hash-a");
  });

  it("propagates a QuotaExceededError on a duplicate add without the merge path", async () => {
    // A record with this id already exists, so the old code's catch-all
    // duplicate merge would have converted this failure into a success.
    await engine.saveMedia(mediaRecord("media-1", "project-a", [1, 2, 3], "hash-a"));
    failNextDuplicateAdd("QuotaExceededError");

    const failure = (await rejectionOf(
      engine.saveMedia(mediaRecord("media-1", "project-b", [1, 2, 3], "hash-a")),
    )) as { code?: string; name?: string; cause?: unknown };

    // Must not become a success and must keep the original error identity.
    expect(failure.code).toBe("QUOTA_EXCEEDED");
    expect(failure.name).toBe("QuotaExceededError");
    expect(failure.cause).toBeInstanceOf(DOMException);
    expect((failure.cause as DOMException).name).toBe("QuotaExceededError");

    // The duplicate-merge path must not have added project-b.
    const stored = await engine.loadMedia("media-1");
    expect(stored?.projectIds).toEqual(["project-a"]);
  });

  it("propagates an AbortError add failure with preserved identity", async () => {
    failNextFreshAdd("AbortError");

    const failure = (await rejectionOf(
      engine.saveMedia(mediaRecord("media-1", "project-a", [1, 2, 3], "hash-a")),
    )) as { code?: string; name?: string; cause?: unknown };

    expect(failure.code).toBe("DATABASE_ERROR");
    expect(failure.name).toBe("AbortError");
    expect((failure.cause as DOMException).name).toBe("AbortError");

    // The aborted write must not be visible.
    expect(await engine.loadMedia("media-1")).toBeNull();
  });

  it("rejects when the transaction aborts after the add request succeeded", async () => {
    abortTransactionAfterNextAddCompletes();

    const failure = (await rejectionOf(
      engine.saveMedia(mediaRecord("media-1", "project-a", [1, 2, 3], "hash-a")),
    )) as { code?: string; name?: string; cause?: unknown };

    expect(failure.code).toBe("DATABASE_ERROR");
    expect(failure.name).toBe("AbortError");

    // Rolled back: the request-level success must not surface as data.
    expect(await engine.loadMedia("media-1")).toBeNull();
  });
});
