import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaterialJournalEntry,
  MaterialRecord,
  MediaItem,
  Project,
} from "@reelterminal/core";
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
    this.apply(change);
  }

  /** Applies a commit exactly like the service's single IDB transaction. */
  apply(change: MaterialStorageCommit): void {
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

/**
 * Failure-injection wrapper: the wrapped commit throws BEFORE any store is
 * touched, so a half-applied batch is impossible by construction — exactly
 * what an aborted IndexedDB transaction guarantees.
 */
class FailingCommitStorage implements MaterialStorage {
  constructor(
    private readonly inner: MemoryMaterialStorage,
    private readonly shouldFail: (change: MaterialStorageCommit) => boolean,
  ) {}

  async loadAllMaterials(): Promise<unknown[]> {
    return this.inner.loadAllMaterials();
  }

  async loadJournal(): Promise<unknown[]> {
    return this.inner.loadJournal();
  }

  async loadBlob(materialId: string): Promise<Blob | null> {
    return this.inner.loadBlob(materialId);
  }

  async commit(change: MaterialStorageCommit): Promise<void> {
    if (this.shouldFail(change)) throw new Error("idb write failed");
    await this.inner.commit(change);
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

  /** Blob-backed media create: the only kind that stores library bytes. */
  async function seedBlobMedia(
    title: string,
    bytes = "fake-bytes",
  ): Promise<{ id: string; blob: Blob }> {
    const blob = new Blob([bytes], { type: "video/mp4" });
    const result = await service.create(
      {
        kind: "media",
        title,
        mediaType: "video",
        fileRef: { type: "blob", fileName: `${title}.mp4` },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!result.ok) throw new Error(result.message);
    return { id: result.value.material.id, blob };
  }

  /** One journal entry of unrelated noise (a link create) per call. */
  async function addNoiseEntries(
    count: number,
    via: MaterialLibraryService = service,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const noise = await via.create(
        { kind: "link", url: `https://example.com/noise/${index}`, nowIso: NOW },
        "user",
      );
      if (!noise.ok) throw new Error(noise.message);
    }
  }

  function projectSnapshot(
    mediaItems: readonly MediaItem[],
    referencedMediaIds: readonly string[],
  ): Pick<Project, "id" | "name" | "mediaLibrary" | "timeline"> {
    return {
      id: "project-version-test",
      name: "Version test",
      mediaLibrary: { items: [...mediaItems] },
      timeline: {
        duration: 10,
        tracks: [
          {
            id: "track-1",
            name: "Video 1",
            type: "video",
            clips: referencedMediaIds.map((mediaId, index) => ({
              id: `clip-${index}`,
              mediaId,
              trackId: "track-1",
              startTime: index,
              duration: 1,
              inPoint: 0,
              outPoint: 1,
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                opacity: 1,
              },
              effects: [],
              keyframes: [],
              enabled: true,
              volume: 1,
            })),
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
          },
        ],
      },
    } as unknown as Pick<Project, "id" | "name" | "mediaLibrary" | "timeline">;
  }

  function projectMedia(
    id: string,
    path: string,
    extra: Partial<MediaItem> = {},
  ): MediaItem {
    return {
      id,
      name: path.split("/").pop() ?? path,
      type: "video",
      fileHandle: null,
      blob: null,
      originalUrl: path,
      metadata: {
        duration: 10,
        width: 320,
        height: 180,
        frameRate: 30,
        codec: "h264",
        sampleRate: 0,
        channels: 0,
        fileSize: 10,
      },
      thumbnailUrl: null,
      waveformData: null,
      ...extra,
    };
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
      status: "current",
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
      status: "current",
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

  it("keeps the library's own blob copy while a removal is undoable; path originals are never copied or deleted", async () => {
    // A removal must stay fully reversible, so the bytes a redo needs
    // stay in the library during the undo window. Reclamation happens
    // only at journal eviction (see the eviction tests below).
    const { id, blob } = await seedBlobMedia("pic");
    const removed = await service.remove(id, {}, "user");
    expect(removed.ok).toBe(true);
    expect(storage.blobs.has(id)).toBe(true);
    expect(await service.loadBlobFor(id)).toBe(blob);
    // The remove commit itself carries no blob delete anymore.
    const removeCommit = storage.commits[storage.commits.length - 1];
    expect(removeCommit.blobDeletes).toBeUndefined();

    const pathMedia = await seedMedia();
    const pathRemoved = await service.remove(pathMedia.id, {}, "user");
    expect(pathRemoved.ok).toBe(true);
    // Path references have no library bytes at all — nothing was ever
    // copied, so nothing may be deleted (the file is the user's).
    const pathCommit = storage.commits[storage.commits.length - 1];
    expect(pathCommit.blobDeletes).toBeUndefined();
    expect(storage.blobs.has(pathMedia.id)).toBe(false);
  });

  it("undoing a removal restores the record together with its library blob bytes", async () => {
    const { id, blob } = await seedBlobMedia("screen");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    // The bytes were kept across the removal (undo window), so the undo
    // must hand back record AND bytes as one consistent unit.
    expect(storage.blobs.has(id)).toBe(true);

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.value.restored).toEqual([id]);
      expect(undo.value.blobMissingIds).toEqual([]);
    }
    const after = await service.get(id);
    expect(after.ok).toBe(true);
    expect(await service.loadBlobFor(id)).toBe(blob);
  });

  it("undoing a removal still reports historically missing blob bytes honestly", async () => {
    const { id } = await seedBlobMedia("legacy");
    // Simulate bytes lost outside the new contract (e.g. data created
    // before the library kept bytes for its undo window, or an externally
    // deleted row): the journal survives, the blob is gone.
    storage.blobs.delete(id);
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.value.restored).toEqual([id]);
      // The honest-missing report must keep working for such data: the
      // record is back but cannot preview/attach, so callers have to
      // surface a partial restore instead of an unqualified success.
      expect(undo.value.blobMissingIds).toEqual([id]);
    }
    expect(await service.loadBlobFor(id)).toBeNull();
  });

  it("undoing a removal restores the library blob bytes themselves", async () => {
    const { id, blob } = await seedBlobMedia("take");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    const after = await service.get(id);
    expect(after.ok).toBe(true);
    expect(await service.loadBlobFor(id)).toBe(blob);
  });

  it("undoing a creation keeps the blob copy so redo restores the bytes", async () => {
    const { id, blob } = await seedBlobMedia("clip");
    expect(storage.blobs.has(id)).toBe(true);

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (!undo.ok) throw new Error(undo.message);
    expect(undo.value.removed).toEqual([id]);
    // The undo must NOT reclaim the bytes: undoing this very undo entry is
    // a redo that needs them back. Eviction is the only reclaim path now.
    const undoCommit = storage.commits[storage.commits.length - 1];
    expect(undoCommit.blobDeletes).toBeUndefined();
    expect(storage.blobs.has(id)).toBe(true);

    const redo = await service.undo(undo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) {
      expect(redo.value.restored).toEqual([id]);
      expect(redo.value.blobMissingIds).toEqual([]);
    }
    const after = await service.get(id);
    expect(after.ok).toBe(true);
    expect(await service.loadBlobFor(id)).toBe(blob);
  });

  it("redo of an undone removal re-removes the material", async () => {
    const media = await seedMedia();
    const removed = await service.remove(media.id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    const firstUndo = await service.undo(undefined, "user");
    expect(firstUndo.ok).toBe(true);
    if (!firstUndo.ok) throw new Error(firstUndo.message);
    expect(firstUndo.value.restored).toEqual([media.id]);

    // The undo entry must carry the restore as a real change (before: null,
    // after: restored record) so undoing it is an effective redo.
    const journal = await service.journal();
    if (!journal.ok) throw new Error(journal.message);
    const undoEntry = journal.value.find(
      (entry) => entry.id === firstUndo.value.entryId,
    );
    expect(undoEntry).toBeDefined();
    expect(undoEntry?.materialIds).toEqual([media.id]);
    expect(undoEntry?.changes).toHaveLength(1);
    expect(undoEntry?.changes[0].before).toBeNull();
    expect(undoEntry?.changes[0].after?.id).toBe(media.id);

    const redo = await service.undo(firstUndo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) expect(redo.value.removed).toEqual([media.id]);
    const after = await service.get(media.id);
    expect(after.ok).toBe(false);
  });

  it("redo of an undone removal keeps the blob bytes for the next undo", async () => {
    const { id, blob } = await seedBlobMedia("redoable");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    const firstUndo = await service.undo(undefined, "user");
    if (!firstUndo.ok) throw new Error(firstUndo.message);

    const redo = await service.undo(firstUndo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) expect(redo.value.removed).toEqual([id]);
    const after = await service.get(id);
    expect(after.ok).toBe(false);
    // The redo only removes the record; the bytes stay pinned by the still
    // surviving remove/undo journal entries, so the next undo is a full
    // restore again.
    expect(storage.blobs.has(id)).toBe(true);

    const undoAgain = await service.undo(undefined, "user");
    expect(undoAgain.ok).toBe(true);
    if (undoAgain.ok) expect(undoAgain.value.restored).toEqual([id]);
    expect(await service.loadBlobFor(id)).toBe(blob);
  });

  it("redoing an undone creation restores the record with its bytes intact", async () => {
    const { id, blob } = await seedBlobMedia("once");
    const firstUndo = await service.undo(undefined, "user");
    if (!firstUndo.ok) throw new Error(firstUndo.message);
    // The undo of the creation no longer reclaims anything — the redo of
    // it must therefore succeed with bytes, not report missing ones.
    expect(storage.blobs.has(id)).toBe(true);

    const redo = await service.undo(firstUndo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) {
      expect(redo.value.restored).toEqual([id]);
      expect(redo.value.blobMissingIds).toEqual([]);
    }
    expect(await service.loadBlobFor(id)).toBe(blob);
  });

  it("recordUsage dedupes per project+media pair", async () => {
    const media = await seedMedia();
    await service.recordUsage(media.id, {
      projectId: "p1",
      mediaIdInProject: "m1",
      attachedAt: NOW,
      attachedBy: "user",
      status: "current",
    });
    await service.recordUsage(media.id, {
      projectId: "p1",
      mediaIdInProject: "m1",
      attachedAt: NOW,
      attachedBy: "agent",
      status: "current",
    });
    await service.recordUsage(media.id, {
      projectId: "p2",
      mediaIdInProject: "m2",
      attachedAt: NOW,
      attachedBy: "user",
      status: "current",
    });
    const after = await service.get(media.id);
    if (!after.ok) throw new Error(after.message);
    expect(after.value.usages).toHaveLength(2);
    expect(after.value.usages[0].attachedBy).toBe("agent");
  });

  it("reconciles project replacements into current and historical usages", async () => {
    const oldMaterial = await seedMedia();
    const nextCreated = await service.create(
      {
        kind: "media",
        title: "Trip footage v2",
        mediaType: "video",
        fileRef: {
          type: "path",
          path: "/Volumes/media/trip-v2.mp4",
          fileName: "trip-v2.mp4",
        },
        metadata: { durationSec: 60 },
        nowIso: NOW,
      },
      "user",
    );
    if (!nextCreated.ok) throw new Error(nextCreated.message);
    const nextMaterial = nextCreated.value.material;
    await service.recordUsage(oldMaterial.id, {
      projectId: "project-version-test",
      projectName: "Version test",
      mediaIdInProject: "project-media-v1",
      attachedAt: NOW,
      attachedBy: "agent",
      status: "current",
    });

    const oldProjectMedia = projectMedia(
      "project-media-v1",
      "/Volumes/media/trip.mp4",
      {
        materialSource: {
          materialId: oldMaterial.id,
          materialRevision: oldMaterial.revision,
          attachedAt: NOW,
        },
      },
    );
    const nextProjectMedia = projectMedia(
      "project-media-v2",
      "/Volumes/media/trip-v2.mp4",
      {
        versionSource: {
          supersedesMediaIdInProject: oldProjectMedia.id,
          supersedesMaterialId: oldMaterial.id,
          replacedAt: NOW,
        },
      },
    );
    const reconciled = await service.reconcileProjectUsages(
      projectSnapshot([oldProjectMedia, nextProjectMedia], [nextProjectMedia.id]),
    );
    expect(reconciled.ok).toBe(true);

    const oldAfter = await service.get(oldMaterial.id);
    const nextAfter = await service.get(nextMaterial.id);
    if (!oldAfter.ok || !nextAfter.ok) throw new Error("reconcile lookup failed");
    expect(oldAfter.value.usages[0]).toMatchObject({
      status: "historical",
      historicalReason: "replaced",
      replacedByMediaIdInProject: nextProjectMedia.id,
      replacedByMaterialId: nextMaterial.id,
    });
    expect(nextAfter.value.usages[0]).toMatchObject({
      status: "current",
      mediaIdInProject: nextProjectMedia.id,
      replacesMediaIdInProject: oldProjectMedia.id,
      replacesMaterialId: oldMaterial.id,
    });

    // Undo removes the successor and restores the old project reference. A
    // fresh reconciliation repairs both library records without deleting the
    // version history.
    const afterUndo = await service.reconcileProjectUsages(
      projectSnapshot([oldProjectMedia], [oldProjectMedia.id]),
    );
    expect(afterUndo.ok).toBe(true);
    const oldRestored = await service.get(oldMaterial.id);
    const nextHistorical = await service.get(nextMaterial.id);
    if (!oldRestored.ok || !nextHistorical.ok) throw new Error("undo lookup failed");
    expect(oldRestored.value.usages[0].status).toBe("current");
    expect(oldRestored.value.usages[0].historicalReason).toBeUndefined();
    expect(nextHistorical.value.usages[0]).toMatchObject({
      status: "historical",
      historicalReason: "removed",
    });
  });

  it("keeps an old material usage current when a clip-scoped replace leaves references", async () => {
    const oldMaterial = await seedMedia();
    await service.recordUsage(oldMaterial.id, {
      projectId: "project-version-test",
      mediaIdInProject: "project-media-v1",
      attachedAt: NOW,
      attachedBy: "agent",
      status: "current",
    });
    const oldProjectMedia = projectMedia(
      "project-media-v1",
      "/Volumes/media/trip.mp4",
      {
        materialSource: {
          materialId: oldMaterial.id,
          materialRevision: oldMaterial.revision,
          attachedAt: NOW,
        },
      },
    );
    const nextProjectMedia = projectMedia(
      "project-media-v2",
      "/Volumes/media/untracked-v2.mp4",
      {
        versionSource: {
          supersedesMediaIdInProject: oldProjectMedia.id,
          supersedesMaterialId: oldMaterial.id,
          replacedAt: NOW,
        },
      },
    );
    await service.reconcileProjectUsages(
      projectSnapshot(
        [oldProjectMedia, nextProjectMedia],
        [oldProjectMedia.id, nextProjectMedia.id],
      ),
    );
    const oldAfter = await service.get(oldMaterial.id);
    if (!oldAfter.ok) throw new Error(oldAfter.message);
    expect(oldAfter.value.usages[0].status).toBe("current");
  });

  it("does not treat a historical usage as a live removal blocker", async () => {
    const media = await seedMedia();
    await service.recordUsage(media.id, {
      projectId: "project-version-test",
      mediaIdInProject: "removed-media",
      attachedAt: NOW,
      attachedBy: "agent",
      status: "current",
    });
    await service.reconcileProjectUsages(projectSnapshot([], []));
    const historical = await service.get(media.id);
    if (!historical.ok) throw new Error(historical.message);
    expect(historical.value.usages[0].status).toBe("historical");

    const removed = await service.remove(media.id, {}, "user");
    expect(removed.ok).toBe(true);
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

  it("keeps undo/redo byte-restorable across a simulated page reload", async () => {
    // A page reload is exactly this: a fresh service instance over the same
    // persisted backend (records, journal, and blobs all live in the same
    // IDB stores, and every mutation above already committed to them).
    const { id, blob } = await seedBlobMedia("reloadable");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    // Undo the removal entry by id: the reload re-sorts the journal by
    // (at, id), so "latest" is ambiguous when both entries share a
    // millisecond — the per-entry undo (the History menu path) is the
    // deterministic one.
    const removeEntryId = removed.value.journalEntryId;

    const reloaded = new MaterialLibraryService(storage);
    const undo = await reloaded.undo(removeEntryId, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.value.restored).toEqual([id]);
      expect(undo.value.blobMissingIds).toEqual([]);
    }
    const after = await reloaded.get(id);
    expect(after.ok).toBe(true);
    expect(await reloaded.loadBlobFor(id)).toBe(blob);

    // Redo across the reload too, and the bytes must survive it for the
    // next undo.
    if (!undo.ok) throw new Error("unreachable");
    const redo = await reloaded.undo(undo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) expect(redo.value.removed).toEqual([id]);
    expect(await reloaded.loadBlobFor(id)).toBe(blob);
  });

  it("a failed remove commit leaves no half-applied state", async () => {
    const { id } = await seedBlobMedia("atomic-remove");
    const failing = new MaterialLibraryService(
      new FailingCommitStorage(storage, () => true),
    );
    const removed = await failing.remove(id, {}, "user");
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.code).toBe("INTERNAL");
    // Nothing moved: the record, its journal entry, and the bytes are all
    // still there (one aborted transaction, not a partial one).
    const stillThere = await failing.get(id);
    expect(stillThere.ok).toBe(true);
    expect(storage.materials.has(id)).toBe(true);
    expect(storage.journal.size).toBe(1);
    expect(storage.blobs.has(id)).toBe(true);
  });

  it("a failed undo commit leaves no half-applied state", async () => {
    const { id } = await seedBlobMedia("atomic-undo");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    expect(storage.materials.size).toBe(0);
    // The create entry and the remove entry.
    expect(storage.journal.size).toBe(2);

    const failing = new MaterialLibraryService(
      new FailingCommitStorage(storage, () => true),
    );
    const undo = await failing.undo(undefined, "user");
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.code).toBe("INTERNAL");
    // Still fully removed (with bytes kept for a later undo), journal
    // untouched — no restored-record-without-journal half state. The two
    // entries are the create and the remove.
    expect(storage.materials.size).toBe(0);
    expect(storage.journal.size).toBe(2);
    expect(storage.blobs.has(id)).toBe(true);
    const undone = await service.undo(undefined, "user");
    expect(undone.ok).toBe(true);
  });

  it("reclaims a removed material's blob bytes only when its journal entries are evicted", async () => {
    const { id } = await seedBlobMedia("evict-me");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    expect(storage.blobs.has(id)).toBe(true); // undo window keeps the bytes

    // 100 unrelated entries push both the create and the remove entries
    // out of the 100-entry window — now nothing references the bytes.
    await addNoiseEntries(100);
    expect(storage.blobs.has(id)).toBe(false);
    const journal = await service.journal(100);
    if (!journal.ok) throw new Error(journal.message);
    expect(journal.value.length).toBeLessThanOrEqual(100);
  });

  it("retries eviction GC after a failed eviction commit without losing bytes early", async () => {
    // Eviction commits are the only ones carrying journalDeletes, so the
    // injection fails exactly the eviction transaction.
    let failEvictions = true;
    const failing = new MaterialLibraryService(
      new FailingCommitStorage(
        storage,
        (change) => failEvictions && change.journalDeletes !== undefined,
      ),
    );
    const created = await failing.create(
      {
        kind: "media",
        title: "retry-gc",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "retry-gc.mp4" },
        blob: new Blob(["retry-bytes"], { type: "video/mp4" }),
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.value.material.id;
    const removed = await failing.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    // Fill the window on the SAME (failing) service so its pushJournal
    // runs the eviction GC: the first eviction (of the create entry) fails
    // atomically — the entry AND the bytes stay in the storage, and the
    // in-session journal stays capped at 100.
    await addNoiseEntries(99, failing);
    expect(storage.journal.size).toBe(101); // evicted row rolled back
    expect(storage.blobs.has(id)).toBe(true);

    // Next eviction succeeds and retries the whole pending candidate set.
    failEvictions = false;
    await addNoiseEntries(1, failing);
    expect(storage.blobs.has(id)).toBe(false);
  });

  it("eviction GC never reclaims bytes a surviving record still references", async () => {
    const a = await seedBlobMedia("removed-a");
    const b = await seedBlobMedia("kept-b");
    const removed = await service.remove(a.id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    await addNoiseEntries(100);
    // A is gone from records and journal — its bytes are reclaimed...
    expect(storage.blobs.has(a.id)).toBe(false);
    // ...while B is still a live record: its bytes must survive eviction.
    expect(storage.blobs.has(b.id)).toBe(true);
    expect(await service.loadBlobFor(b.id)).toBe(b.blob);
    const stillThere = await service.get(b.id);
    expect(stillThere.ok).toBe(true);
  });

  it("eviction GC keeps bytes that only a surviving journal entry references", async () => {
    const { id } = await seedBlobMedia("pinned-by-entry");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    // 99 noise entries evict the create entry; the remove entry (whose
    // `before` snapshot references the bytes) stays in the window.
    await addNoiseEntries(99);
    expect(storage.blobs.has(id)).toBe(true);

    // One more entry evicts the remove entry too — nothing references the
    // bytes anymore, so they are finally reclaimed.
    await addNoiseEntries(1);
    expect(storage.blobs.has(id)).toBe(false);
  });

  it("eviction GC keeps bytes referenced by a surviving undo entry", async () => {
    const { id } = await seedBlobMedia("pinned-by-undo");
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);

    // Evict the create and remove entries; the undo entry (after-snapshot)
    // and the restored live record both keep referencing the bytes.
    await addNoiseEntries(100);
    expect(storage.blobs.has(id)).toBe(true);
    const stillThere = await service.get(id);
    expect(stillThere.ok).toBe(true);
  });

  it("eviction GC keeps bytes of a project-attached material even with historical-only usages", async () => {
    const attached = await seedBlobMedia("attached");
    const usage = await service.recordUsage(attached.id, {
      projectId: "proj-attach",
      projectName: "Attach test",
      mediaIdInProject: "pm-1",
      attachedAt: NOW,
      attachedBy: "user",
      status: "current",
    });
    expect(usage.ok).toBe(true);
    // The attach later becomes historical (project replaced/removed it) —
    // that must NOT weaken the live-record protection of the bytes.
    const reconciled = await service.reconcileProjectUsages(
      projectSnapshot([], []),
    );
    expect(reconciled.ok).toBe(true);

    const other = await seedBlobMedia("other-removed");
    const removed = await service.remove(other.id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);

    await addNoiseEntries(100);
    // The unattached removed material's bytes are reclaimed...
    expect(storage.blobs.has(other.id)).toBe(false);
    // ...while the attached material — current or historical usage — keeps
    // them: project copies carry their own bytes, but the library never
    // breaks a record that still exists.
    expect(storage.blobs.has(attached.id)).toBe(true);
    expect(await service.loadBlobFor(attached.id)).toBe(attached.blob);
  });
});
