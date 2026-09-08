import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaterialJournalEntry,
  MaterialRecord,
} from "@openreel/core";
import { MaterialLibraryService } from "./library-service";
import type { MaterialStorage, MaterialStorageCommit } from "./storage";

class MemoryMaterialStorage implements MaterialStorage {
  readonly materials = new Map<string, unknown>();
  readonly journal = new Map<string, unknown>();
  readonly blobs = new Map<string, Blob>();
  readonly commits: MaterialStorageCommit[] = [];

  async loadAllMaterials(): Promise<unknown[]> {
    return [...this.materials.values()];
  }

  async loadJournal(): Promise<unknown[]> {
    return [...this.journal.values()];
  }

  async loadBlob(materialId: string): Promise<Blob | null> {
    return this.blobs.get(materialId) ?? null;
  }

  async commit(change: MaterialStorageCommit): Promise<void> {
    this.commits.push(change);
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

describe("MaterialLibraryService", () => {
  let storage: MemoryMaterialStorage;
  let service: MaterialLibraryService;

  beforeEach(() => {
    storage = new MemoryMaterialStorage();
    service = new MaterialLibraryService(storage);
  });

  async function seedMedia(): Promise<MaterialRecord> {
    const result = await service.create(
      {
        kind: "media",
        title: "Trip footage",
        tags: ["trip"],
        mediaType: "video",
        fileRef: {
          type: "path",
          path: "/Volumes/media/trip.mp4",
          fileName: "trip.mp4",
        },
        metadata: { durationSec: 60 },
        nowIso: NOW,
      },
      "user",
    );
    if (!result.ok) throw new Error(result.message);
    return result.value.material;
  }

  it("creates records, journals them, and persists in one transaction", async () => {
    const media = await seedMedia();
    expect(media.kind).toBe("media");
    expect(storage.materials.size).toBe(1);
    expect(storage.commits).toHaveLength(1);
    // The single create commit carries record + journal together.
    expect(storage.commits[0].materialUpserts).toHaveLength(1);
    expect(storage.commits[0].journalUpserts).toHaveLength(1);

    const journal = await service.journal();
    if (!journal.ok) throw new Error(journal.message);
    expect(journal.value[0].actor).toBe("user");
    expect(journal.value[0].changes[0].before).toBeNull();
  });

  it("reloads persisted state through a fresh service instance", async () => {
    await seedMedia();
    const link = await service.create(
      { kind: "link", url: "https://example.com/guide", nowIso: NOW },
      "user",
    );
    if (!link.ok) throw new Error(link.message);

    const reloaded = new MaterialLibraryService(storage);
    const list = await reloaded.list({ page: 1, pageSize: 10 });
    if (!list.ok) throw new Error(list.message);
    expect(list.value.total).toBe(2);
    expect(list.value.items.map((item) => item.kind).sort()).toEqual(["link", "media"]);

    const journals = await reloaded.journal();
    if (!journals.ok) throw new Error(journals.message);
    expect(journals.value).toHaveLength(2);
  });

  it("stores the library-owned blob copy for blob-backed media", async () => {
    const blob = new Blob(["fake-bytes"], { type: "video/mp4" });
    const result = await service.create(
      {
        kind: "media",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "screen.mp4" },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!result.ok) throw new Error(result.message);
    expect(storage.blobs.get(result.value.material.id)).toBe(blob);
    expect(await service.loadBlobFor(result.value.material.id)).toBe(blob);
  });

  it("rejects invalid creates with structured errors", async () => {
    const badUrl = await service.create(
      { kind: "link", url: "not-a-url", nowIso: NOW },
      "agent",
    );
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.code).toBe("INVALID_PARAMS");

    const missingParent = await service.create(
      { kind: "segment", parentMaterialId: "mat_none", startSec: 0, endSec: 5, nowIso: NOW },
      "agent",
    );
    expect(missingParent.ok).toBe(false);
    if (!missingParent.ok) expect(missingParent.code).toBe("NOT_FOUND");
  });

  it("validates segment ranges against the parent duration", async () => {
    const media = await seedMedia(); // durationSec 60
    const beyond = await service.create(
      {
        kind: "segment",
        parentMaterialId: media.id,
        startSec: 50,
        endSec: 90,
        nowIso: NOW,
      },
      "user",
    );
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.code).toBe("INVALID_PARAMS");

    const ok = await service.create(
      {
        kind: "segment",
        parentMaterialId: media.id,
        startSec: 10,
        endSec: 25,
        title: "Sunset part",
        nowIso: NOW,
      },
      "user",
    );
    expect(ok.ok).toBe(true);
  });

  it("enforces per-record CAS on update and never lets agents touch userNotes", async () => {
    const media = await seedMedia();
    const updated = await service.update(
      media.id,
      { userNotes: "user note" },
      "user",
      1,
    );
    expect(updated.ok).toBe(true);

    const stale = await service.update(
      media.id,
      { aiSummary: "agent summary" },
      "agent",
      1,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("CONFLICT");
      expect(stale.details?.currentRevision).toBe(2);
    }

    const fresh = await service.update(
      media.id,
      { aiSummary: "agent summary", userNotes: "hijack" },
      "agent",
      2,
    );
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.value.material.aiSummary).toBe("agent summary");
      expect(fresh.value.material.userNotes).toBe("user note");
      expect(fresh.value.material.updatedBy).toBe("agent");
      expect(fresh.value.material.lastAgentEditAt).toBeDefined();
    }
  });

  it("batch update is all-or-nothing under conflicts", async () => {
    const media = await seedMedia();
    const link = await service.create(
      { kind: "link", url: "https://example.com/x", nowIso: NOW },
      "user",
    );
    if (!link.ok) throw new Error(link.message);
    const linkId = link.value.material.id;

    const conflicted = await service.batchUpdate(
      [
        { id: media.id, patch: { tags: ["a"] }, expectedRevision: 1 },
        { id: linkId, patch: { tags: ["b"] }, expectedRevision: 99 },
      ],
      "agent",
      "material.batch_update",
    );
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) {
      expect(conflicted.code).toBe("CONFLICT");
      // Nothing applied.
      const after = await service.get(media.id);
      if (after.ok) expect(after.value.tags).toEqual(["trip"]);
    }

    const applied = await service.batchUpdate(
      [
        { id: media.id, patch: { tags: ["agent-tag"], organizeStatus: "organized" } },
        { id: linkId, patch: { aiSummary: "summarized" } },
      ],
      "agent",
      "material.batch_update",
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.journalEntryId).toBeTruthy();
    const journal = await service.journal();
    if (!journal.ok) throw new Error(journal.message);
    const latest = journal.value[0] as MaterialJournalEntry;
    expect(latest.verb).toBe("material.batch_update");
    expect(latest.materialIds).toHaveLength(2);
  });

  it("undo restores an agent batch exactly, including userNotes separation", async () => {
    const media = await seedMedia();
    await service.update(media.id, { userNotes: "user note" }, "user", 1);
    await service.batchUpdate(
      [
        {
          id: media.id,
          patch: { aiSummary: "agent says", tags: ["agent-tag"], organizeStatus: "organized" },
        },
      ],
      "agent",
      "material.batch_update",
    );

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.value.restored).toEqual([media.id]);
    }
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.aiSummary).toBe("");
    expect(after.value.tags).toEqual(["trip"]);
    expect(after.value.organizeStatus).toBe("inbox");
    // The user note written BEFORE the agent batch survives the undo.
    expect(after.value.userNotes).toBe("user note");
    expect(after.value.revision).toBe(2);

    const journal = await service.journal();
    if (!journal.ok) throw new Error(journal.message);
    const undoneEntry = journal.value.find((entry) => entry.verb === "material.batch_update");
    expect(undoneEntry?.undone).toBe(true);
  });

  it("undoing a content batch keeps usage records (provenance is outside the journal)", async () => {
    const media = await seedMedia();
    await service.batchUpdate(
      [{ id: media.id, patch: { aiSummary: "agent summary" } }],
      "agent",
      "material.batch_update",
    );
    // A usage lands AFTER the batch (an attach that happened meanwhile).
    await service.recordUsage(media.id, {
      projectId: "proj-9",
      mediaIdInProject: "m9",
      attachedAt: NOW,
      attachedBy: "agent",
    });
    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.aiSummary).toBe(""); // content reverted…
    expect(after.value.usages).toHaveLength(1); // …but attach history kept
    expect(after.value.usages[0].projectId).toBe("proj-9");
  });

  it("undo of undo (redo) restores the agent state", async () => {
    const media = await seedMedia();
    await service.update(media.id, { aiSummary: "agent v1" }, "agent", 1);
    const firstUndo = await service.undo(undefined, "user");
    if (!firstUndo.ok) throw new Error(firstUndo.message);
    const secondUndo = await service.undo(undefined, "user");
    expect(secondUndo.ok).toBe(true);
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.aiSummary).toBe("agent v1");
  });

  it("blocks removal of referenced materials without force and cascades segments", async () => {
    const media = await seedMedia();
    const segment = await service.create(
      {
        kind: "segment",
        parentMaterialId: media.id,
        startSec: 1,
        endSec: 2,
        nowIso: NOW,
      },
      "user",
    );
    if (!segment.ok) throw new Error(segment.message);
    await service.recordUsage(media.id, {
      projectId: "proj-1",
      mediaIdInProject: "m1",
      attachedAt: NOW,
      attachedBy: "user",
    });

    const blocked = await service.remove(media.id, {}, "user");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("CONFLICT");
      expect(blocked.details?.usageCount).toBe(1);
    }

    const forced = await service.remove(media.id, { force: true }, "user");
    expect(forced.ok).toBe(true);
    if (forced.ok) {
      expect(forced.value.removedIds).toHaveLength(2); // media + cascaded segment
    }
    const remaining = await service.list({ page: 1, pageSize: 10 });
    if (!remaining.ok) throw new Error(remaining.message);
    expect(remaining.value.total).toBe(0);

    // Undo brings both back.
    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    const restored = await service.list({ page: 1, pageSize: 10 });
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.value.total).toBe(2);
  });

  it("reclaims only the library's own blob copy on removal, never a path original", async () => {
    const blob = new Blob(["x"]);
    const created = await service.create(
      {
        kind: "media",
        mediaType: "image",
        fileRef: { type: "blob", fileName: "pic.png" },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    await service.remove(created.value.material.id, {}, "user");
    expect(storage.blobs.has(created.value.material.id)).toBe(false);

    const pathMedia = await seedMedia();
    await service.remove(pathMedia.id, {}, "user");
    // Nothing to delete for a path reference — the file is the user's.
    expect(storage.blobs.has(pathMedia.id)).toBe(false);
  });

  it("recordUsage dedupes per project+media pair", async () => {
    const media = await seedMedia();
    await service.recordUsage(media.id, {
      projectId: "p1",
      mediaIdInProject: "m1",
      attachedAt: NOW,
      attachedBy: "user",
    });
    await service.recordUsage(media.id, {
      projectId: "p1",
      mediaIdInProject: "m1",
      attachedAt: NOW,
      attachedBy: "agent",
    });
    await service.recordUsage(media.id, {
      projectId: "p2",
      mediaIdInProject: "m2",
      attachedAt: NOW,
      attachedBy: "user",
    });
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.usages).toHaveLength(2);
    expect(after.value.usages[0].attachedBy).toBe("agent");
  });

  it("lists with search, filters, and pagination without touching blobs", async () => {
    await seedMedia(); // Trip footage
    await service.create(
      {
        kind: "method",
        title: "Highlight method",
        prompt: "pick best moments",
        tags: ["workflow"],
        nowIso: NOW,
      },
      "user",
    );
    const result = await service.list({
      query: "moments",
      page: 1,
      pageSize: 10,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.total).toBe(1);
    expect(result.value.items[0].title).toBe("Highlight method");
    expect(result.value.allTags).toEqual(["trip", "workflow"]);

    const inbox = await service.list({
      status: "inbox",
      page: 1,
      pageSize: 1,
    });
    if (!inbox.ok) throw new Error(inbox.message);
    expect(inbox.value.total).toBe(2);
    expect(inbox.value.items).toHaveLength(1);
    expect(inbox.value.totalPages).toBe(2);
    expect(storage.blobs.size).toBe(0); // no blob reads during listing
  });

  it("addTags merges without dropping existing tags", async () => {
    const media = await seedMedia();
    const result = await service.addTags([media.id], ["color", "Trip"], "user");
    expect(result.ok).toBe(true);
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.tags).toEqual(["trip", "color"]);
  });

  it("serializes concurrent mutations in arrival order", async () => {
    const media = await seedMedia();
    const first = service.update(media.id, { aiSummary: "one" }, "agent", 1);
    const second = service.update(media.id, { aiSummary: "two" }, "agent", undefined);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.aiSummary).toBe("two");
    expect(after.value.revision).toBe(3);
  });
});
