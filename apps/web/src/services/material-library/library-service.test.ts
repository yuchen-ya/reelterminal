import { beforeEach, describe, expect, it } from "vitest";
import type {
  MaterialJournalEntry,
  MaterialRecord,
  MediaItem,
  Project,
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

  it("undoing a removal surfaces the missing library blob bytes (C08-1)", async () => {
    const blob = new Blob(["fake-bytes"], { type: "video/mp4" });
    const created = await service.create(
      {
        kind: "media",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "screen.mp4" },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.value.material.id;
    const removed = await service.remove(id, {}, "user");
    if (!removed.ok) throw new Error(removed.message);
    // remove keeps its documented semantics: the library's own copy is
    // reclaimed immediately (frozen contract, ML "reclaims only that copy").
    expect(storage.blobs.has(id)).toBe(false);

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.value.restored).toEqual([id]);
      // The record is back, but its library-owned bytes were already
      // reclaimed. The undo result must say so instead of reporting an
      // unqualified success.
      expect(undo.value.blobMissingIds).toEqual([id]);
    }
    expect(await service.loadBlobFor(id)).toBeNull();
  });

  it.skip(
    "undoing a removal restores the library blob bytes themselves "
      + "(BLOCKED: requires deferring remove's immediate reclaim, which the "
      + "frozen contract ML:58-59 and the reclaim test above pin — see "
      + "reports/C08-undo-fix-implementer.md)",
    async () => {
      const blob = new Blob(["fake-bytes"], { type: "video/mp4" });
      const created = await service.create(
        {
          kind: "media",
          mediaType: "video",
          fileRef: { type: "blob", fileName: "screen.mp4" },
          blob,
          nowIso: NOW,
        },
        "user",
      );
      if (!created.ok) throw new Error(created.message);
      const id = created.value.material.id;
      await service.remove(id, {}, "user");
      await service.undo(undefined, "user");
      expect(await service.loadBlobFor(id)).not.toBeNull();
    },
  );

  it("undoing a creation reclaims the blob copy in the same transaction (C08-3)", async () => {
    const blob = new Blob(["orphan-bytes"], { type: "video/mp4" });
    const created = await service.create(
      {
        kind: "media",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "clip.mp4" },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.value.material.id;
    expect(storage.blobs.has(id)).toBe(true);

    const undo = await service.undo(undefined, "user");
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.value.removed).toEqual([id]);
    // No orphan bytes: the undo's own commit carries the blob delete.
    const commit = storage.commits[storage.commits.length - 1];
    expect(commit.blobDeletes).toEqual([id]);
    expect(storage.blobs.has(id)).toBe(false);
    expect(await service.loadBlobFor(id)).toBeNull();
  });

  it("redo of an undone removal re-removes the material (C08-2)", async () => {
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

  it("redoing an undone creation reports the reclaimed blob as missing", async () => {
    const blob = new Blob(["once-bytes"], { type: "video/mp4" });
    const created = await service.create(
      {
        kind: "media",
        mediaType: "video",
        fileRef: { type: "blob", fileName: "take.mp4" },
        blob,
        nowIso: NOW,
      },
      "user",
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.value.material.id;
    const firstUndo = await service.undo(undefined, "user");
    if (!firstUndo.ok) throw new Error(firstUndo.message);
    expect(storage.blobs.has(id)).toBe(false); // C08-3 reclaimed it

    const redo = await service.undo(firstUndo.value.entryId, "user");
    expect(redo.ok).toBe(true);
    if (redo.ok) {
      expect(redo.value.restored).toEqual([id]);
      // Bytes are gone for good; the redo must say so honestly.
      expect(redo.value.blobMissingIds).toEqual([id]);
    }
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
});
