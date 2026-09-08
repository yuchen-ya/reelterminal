/**
 * Renderer-side material bridge contract: verb routing, param coercion,
 * error envelopes, and the attach idempotency ledger. Uses the in-memory
 * MaterialStorage fake; the canonical service logic itself is covered by
 * library-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialStorage, MaterialStorageCommit } from "../material-library/storage";
import {
  MaterialLibraryService,
  setMaterialLibraryServiceForTests,
} from "../material-library/library-service";
import { handleMaterialLibraryRequest } from "./material-bridge";

class MemoryStorage implements MaterialStorage {
  readonly materials = new Map<string, unknown>();
  readonly journal = new Map<string, unknown>();
  readonly blobs = new Map<string, Blob>();

  async loadAllMaterials(): Promise<unknown[]> {
    return [...this.materials.values()];
  }
  async loadJournal(): Promise<unknown[]> {
    return [...this.journal.values()];
  }
  async loadBlob(id: string): Promise<Blob | null> {
    return this.blobs.get(id) ?? null;
  }
  async commit(change: MaterialStorageCommit): Promise<void> {
    for (const record of change.materialUpserts ?? []) {
      this.materials.set(record.id, JSON.parse(JSON.stringify(record)));
    }
    for (const id of change.materialDeletes ?? []) this.materials.delete(id);
    for (const put of change.blobPuts ?? []) this.blobs.set(put.id, put.blob);
    for (const id of change.blobDeletes ?? []) this.blobs.delete(id);
    for (const entry of change.journalUpserts ?? []) {
      this.journal.set(entry.id, JSON.parse(JSON.stringify(entry)));
    }
    for (const id of change.journalDeletes ?? []) this.journal.delete(id);
  }
}

const NOW = "2026-09-08T10:00:00.000Z";

describe("handleMaterialLibraryRequest", () => {
  let service: MaterialLibraryService;

  beforeEach(() => {
    service = new MaterialLibraryService(new MemoryStorage());
    setMaterialLibraryServiceForTests(service);
  });

  it("routes list with defaults and filters", async () => {
    await service.create(
      { kind: "link", url: "https://example.com/a", nowIso: NOW },
      "user",
    );
    const reply = await handleMaterialLibraryRequest({
      verb: "list",
      params: { kind: "link", query: "example" },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as { total: number; items: unknown[] };
      expect(value.total).toBe(1);
    }
  });

  it("creates agent entries and returns the journal entry id", async () => {
    const reply = await handleMaterialLibraryRequest({
      verb: "create",
      params: {
        kind: "method",
        prompt: "Assemble highlights",
        skillName: "highlight-reel",
        tags: ["workflow"],
      },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as {
        material: { updatedBy: string; source: { addedBy: string } };
        journalEntryId: string;
      };
      expect(value.material.updatedBy).toBe("agent");
      expect(value.material.source.addedBy).toBe("agent");
      expect(value.journalEntryId).toBeTruthy();
    }
  });

  it("rejects invalid verbs and missing ids with structured errors", async () => {
    const unknown = await handleMaterialLibraryRequest({ verb: "explode" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("INVALID_PARAMS");

    const missingId = await handleMaterialLibraryRequest({
      verb: "get",
      params: {},
    });
    expect(missingId.ok).toBe(false);
    if (!missingId.ok) expect(missingId.error.code).toBe("INVALID_PARAMS");

    const notFound = await handleMaterialLibraryRequest({
      verb: "get",
      params: { id: "mat_none" },
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("NOT_FOUND");
  });

  it("batchUpdate maps item fields into patches and is all-or-nothing", async () => {
    const created = await service.create(
      { kind: "link", url: "https://example.com/x", nowIso: NOW },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const reply = await handleMaterialLibraryRequest({
      verb: "batchUpdate",
      params: {
        updates: [
          {
            id: created.value.material.id,
            aiSummary: "agent summary",
            tags: ["tagged"],
            organizeStatus: "organized",
          },
          { id: "mat_missing", tags: ["x"] },
        ],
      },
    });
    expect(reply.ok).toBe(false); // second item missing ⇒ whole batch rejected
    if (!reply.ok) {
      expect(reply.error.code).toBe("INVALID_PARAMS");
      const details = reply.error.details as { items: Array<{ id: string; code: string }> };
      expect(details.items[0].code).toBe("NOT_FOUND");
    }
    const record = await service.get(created.value.material.id);
    if (record.ok) {
      expect(record.value.aiSummary).toBe("");
    }

    const okReply = await handleMaterialLibraryRequest({
      verb: "batchUpdate",
      params: {
        updates: [
          {
            id: created.value.material.id,
            aiSummary: "agent summary",
            tags: ["tagged"],
            organizeStatus: "organized",
          },
        ],
      },
    });
    expect(okReply.ok).toBe(true);
  });

  it("undo routes to the library journal", async () => {
    const created = await service.create(
      { kind: "link", url: "https://example.com/y", nowIso: NOW },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    await service.update(
      created.value.material.id,
      { aiSummary: "changed" },
      "agent",
    );
    const reply = await handleMaterialLibraryRequest({
      verb: "undo",
      params: {},
    });
    expect(reply.ok).toBe(true);
    const record = await service.get(created.value.material.id);
    if (record.ok) expect(record.value.aiSummary).toBe("");
  });

  it("attach requires a materialId and reports typed failures", async () => {
    const reply = await handleMaterialLibraryRequest({
      verb: "attach",
      params: {},
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INVALID_PARAMS");

    const notFound = await handleMaterialLibraryRequest({
      verb: "attach",
      params: { materialId: "mat_none" },
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe("NOT_FOUND");
  });

  it("dispatches a library-changed window event after mutations", async () => {
    const listener = vi.fn();
    window.addEventListener("openreel:material-library-changed", listener);
    await handleMaterialLibraryRequest({
      verb: "create",
      params: { kind: "link", url: "https://example.com/evt" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    // Reads never fire it.
    await handleMaterialLibraryRequest({ verb: "list", params: {} });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("openreel:material-library-changed", listener);
  });
});
