/**
 * MaterialLibraryService — the canonical mutation engine for the user-level
 * material library (renderer side).
 *
 * Invariants enforced here:
 *  - Every mutation batch is serialized (one promise-chained lane), journaled
 *    as ONE entry, and persisted in ONE storage transaction before the
 *    in-memory state moves.
 *  - Concurrent-edit protection: updates may carry `expectedRevision` (the
 *    record's monotonic counter); a mismatch is a CONFLICT, never a silent
 *    overwrite.
 *  - Agent writes never touch `userNotes` (also enforced in core logic).
 *  - Removing a referenced material requires `force`; removing an entry
 *    never deletes anything on disk and never touches the user's original
 *    files. The library's own blob copy of a removed material is kept
 *    while the removal can still be undone; bytes that no surviving
 *    record or journal entry references are reclaimed when journal
 *    entries are evicted from the 100-entry undo window.
 *  - Undo settles records in one atomic transaction: the inverse of every
 *    touched record is journalled (so redo is always effective — with the
 *    blob bytes it needs), and restored blob references whose bytes are
 *    already gone (historical data) are reported (`blobMissingIds`),
 *    never silently successful.
 */
import {
  applyMaterialJournalUndo,
  applyMaterialUpdate,
  buildMaterialJournalEntry,
  buildMaterialListResult,
  buildMaterialRecord,
  MAX_MATERIAL_JOURNAL_ENTRIES,
  normalizeMaterialJournalEntry,
  normalizeMaterialRecord,
  sanitizeMaterialTags,
  validateMaterialBuildInput,
  isValidSegmentRange,
  type MaterialActor,
  type MaterialBuildInput,
  type MaterialJournalChange,
  type MaterialJournalEntry,
  type MaterialListQuery,
  type MaterialListResult,
  type MaterialRecord,
  type MaterialUpdatePatch,
  type MaterialUsage,
  type MediaItem,
  type Project,
} from "@reelterminal/core";
import type { MaterialStorage } from "./storage";
import { createIdbMaterialStorage } from "./storage";

export type MaterialLibraryErrorCode =
  | "INVALID_PARAMS"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export type MaterialServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: MaterialLibraryErrorCode;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

type CasFailure = Extract<MaterialServiceResult<never>, { ok: false }>;

const fail = <T = never>(
  code: MaterialLibraryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): MaterialServiceResult<T> =>
  ({ ok: false, code, message, ...(details ? { details } : {}) }) as MaterialServiceResult<T>;

/** Create request: a build input minus the actor plus an optional owned blob. */
export type MaterialCreateRequest = Omit<MaterialBuildInput, "actor"> & {
  /** Web copy: bytes the library itself stores (media kind only). */
  readonly blob?: Blob;
};

export interface MaterialBatchUpdateItem {
  readonly id: string;
  readonly patch: MaterialUpdatePatch;
  /** Optional per-record CAS guard. */
  readonly expectedRevision?: number;
}

export interface MaterialRemoveOptions {
  /** Required when the material (or a cascaded segment) still has references. */
  readonly force?: boolean;
}

export interface MaterialUndoResult {
  /** The journal entry recording this undo (undoable in turn). */
  readonly entryId: string;
  readonly undoneEntryId: string;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  /**
   * Restored media records whose library-owned blob copy is already absent
   * (legacy data created before the library kept bytes for its undo
   * window, or bytes deleted outside the library). Undoable removals keep
   * their bytes in the library, so a normal remove→undo reports an empty
   * list here; a non-empty list means the restored records cannot preview
   * or attach, and callers must surface it instead of reading the undo as
   * an unqualified success.
   */
  readonly blobMissingIds: readonly string[];
}

export interface MaterialUsageReconcileResult {
  readonly updatedMaterialIds: readonly string[];
  readonly currentUsageCount: number;
  readonly historicalUsageCount: number;
}

export class MaterialLibraryService {
  private readonly storage: MaterialStorage;
  private records = new Map<string, MaterialRecord>();
  private journalEntries: MaterialJournalEntry[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Blob ids that eviction GC has not yet proven dead. Survives a failed
   * eviction commit so the next eviction retries the whole candidate set
   * within this session (memory-only: a reload recomputes candidates from
   * the persisted journal via the load-time GC below).
   */
  private pendingGcBlobIds = new Set<string>();

  constructor(storage: MaterialStorage = createIdbMaterialStorage()) {
    this.storage = storage;
  }

  /** Load + normalize persisted state once (idempotent, crash-tolerant). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const [rawMaterials, rawJournal] = await Promise.all([
          this.storage.loadAllMaterials(),
          this.storage.loadJournal(),
        ]);
        for (const raw of rawMaterials) {
          const record = normalizeMaterialRecord(raw);
          if (record && record.id) this.records.set(record.id, record);
        }
        const entries = rawJournal
          .map((raw) => normalizeMaterialJournalEntry(raw))
          .filter((entry): entry is MaterialJournalEntry => entry !== null && entry.id !== "")
          .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
        const overflow =
          entries.length > MAX_MATERIAL_JOURNAL_ENTRIES
            ? entries.slice(0, entries.length - MAX_MATERIAL_JOURNAL_ENTRIES)
            : [];
        this.journalEntries = entries.slice(-MAX_MATERIAL_JOURNAL_ENTRIES);
        this.loaded = true;
        // Load-time GC for rows left behind by a historical failed eviction
        // commit (or pre-window data): same derivation, same atomic
        // journal+blob commit as the eviction GC.
        this.gcEvictedEntries(overflow);
      })().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private enqueue<T>(
    body: () => Promise<MaterialServiceResult<T>>,
  ): Promise<MaterialServiceResult<T>> {
    const next = this.chain.then(body, body);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /* ------------------------------ reads ------------------------------ */

  async list(
    query: MaterialListQuery,
  ): Promise<MaterialServiceResult<MaterialListResult>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      const pageSize = Math.min(Math.max(1, query.pageSize), 200);
      return {
        ok: true,
        value: buildMaterialListResult([...this.records.values()], {
          ...query,
          pageSize,
        }),
      };
    } catch (error) {
      return fail("INTERNAL", `material library load failed: ${errorMessage(error)}`);
    }
  }

  async get(id: string): Promise<MaterialServiceResult<MaterialRecord>> {
    await this.chain;
    await this.ensureLoaded();
    const record = this.records.get(id);
    if (!record) return fail("NOT_FOUND", `material "${id}" was not found`, { id });
    return { ok: true, value: record };
  }

  async journal(
    limit = 20,
  ): Promise<MaterialServiceResult<readonly MaterialJournalEntry[]>> {
    await this.chain;
    await this.ensureLoaded();
    return {
      ok: true,
      value: [...this.journalEntries]
        .reverse()
        .slice(0, Math.min(Math.max(1, limit), 100)),
    };
  }

  async counts(): Promise<MaterialServiceResult<{ total: number; inbox: number }>> {
    await this.chain;
    await this.ensureLoaded();
    const all = [...this.records.values()];
    return {
      ok: true,
      value: {
        total: all.length,
        inbox: all.filter((record) => record.organizeStatus === "inbox").length,
      },
    };
  }

  /** Read the library-owned blob copy for a media material (null if none). */
  async loadBlobFor(materialId: string): Promise<Blob | null> {
    await this.chain;
    await this.ensureLoaded();
    return this.storage.loadBlob(materialId);
  }

  /* ----------------------------- mutations ---------------------------- */

  async create(
    request: MaterialCreateRequest,
    actor: MaterialActor,
    verb?: string,
  ): Promise<MaterialServiceResult<{ material: MaterialRecord; journalEntryId: string }>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const input: MaterialBuildInput = { ...request, actor };
      const issues = validateMaterialBuildInput(input);
      if (issues.length > 0) {
        return fail(
          "INVALID_PARAMS",
          `invalid material: ${issues
            .map((issue) => `${issue.field}: ${issue.message}`)
            .join("; ")}`,
          { issues },
        );
      }
      if (request.kind === "segment") {
        const parent = this.records.get(request.parentMaterialId as string);
        if (!parent) {
          return fail(
            "NOT_FOUND",
            `segment parent material "${request.parentMaterialId}" was not found`,
          );
        }
        if (parent.kind !== "media") {
          return fail("INVALID_PARAMS", "segment parent must be a media material", {
            parentMaterialId: parent.id,
            parentKind: parent.kind,
          });
        }
        const duration = parent.metadata.durationSec;
        if (
          !isValidSegmentRange(
            request.startSec as number,
            request.endSec as number,
            duration,
          )
        ) {
          return fail(
            "INVALID_PARAMS",
            `segment range must satisfy 0 <= startSec < endSec${
              duration !== undefined ? ` within the parent duration (${duration}s)` : ""
            }`,
            {
              startSec: request.startSec,
              endSec: request.endSec,
              parentDurationSec: duration,
            },
          );
        }
      }
      if (request.kind === "media" && request.blob && request.fileRef?.type !== "blob") {
        return fail("INVALID_PARAMS", "a blob payload requires a blob file reference");
      }

      let record: MaterialRecord;
      try {
        record = buildMaterialRecord(input);
      } catch (error) {
        return fail("INVALID_PARAMS", errorMessage(error));
      }

      const entry = buildMaterialJournalEntry({
        actor,
        label:
          verb ?? (actor === "agent" ? "agent: create material" : "create material"),
        ...(verb ? { verb } : {}),
        changes: [{ materialId: record.id, before: null, after: record }],
      });
      try {
        await this.storage.commit({
          materialUpserts: [record],
          ...(request.blob ? { blobPuts: [{ id: record.id, blob: request.blob }] } : {}),
          journalUpserts: [entry],
        });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      this.records.set(record.id, record);
      this.pushJournal(entry);
      return { ok: true, value: { material: record, journalEntryId: entry.id } };
    });
  }

  async update(
    id: string,
    patch: MaterialUpdatePatch,
    actor: MaterialActor,
    expectedRevision?: number,
    verb?: string,
  ): Promise<MaterialServiceResult<{ material: MaterialRecord; journalEntryId: string }>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const record = this.records.get(id);
      if (!record) return fail("NOT_FOUND", `material "${id}" was not found`, { id });
      const cas = checkRevisionCas(record, expectedRevision);
      if (cas) return cas;
      let next: MaterialRecord;
      try {
        next = applyMaterialUpdate(record, patch, actor);
      } catch (error) {
        return fail("INVALID_PARAMS", errorMessage(error));
      }
      const entry = buildMaterialJournalEntry({
        actor,
        label:
          verb ??
          (actor === "agent" ? "agent: update material" : `update "${record.title}"`),
        ...(verb ? { verb } : {}),
        changes: [{ materialId: id, before: record, after: next }],
      });
      try {
        await this.storage.commit({
          materialUpserts: [next],
          journalUpserts: [entry],
        });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      this.records.set(id, next);
      this.pushJournal(entry);
      return { ok: true, value: { material: next, journalEntryId: entry.id } };
    });
  }

  /**
   * All-or-nothing batch update: every item is existence- and CAS-checked
   * first; any conflict rejects the whole batch (one journal entry, so one
   * undo restores every record).
   */
  async batchUpdate(
    items: readonly MaterialBatchUpdateItem[],
    actor: MaterialActor,
    verb?: string,
  ): Promise<MaterialServiceResult<{ materials: readonly MaterialRecord[]; journalEntryId: string }>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!Array.isArray(items) || items.length === 0) {
        return fail("INVALID_PARAMS", "batch update requires a non-empty items array");
      }
      if (items.length > 200) {
        return fail("INVALID_PARAMS", "batch update is limited to 200 items per call");
      }
      const itemIssues: Array<Record<string, unknown>> = [];
      const resolved: Array<{ before: MaterialRecord; patch: MaterialUpdatePatch }> = [];
      for (const item of items) {
        const record = this.records.get(item.id);
        if (!record) {
          itemIssues.push({ id: item.id, code: "NOT_FOUND", message: "material not found" });
          continue;
        }
        const cas = checkRevisionCas(record, item.expectedRevision);
        if (cas) {
          itemIssues.push({ id: item.id, code: cas.code, message: cas.message });
          continue;
        }
        try {
          applyMaterialUpdate(record, item.patch, actor); // dry validation
        } catch (error) {
          itemIssues.push({
            id: item.id,
            code: "INVALID_PARAMS",
            message: errorMessage(error),
          });
          continue;
        }
        resolved.push({ before: record, patch: item.patch });
      }
      if (itemIssues.length > 0) {
        return fail(
          itemIssues.some((issue) => issue.code === "CONFLICT") ? "CONFLICT" : "INVALID_PARAMS",
          `batch update rejected: ${itemIssues.length} of ${items.length} items failed (nothing was applied)`,
          { items: itemIssues },
        );
      }

      const changes: MaterialJournalChange[] = [];
      const updated: MaterialRecord[] = [];
      for (const { before, patch } of resolved) {
        const next = applyMaterialUpdate(before, patch, actor);
        changes.push({ materialId: before.id, before, after: next });
        updated.push(next);
      }
      const entry = buildMaterialJournalEntry({
        actor,
        label:
          verb ??
          (actor === "agent"
            ? `agent: batch update ${updated.length} materials`
            : `batch update ${updated.length} materials`),
        ...(verb ? { verb } : {}),
        changes,
      });
      try {
        await this.storage.commit({
          materialUpserts: updated,
          journalUpserts: [entry],
        });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      for (const record of updated) this.records.set(record.id, record);
      this.pushJournal(entry);
      return { ok: true, value: { materials: updated, journalEntryId: entry.id } };
    });
  }

  async remove(
    id: string,
    options: MaterialRemoveOptions,
    actor: MaterialActor,
    verb?: string,
  ): Promise<MaterialServiceResult<{ id: string; removedIds: readonly string[]; journalEntryId: string }>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const record = this.records.get(id);
      if (!record) return fail("NOT_FOUND", `material "${id}" was not found`, { id });
      // Removing a media material cascades to its segments; any referenced
      // record in that set blocks without force.
      const children = [...this.records.values()].filter(
        (candidate) => candidate.kind === "segment" && candidate.parentMaterialId === id,
      );
      const referenced = [record, ...children].filter(
        (candidate) => candidate.usages.some((usage) => usage.status === "current"),
      );
      if (referenced.length > 0 && !options.force) {
        return fail(
          "CONFLICT",
          `material "${record.title}"${
            children.length > 0 ? ` (+${children.length} segments)` : ""
          } is referenced by ${referenced.reduce(
            (sum, candidate) =>
              sum + candidate.usages.filter((usage) => usage.status === "current").length,
            0,
          )} project attach(es); pass force to remove it from the library (existing project copies are unaffected)`,
          {
            usageCount: referenced.reduce(
              (sum, candidate) =>
                sum + candidate.usages.filter((usage) => usage.status === "current").length,
              0,
            ),
            projectIds: referenced.flatMap((candidate) =>
              candidate.usages
                .filter((usage) => usage.status === "current")
                .map((usage) => usage.projectId),
            ),
            cascadedSegmentIds: children.map((child) => child.id),
          },
        );
      }
      const removedRecords = [record, ...children];
      const entry = buildMaterialJournalEntry({
        actor,
        label:
          verb ??
          (actor === "agent"
            ? `agent: remove ${removedRecords.length} material(s)`
            : `remove "${record.title}"${children.length > 0 ? ` (+${children.length} segments)` : ""}`),
        ...(verb ? { verb } : {}),
        changes: removedRecords.map((removed) => ({
          materialId: removed.id,
          before: removed,
          after: null,
        })),
      });
      // No blobDeletes here on purpose: the removal must stay reversible,
      // so the library's own blob copies are kept for the undo window and
      // reclaimed by the journal-eviction GC once nothing references them.
      try {
        await this.storage.commit({
          materialDeletes: removedRecords.map((removed) => removed.id),
          journalUpserts: [entry],
        });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      for (const removed of removedRecords) this.records.delete(removed.id);
      this.pushJournal(entry);
      return {
        ok: true,
        value: {
          id,
          removedIds: removedRecords.map((removed) => removed.id),
          journalEntryId: entry.id,
        },
      };
    });
  }

  /**
   * Undo one journal entry (default: the latest undoable entry).
   *
   * One atomic batch: the inverse record changes are journalled (restores
   * of removed records included, so redoing the undo is effective). The
   * undo itself never reclaims blob copies — records it removes may be
   * restored again by undoing this very entry (a redo), so their bytes
   * stay in the library until journal eviction proves nothing references
   * them — while restored blob references whose bytes are already gone
   * (historical data) are reported via `blobMissingIds` instead of
   * silently succeeding.
   */
  async undo(
    entryId?: string,
    actor: MaterialActor = "user",
  ): Promise<MaterialServiceResult<MaterialUndoResult>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const undoable = [...this.journalEntries].reverse().filter((entry) => !entry.undone);
      const target = entryId
        ? undoable.find((entry) => entry.id === entryId)
        : undoable[0];
      if (!target) {
        return fail(
          "NOT_FOUND",
          entryId
            ? `journal entry "${entryId}" was not found or is already undone`
            : "no undoable material library change",
          { entryId },
        );
      }
      const recordsBeforeUndo = [...this.records.values()];
      const outcome = applyMaterialJournalUndo(recordsBeforeUndo, target);
      // Usages are informational provenance, deliberately OUTSIDE the
      // journal: keep the CURRENT usages when content is restored, so an
      // undo of a content batch (e.g. an agent organize) never rewrites
      // attach history. Records recreated by the undo keep their pre-batch
      // usages from the restored snapshot.
      const usagesBeforeUndo = new Map(
        recordsBeforeUndo.map((record) => [record.id, record.usages] as const),
      );
      const recordsWithUsages: MaterialRecord[] = outcome.records.map((record) => {
        const currentUsages = usagesBeforeUndo.get(record.id);
        return currentUsages ? { ...record, usages: currentUsages } : record;
      });
      const undoChanges: MaterialJournalChange[] = [];
      for (const id of outcome.restored) {
        const before = this.records.get(id) ?? null;
        const after = recordsWithUsages.find((candidate) => candidate.id === id);
        // A restore whose `before` is null (the record had been removed)
        // is still journalled: undoing this entry then replays the null
        // `before` as a removal — an effective redo, never a silent
        // no-op.
        if (after) undoChanges.push({ materialId: id, before, after });
      }
      for (const id of outcome.removed) {
        const before = this.records.get(id) ?? null;
        undoChanges.push({ materialId: id, before, after: null });
      }
      // The undo deliberately does NOT reclaim blob copies: records this
      // undo removes (an undone create, or a redo of a removal) are
      // exactly what undoing this entry restores, so their bytes stay in
      // the library and journal eviction is the only reclaim path.
      // Restored blob references pointing at bytes that are already gone
      // (see MaterialUndoResult.blobMissingIds) are still probed and
      // reported instead of silently succeeding.
      const blobMissingIds: string[] = [];
      const undoEntry = buildMaterialJournalEntry({
        actor,
        label: `undo "${target.label}"`,
        changes: undoChanges,
      });
      const undoneOriginal: MaterialJournalEntry = {
        ...target,
        undone: true,
        undoneAt: new Date().toISOString(),
      };
      try {
        for (const candidate of recordsWithUsages) {
          if (
            !outcome.restored.includes(candidate.id) ||
            candidate.kind !== "media" ||
            candidate.fileRef.type !== "blob"
          ) {
            continue;
          }
          if (!(await this.storage.loadBlob(candidate.id))) {
            blobMissingIds.push(candidate.id);
          }
        }
        await this.storage.commit({
          materialUpserts: recordsWithUsages.filter((candidate) =>
            outcome.restored.includes(candidate.id),
          ),
          materialDeletes: [...outcome.removed],
          journalUpserts: [undoneOriginal, undoEntry],
        });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      this.records = new Map(recordsWithUsages.map((candidate) => [candidate.id, candidate]));
      const index = this.journalEntries.findIndex((entry) => entry.id === target.id);
      if (index >= 0) this.journalEntries[index] = undoneOriginal;
      this.pushJournal(undoEntry);
      return {
        ok: true,
        value: {
          entryId: undoEntry.id,
          undoneEntryId: target.id,
          restored: outcome.restored,
          removed: outcome.removed,
          blobMissingIds,
        },
      };
    });
  }

  /**
   * Record that a project attached this material. Informational provenance —
   * deliberately NOT journaled, so undoing a content batch never rewrites
   * usage history.
   */
  async recordUsage(
    materialId: string,
    usage: MaterialUsage,
  ): Promise<MaterialServiceResult<MaterialRecord>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const record = this.records.get(materialId);
      if (!record) return fail("NOT_FOUND", `material "${materialId}" was not found`);
      const dedupeKey = `${usage.projectId}:${usage.mediaIdInProject ?? ""}`;
      const usages = record.usages.filter(
        (existing) =>
          `${existing.projectId}:${existing.mediaIdInProject ?? ""}` !== dedupeKey,
      );
      const next: MaterialRecord = {
        ...record,
        usages: [...usages, { ...usage, status: usage.status ?? "current" }],
      };
      try {
        await this.storage.commit({ materialUpserts: [next] });
      } catch (error) {
        return fail("INTERNAL", `material library write failed: ${errorMessage(error)}`);
      }
      this.records.set(materialId, next);
      return { ok: true, value: next };
    });
  }

  /**
   * Reconcile persisted usage provenance with one canonical project snapshot.
   *
   * A replace keeps the old project media item for undo and version history,
   * so media-library membership alone cannot decide whether a usage is still
   * current.  We consider an old version historical only when a successor is
   * present AND no timeline clip still points at the old media id. Undo/redo
   * naturally reverses that result because it changes the canonical snapshot.
   *
   * This is deliberately a separate IndexedDB commit from the project edit.
   * It is derived, retryable provenance; callers must not claim a cross-DB
   * transaction. A later reconciliation repairs an interrupted write.
   */
  async reconcileProjectUsages(
    project: Pick<Project, "id" | "name" | "mediaLibrary" | "timeline">,
  ): Promise<MaterialServiceResult<MaterialUsageReconcileResult>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const nowIso = new Date().toISOString();
      const mediaById = new Map(
        project.mediaLibrary.items.map((item) => [item.id, item] as const),
      );
      const referencedMediaIds = new Set(
        project.timeline.tracks.flatMap((track) =>
          track.clips.map((clip) => clip.mediaId),
        ),
      );
      const successors = new Map<string, MediaItem[]>();
      for (const item of project.mediaLibrary.items) {
        const previousId = item.versionSource?.supersedesMediaIdInProject;
        if (previousId) {
          successors.set(previousId, [...(successors.get(previousId) ?? []), item]);
        }
      }

      // Exact path matching is a recovery/convenience path for media.replace.
      // Ambiguous matches are intentionally ignored rather than guessed.
      const materialsByPath = new Map<string, MaterialRecord[]>();
      for (const record of this.records.values()) {
        if (record.kind !== "media" || record.fileRef.type !== "path") continue;
        const key = normalizeMaterialPath(record.fileRef.path);
        materialsByPath.set(key, [...(materialsByPath.get(key) ?? []), record]);
      }
      const linkedMaterialId = (
        item: MediaItem,
      ): string | undefined => {
        if (item.materialSource && this.records.has(item.materialSource.materialId)) {
          return item.materialSource.materialId;
        }
        if (!item.originalUrl) return undefined;
        const candidates = materialsByPath.get(normalizeMaterialPath(item.originalUrl));
        return candidates?.length === 1 ? candidates[0]?.id : undefined;
      };

      const nextById = new Map(this.records);
      const touched = new Set<string>();

      const statusForMedia = (mediaId: string): {
        status: "current" | "historical";
        successors?: readonly MediaItem[];
        reason?: "replaced" | "removed";
      } => {
        const item = mediaById.get(mediaId);
        const replacements = successors.get(mediaId);
        if (replacements && replacements.length > 0 && !referencedMediaIds.has(mediaId)) {
          return { status: "historical", successors: replacements, reason: "replaced" };
        }
        if (!item) return { status: "historical", reason: "removed" };
        return { status: "current" };
      };

      // First refresh every usage already known for this project. Historical
      // entries remain visible; reconciliation never erases provenance.
      for (const record of this.records.values()) {
        let changed = false;
        const usages = record.usages.map((usage): MaterialUsage => {
          if (usage.projectId !== project.id || !usage.mediaIdInProject) return usage;
          const state = statusForMedia(usage.mediaIdInProject);
          if (state.status === "current") {
            if (
              usage.status === "current" &&
              usage.historicalAt === undefined &&
              usage.historicalReason === undefined &&
              usage.replacedByMediaIdInProject === undefined &&
              usage.replacedByMaterialId === undefined
            ) {
              return usage;
            }
            changed = true;
            const {
              historicalAt: _historicalAt,
              historicalReason: _historicalReason,
              replacedByMediaIdInProject: _replacedByMedia,
              replacedByMaterialId: _replacedByMaterial,
              ...active
            } = usage;
            return { ...active, status: "current" };
          }
          // A single successor can be linked precisely. Multiple clip-scoped
          // branches remain historical without guessing one as canonical.
          const singleSuccessor = state.successors?.length === 1
            ? state.successors[0]
            : undefined;
          const replacementMaterialId = singleSuccessor
            ? linkedMaterialId(singleSuccessor)
            : undefined;
          if (
            usage.status === "historical" &&
            usage.historicalReason === state.reason &&
            usage.replacedByMediaIdInProject === singleSuccessor?.id &&
            usage.replacedByMaterialId === replacementMaterialId
          ) {
            return usage;
          }
          changed = true;
          const {
            replacedByMediaIdInProject: _oldReplacementMedia,
            replacedByMaterialId: _oldReplacementMaterial,
            ...historical
          } = usage;
          return {
            ...historical,
            status: "historical",
            historicalAt: usage.historicalAt ?? nowIso,
            ...(state.reason ? { historicalReason: state.reason } : {}),
            ...(singleSuccessor
              ? { replacedByMediaIdInProject: singleSuccessor.id }
              : {}),
            ...(replacementMaterialId
              ? { replacedByMaterialId: replacementMaterialId }
              : {}),
          };
        });
        if (changed) {
          nextById.set(record.id, { ...record, usages });
          touched.add(record.id);
        }
      }

      // Then discover stable links carried by project media items (or a
      // unique exact path match for a replacement saved in the library).
      for (const item of project.mediaLibrary.items) {
        const materialId = linkedMaterialId(item);
        if (!materialId) continue;
        const record = nextById.get(materialId);
        if (!record) continue;
        const key = `${project.id}:${item.id}`;
        const existingIndex = record.usages.findIndex(
          (usage) => `${usage.projectId}:${usage.mediaIdInProject ?? ""}` === key,
        );
        if (existingIndex >= 0) continue;
        const state = statusForMedia(item.id);
        const previousMediaId = item.versionSource?.supersedesMediaIdInProject;
        const previousMaterialId = item.versionSource?.supersedesMaterialId;
        const usage: MaterialUsage = {
          projectId: project.id,
          projectName: project.name,
          mediaIdInProject: item.id,
          attachedAt: item.materialSource?.attachedAt ?? nowIso,
          attachedBy:
            item.materialSource?.attachedBy ??
            item.versionSource?.replacedBy ??
            "unknown",
          status: state.status,
          ...(state.status === "historical"
            ? {
                historicalAt: nowIso,
                ...(state.reason ? { historicalReason: state.reason } : {}),
              }
            : {}),
          ...(previousMediaId ? { replacesMediaIdInProject: previousMediaId } : {}),
          ...(previousMaterialId ? { replacesMaterialId: previousMaterialId } : {}),
        };
        nextById.set(materialId, { ...record, usages: [...record.usages, usage] });
        touched.add(materialId);
      }

      const updates = [...touched]
        .map((id) => nextById.get(id))
        .filter((record): record is MaterialRecord => record !== undefined);
      if (updates.length > 0) {
        try {
          await this.storage.commit({ materialUpserts: updates });
        } catch (error) {
          return fail(
            "INTERNAL",
            `material usage reconciliation failed: ${errorMessage(error)}`,
          );
        }
        for (const record of updates) this.records.set(record.id, record);
      }
      const projectUsages = [...this.records.values()].flatMap((record) =>
        record.usages.filter((usage) => usage.projectId === project.id),
      );
      return {
        ok: true,
        value: {
          updatedMaterialIds: [...touched],
          currentUsageCount: projectUsages.filter((usage) => usage.status === "current").length,
          historicalUsageCount: projectUsages.filter(
            (usage) => usage.status === "historical",
          ).length,
        },
      };
    });
  }

  /**
   * Merge tags into many records without dropping existing tags (the UI's
   * batch-tag bar). Computed inside the mutation lane, then applied as one
   * all-or-nothing batch update.
   */
  async addTags(
    ids: readonly string[],
    tags: readonly string[],
    actor: MaterialActor,
    verb?: string,
  ): Promise<MaterialServiceResult<{ materials: readonly MaterialRecord[]; journalEntryId: string }>> {
    await this.ensureLoaded();
    const additions = sanitizeMaterialTags(tags);
    if (additions.length === 0) {
      return fail("INVALID_PARAMS", "addTags requires at least one non-empty tag");
    }
    if (ids.length === 0) {
      return fail("INVALID_PARAMS", "addTags requires at least one material id");
    }
    return this.batchUpdate(
      ids.map((id) => {
        const record = this.records.get(id);
        return {
          id,
          patch: {
            tags: sanitizeMaterialTags([...(record?.tags ?? []), ...additions]),
          },
        };
      }),
      actor,
      verb,
    );
  }

  /**
   * Blob ids a record snapshot references (media records with a blob
   * fileRef — the blob store is keyed by the material's own id).
   */
  private blobIdsOf(
    records: ReadonlyArray<MaterialRecord | null>,
  ): string[] {
    return records
      .filter(
        (record): record is MaterialRecord =>
          record !== null && record.kind === "media" && record.fileRef.type === "blob",
      )
      .map((record) => record.id);
  }

  /**
   * Blob ids a journal entry references, derived purely from its embedded
   * before/after record snapshots (no schema additions needed).
   */
  private entryBlobIds(entries: readonly MaterialJournalEntry[]): string[] {
    return this.blobIdsOf(
      entries.flatMap((entry) =>
        entry.changes.flatMap((change) => [change.before, change.after]),
      ),
    );
  }

  /**
   * Journal-eviction GC — the only place library blob bytes are reclaimed.
   *
   * An evicted entry's blob set minus the sets referenced by surviving
   * records and surviving journal entries is dead and can be dropped in
   * the SAME transaction that deletes the evicted rows (one IDB commit, so
   * a failure rolls both back together). The commit is fire-and-forget: a
   * failure just delays reclamation (never over-deletes), and the
   * candidate set stays in `pendingGcBlobIds` for the next eviction to
   * retry. Undone entries count as live references on purpose — the
   * History menu can re-undo them, which would need the bytes again.
   */
  private gcEvictedEntries(evicted: readonly MaterialJournalEntry[]): void {
    if (evicted.length === 0) return;
    const candidates = new Set<string>([
      ...this.pendingGcBlobIds,
      ...this.entryBlobIds(evicted),
    ]);
    const liveRecordBlobs = new Set(this.blobIdsOf([...this.records.values()]));
    const liveJournalBlobs = new Set(this.entryBlobIds(this.journalEntries));
    const gc = [...candidates].filter(
      (id) => !liveRecordBlobs.has(id) && !liveJournalBlobs.has(id),
    );
    // Remember everything not yet proven dead: if the commit fails, the
    // next eviction retries the whole candidate set within this session.
    this.pendingGcBlobIds = candidates;
    void this.storage
      .commit({
        journalDeletes: evicted.map((entry) => entry.id),
        ...(gc.length > 0 ? { blobDeletes: gc } : {}),
      })
      .then(() => {
        for (const id of gc) this.pendingGcBlobIds.delete(id);
      })
      .catch(() => undefined);
  }

  private pushJournal(entry: MaterialJournalEntry): void {
    this.journalEntries.push(entry);
    if (this.journalEntries.length <= MAX_MATERIAL_JOURNAL_ENTRIES) return;
    const overflow = this.journalEntries.slice(
      0,
      this.journalEntries.length - MAX_MATERIAL_JOURNAL_ENTRIES,
    );
    // In-memory slicing stays first (existing behavior): evicted entries
    // are no longer undoable in this session even if the persistence below
    // fails — and since the eviction commit is atomic, a failed commit
    // leaves the rows in IDB so a reload puts them back, bytes intact.
    this.journalEntries = this.journalEntries.slice(-MAX_MATERIAL_JOURNAL_ENTRIES);
    this.gcEvictedEntries(overflow);
  }
}

function checkRevisionCas(
  record: MaterialRecord,
  expectedRevision: number | undefined,
): CasFailure | null {
  if (expectedRevision === undefined) return null;
  if (expectedRevision === record.revision) return null;
  return {
    ok: false,
    code: "CONFLICT",
    message: `material "${record.id}" was modified concurrently: expected revision ${expectedRevision}, current is ${record.revision} — re-read and retry`,
    details: { id: record.id, currentRevision: record.revision },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMaterialPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

let singleton: MaterialLibraryService | null = null;

export function getMaterialLibraryService(): MaterialLibraryService {
  if (!singleton) singleton = new MaterialLibraryService();
  return singleton;
}

/** Test/preview seam: install a service backed by explicit storage. */
export function setMaterialLibraryServiceForTests(service: MaterialLibraryService): void {
  singleton = service;
}
