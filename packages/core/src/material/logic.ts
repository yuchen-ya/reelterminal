/**
 * Pure logic for the user-level material library: record construction,
 * validation, search/filter/pagination, update patching, and the
 * library-scoped undo journal. No storage, no DOM, no IPC — everything here
 * is unit-testable and shared by the renderer service and the agent facade.
 */
import { v4 as uuidv4 } from "uuid";
import {
  MATERIAL_LIBRARY_SCHEMA_VERSION,
  MATERIAL_KINDS,
  MATERIAL_MEDIA_TYPES,
  type MaterialActor,
  type MaterialFileRef,
  type MaterialRecordBase,
  type MaterialFilters,
  type MaterialJournalChange,
  type MaterialJournalEntry,
  type MaterialKind,
  type MaterialListQuery,
  type MaterialListResult,
  type MaterialMediaMetadata,
  type MaterialMediaType,
  type MaterialOrganizeStatus,
  type MaterialRecord,
} from "./types";

export const MATERIAL_ID_PREFIX = "mat_";
export const MATERIAL_JOURNAL_ID_PREFIX = "mjr_";

/** Journal entries retained (FIFO); one agent batch = one entry. */
export const MAX_MATERIAL_JOURNAL_ENTRIES = 100;

export const MAX_MATERIAL_TITLE_LENGTH = 300;
export const MAX_MATERIAL_TEXT_LENGTH = 20_000;
export const MAX_MATERIAL_TAGS = 32;
export const MAX_MATERIAL_TAG_LENGTH = 64;
export const MAX_MATERIAL_METHOD_STEPS = 32;
/** Tolerance for end-of-file rounding when validating segment ranges. */
export const SEGMENT_RANGE_EPSILON_SEC = 0.05;

export function newMaterialId(): string {
  return `${MATERIAL_ID_PREFIX}${uuidv4()}`;
}

export function newMaterialJournalEntryId(): string {
  return `${MATERIAL_JOURNAL_ID_PREFIX}${uuidv4()}`;
}

export function isMaterialId(value: string): boolean {
  return value.startsWith(MATERIAL_ID_PREFIX);
}

/* ------------------------------------------------------------------ */
/* Field sanitation                                                    */
/* ------------------------------------------------------------------ */

/** Trim, drop empties, cap length/count, dedupe case-insensitively. */
export function sanitizeMaterialTags(
  tags: readonly string[] | undefined,
): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_MATERIAL_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_MATERIAL_TAGS) break;
  }
  return result;
}

export function sanitizeMaterialText(
  value: string | undefined,
  maxLength = MAX_MATERIAL_TEXT_LENGTH,
): string {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength);
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/** Kind-specific payload for building one record (fileRef already resolved). */
export interface MaterialBuildInput {
  readonly kind: MaterialKind;
  readonly actor: MaterialActor;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly organizeStatus?: MaterialOrganizeStatus;
  readonly userNotes?: string;
  readonly aiSummary?: string;
  readonly origin?: string;
  readonly capturedFrom?: string;
  /** Test/deterministic seams; production callers omit them. */
  readonly id?: string;
  readonly nowIso?: string;
  /** media */
  readonly mediaType?: MaterialMediaType;
  readonly fileRef?: MaterialFileRef;
  readonly metadata?: MaterialMediaMetadata;
  readonly thumbnailDataUrl?: string;
  /** segment */
  readonly parentMaterialId?: string;
  readonly startSec?: number;
  readonly endSec?: number;
  /** link */
  readonly url?: string;
  readonly description?: string;
  /** method */
  readonly skillName?: string;
  readonly prompt?: string;
  readonly steps?: readonly string[];
  readonly inputs?: readonly string[];
}

export interface MaterialBuildIssue {
  readonly field: string;
  readonly message: string;
}

export function isValidSegmentRange(
  startSec: number,
  endSec: number,
  parentDurationSec?: number,
): boolean {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return false;
  if (startSec < 0 || endSec <= startSec) return false;
  if (
    parentDurationSec !== undefined &&
    Number.isFinite(parentDurationSec) &&
    endSec > parentDurationSec + SEGMENT_RANGE_EPSILON_SEC
  ) {
    return false;
  }
  return true;
}

export function isValidMaterialUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateMaterialBuildInput(
  input: MaterialBuildInput,
): MaterialBuildIssue[] {
  const issues: MaterialBuildIssue[] = [];
  if (!MATERIAL_KINDS.includes(input.kind)) {
    issues.push({ field: "kind", message: `unknown kind "${String(input.kind)}"` });
    return issues;
  }
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || input.title.trim().length === 0)
  ) {
    issues.push({ field: "title", message: "title must be a non-empty string" });
  }
  switch (input.kind) {
    case "media": {
      if (
        input.mediaType === undefined ||
        !MATERIAL_MEDIA_TYPES.includes(input.mediaType)
      ) {
        issues.push({
          field: "mediaType",
          message: 'media materials require mediaType "video" | "audio" | "image"',
        });
      }
      const ref = input.fileRef;
      if (!ref || ref.type !== "path" && ref.type !== "blob") {
        issues.push({
          field: "fileRef",
          message: "media materials require a path or blob file reference",
        });
      } else if (ref.type === "path" && !ref.path.trim()) {
        issues.push({ field: "fileRef.path", message: "path must be non-empty" });
      }
      break;
    }
    case "segment": {
      if (!input.parentMaterialId || !input.parentMaterialId.trim()) {
        issues.push({
          field: "parentMaterialId",
          message: "segment materials require a parent material id",
        });
      }
      const start = input.startSec;
      const end = input.endSec;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !isValidSegmentRange(start, end)
      ) {
        issues.push({
          field: "startSec/endSec",
          message:
            "segment requires finite seconds with 0 <= startSec < endSec (within the parent duration)",
        });
      }
      break;
    }
    case "link": {
      if (typeof input.url !== "string" || !isValidMaterialUrl(input.url)) {
        issues.push({
          field: "url",
          message: "link materials require an http(s) URL",
        });
      }
      break;
    }
    case "method": {
      if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        issues.push({
          field: "prompt",
          message: "method materials require a non-empty prompt",
        });
      }
      break;
    }
  }
  return issues;
}

function defaultTitleForKind(input: MaterialBuildInput): string {
  switch (input.kind) {
    case "media": {
      const ref = input.fileRef;
      const fileName = ref?.fileName;
      if (fileName && fileName.trim()) return fileName.trim();
      if (ref?.type === "path") {
        const base = ref.path.split(/[\\/]/).pop();
        if (base) return base;
      }
      return "Untitled media";
    }
    case "segment":
      return "Untitled segment";
    case "link": {
      try {
        return new URL(input.url ?? "").host || input.url || "Untitled link";
      } catch {
        return input.url || "Untitled link";
      }
    }
    case "method":
      return input.skillName?.trim() || "Untitled method";
  }
}

/** Build a fresh record from validated input; throws on invalid input. */
export function buildMaterialRecord(input: MaterialBuildInput): MaterialRecord {
  const issues = validateMaterialBuildInput(input);
  if (issues.length > 0) {
    throw new Error(
      `invalid material: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
    );
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  const base = {
    schemaVersion: MATERIAL_LIBRARY_SCHEMA_VERSION,
    id: input.id ?? newMaterialId(),
    title: (input.title?.trim() || defaultTitleForKind(input)).slice(
      0,
      MAX_MATERIAL_TITLE_LENGTH,
    ),
    tags: sanitizeMaterialTags(input.tags),
    organizeStatus: input.organizeStatus ?? "inbox",
    userNotes: sanitizeMaterialText(input.userNotes),
    aiSummary: sanitizeMaterialText(input.aiSummary),
    source: {
      ...(input.origin?.trim() ? { origin: input.origin.trim().slice(0, 500) } : {}),
      ...(input.capturedFrom?.trim()
        ? { capturedFrom: input.capturedFrom.trim().slice(0, 1000) }
        : {}),
      addedBy: input.actor,
      addedAt: nowIso,
    },
    updatedBy: input.actor,
    ...(input.actor === "agent" ? { lastAgentEditAt: nowIso } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    revision: 1,
    usages: [],
  } as const;

  switch (input.kind) {
    case "media":
      return {
        ...base,
        kind: "media",
        mediaType: input.mediaType as MaterialMediaType,
        fileRef: input.fileRef as MaterialFileRef,
        metadata: input.metadata ?? {},
        ...(input.thumbnailDataUrl ? { thumbnailDataUrl: input.thumbnailDataUrl } : {}),
      };
    case "segment":
      return {
        ...base,
        kind: "segment",
        parentMaterialId: input.parentMaterialId as string,
        startSec: input.startSec as number,
        endSec: input.endSec as number,
      };
    case "link":
      return {
        ...base,
        kind: "link",
        url: (input.url as string).trim(),
        ...(input.description?.trim()
          ? { description: sanitizeMaterialText(input.description) }
          : {}),
      };
    case "method":
      return {
        ...base,
        kind: "method",
        ...(input.skillName?.trim()
          ? { skillName: input.skillName.trim().slice(0, 200) }
          : {}),
        prompt: sanitizeMaterialText(input.prompt),
        ...(input.steps && input.steps.length > 0
          ? {
              steps: input.steps
                .map((step) => step.slice(0, MAX_MATERIAL_TEXT_LENGTH))
                .slice(0, MAX_MATERIAL_METHOD_STEPS),
            }
          : {}),
        ...(input.inputs && input.inputs.length > 0
          ? {
              inputs: input.inputs
                .map((value) => value.slice(0, 500))
                .slice(0, MAX_MATERIAL_METHOD_STEPS),
            }
          : {}),
      };
  }
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

/** Fields updatable after creation. `userNotes` is UI-only (see below). */
export interface MaterialUpdatePatch {
  readonly title?: string;
  readonly aiSummary?: string;
  readonly tags?: readonly string[];
  readonly organizeStatus?: MaterialOrganizeStatus;
  /**
   * Only the human UI passes this. applyMaterialUpdate refuses to move
   * userNotes for agent writes regardless of what the caller passes, so a
   * re-analysis batch can never overwrite user notes.
   */
  readonly userNotes?: string;
  /** Link materials only. */
  readonly description?: string;
}

export interface MaterialUpdateConflict {
  readonly field: string;
  readonly message: string;
}

export function validateMaterialUpdatePatch(
  record: MaterialRecord,
  patch: MaterialUpdatePatch,
): MaterialUpdateConflict[] {
  const conflicts: MaterialUpdateConflict[] = [];
  if (
    patch.title !== undefined &&
    (typeof patch.title !== "string" || patch.title.trim().length === 0)
  ) {
    conflicts.push({ field: "title", message: "title must be a non-empty string" });
  }
  if (
    patch.description !== undefined &&
    record.kind !== "link"
  ) {
    conflicts.push({
      field: "description",
      message: "description is only updatable on link materials",
    });
  }
  return conflicts;
}

/**
 * Apply a patch and bump the revision. Hard invariant: an `agent` actor
 * never modifies `userNotes` — the field is silently skipped for agent
 * writes (facade schemas omit it entirely; this is the second lock).
 */
export function applyMaterialUpdate(
  record: MaterialRecord,
  patch: MaterialUpdatePatch,
  actor: MaterialActor,
  nowIso = new Date().toISOString(),
): MaterialRecord {
  const conflicts = validateMaterialUpdatePatch(record, patch);
  if (conflicts.length > 0) {
    throw new Error(
      `invalid material update: ${conflicts.map((c) => `${c.field}: ${c.message}`).join("; ")}`,
    );
  }
  const title =
    patch.title !== undefined
      ? patch.title.trim().slice(0, MAX_MATERIAL_TITLE_LENGTH) || record.title
      : record.title;
  const aiSummary =
    patch.aiSummary !== undefined ? sanitizeMaterialText(patch.aiSummary) : record.aiSummary;
  const tags = patch.tags !== undefined ? sanitizeMaterialTags(patch.tags) : record.tags;
  const organizeStatus = patch.organizeStatus ?? record.organizeStatus;
  // Hard invariant: an agent write never moves userNotes.
  const userNotes =
    patch.userNotes !== undefined && actor === "user"
      ? sanitizeMaterialText(patch.userNotes)
      : record.userNotes;
  const next: MaterialRecord = {
    ...record,
    title,
    aiSummary,
    tags,
    organizeStatus,
    userNotes,
    updatedAt: nowIso,
    updatedBy: actor,
    ...(actor === "agent" ? { lastAgentEditAt: nowIso } : {}),
    revision: record.revision + 1,
  };
  if (patch.description !== undefined && record.kind === "link") {
    const description = sanitizeMaterialText(patch.description);
    const { description: _existing, ...rest } = next as Extract<
      MaterialRecord,
      { kind: "link" }
    >;
    const updated = rest as Extract<MaterialRecord, { kind: "link" }>;
    return description ? { ...updated, description } : updated;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Search / filter / pagination                                        */
/* ------------------------------------------------------------------ */

/** Concatenated searchable text; tokens are matched case-insensitively. */
export function materialSearchText(record: MaterialRecord): string {
  const parts: string[] = [
    record.title,
    record.tags.join(" "),
    record.userNotes,
    record.aiSummary,
  ];
  switch (record.kind) {
    case "media":
      parts.push(record.fileRef.fileName);
      break;
    case "segment":
      break;
    case "link":
      parts.push(record.url, record.description ?? "");
      break;
    case "method":
      parts.push(
        record.skillName ?? "",
        record.prompt,
        (record.steps ?? []).join(" "),
        (record.inputs ?? []).join(" "),
      );
      break;
  }
  return parts.join("\n").toLowerCase();
}

/** True when EVERY whitespace token of `query` occurs in the record text. */
export function matchesMaterialQuery(
  record: MaterialRecord,
  query: string | undefined,
): boolean {
  if (!query || !query.trim()) return true;
  const haystack = materialSearchText(record);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token));
}

export function matchesMaterialFilters(
  record: MaterialRecord,
  filters: MaterialFilters | undefined,
): boolean {
  if (!filters) return true;
  if (filters.kind !== undefined && record.kind !== filters.kind) return false;
  if (filters.status !== undefined && record.organizeStatus !== filters.status) {
    return false;
  }
  const tag = filters.tag;
  if (
    tag !== undefined &&
    !record.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())
  ) {
    return false;
  }
  return true;
}

export function sortMaterialRecords(
  records: readonly MaterialRecord[],
  sort: MaterialListQuery["sort"] = "updated",
): MaterialRecord[] {
  const copy = [...records];
  copy.sort((a, b) => {
    switch (sort) {
      case "created":
        return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
      case "title":
        return (
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
          a.id.localeCompare(b.id)
        );
      case "updated":
      default:
        return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
    }
  });
  return copy;
}

export function collectMaterialTags(
  records: readonly MaterialRecord[],
): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const record of records) {
    for (const tag of record.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }
  tags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return tags;
}

export function buildMaterialListResult(
  records: readonly MaterialRecord[],
  query: MaterialListQuery,
): MaterialListResult {
  const pageSize = Math.max(1, Math.floor(query.pageSize));
  const page = Math.max(1, Math.floor(query.page));
  const filtered = sortMaterialRecords(
    records.filter(
      (record) =>
        matchesMaterialFilters(record, query) &&
        matchesMaterialQuery(record, query.query),
    ),
    query.sort,
  );
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total,
    page: clampedPage,
    pageSize,
    totalPages,
    allTags: collectMaterialTags(records),
  };
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

/**
 * Collapse a batch of before/after states so each material appears once:
 * first `before` and last `after` win. Undo then restores the exact
 * pre-batch state even when one batch touched a record twice.
 */
export function collapseMaterialChanges(
  changes: readonly MaterialJournalChange[],
): MaterialJournalChange[] {
  const order: string[] = [];
  const byId = new Map<string, MaterialJournalChange>();
  for (const change of changes) {
    const existing = byId.get(change.materialId);
    if (!existing) {
      order.push(change.materialId);
      byId.set(change.materialId, { ...change });
      continue;
    }
    byId.set(change.materialId, {
      materialId: change.materialId,
      before: existing.before,
      after: change.after,
    });
  }
  return order.map((id) => byId.get(id) as MaterialJournalChange);
}

export interface MaterialJournalBuildInput {
  readonly actor: MaterialActor;
  readonly label: string;
  readonly verb?: string;
  readonly changes: readonly MaterialJournalChange[];
  readonly nowIso?: string;
  readonly id?: string;
}

export function buildMaterialJournalEntry(
  input: MaterialJournalBuildInput,
): MaterialJournalEntry {
  const changes = collapseMaterialChanges(input.changes);
  return {
    id: input.id ?? newMaterialJournalEntryId(),
    schemaVersion: MATERIAL_LIBRARY_SCHEMA_VERSION,
    at: input.nowIso ?? new Date().toISOString(),
    actor: input.actor,
    label: input.label.slice(0, 200),
    ...(input.verb ? { verb: input.verb } : {}),
    materialIds: changes.map((change) => change.materialId),
    changes,
    undone: false,
  };
}

export interface MaterialUndoOutcome {
  readonly records: readonly MaterialRecord[];
  readonly restored: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Apply one journal entry's inverse to a record list: walking the changes in
 * reverse, every record goes back to its `before` state (deleted when the
 * batch created it). Returns the new list; the input is not mutated.
 */
export function applyMaterialJournalUndo(
  records: readonly MaterialRecord[],
  entry: MaterialJournalEntry,
): MaterialUndoOutcome {
  const map = new Map(records.map((record) => [record.id, record]));
  const restored: string[] = [];
  const removed: string[] = [];
  for (const change of [...entry.changes].reverse()) {
    if (change.before === null) {
      if (map.delete(change.materialId)) removed.push(change.materialId);
    } else {
      map.set(change.materialId, change.before);
      restored.push(change.materialId);
    }
  }
  const next = [...map.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return { records: next, restored, removed };
}

/* ------------------------------------------------------------------ */
/* Storage-read normalization                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize one raw stored value into a MaterialRecord, tolerating missing
 * optional fields. Returns null when the value cannot be shaped into a
 * valid record (corrupt rows are skipped, never crash the library).
 */
export function normalizeMaterialRecord(raw: unknown): MaterialRecord | null {
  if (!isPlainObject(raw)) return null;
  const kind = raw.kind;
  if (kind !== "media" && kind !== "segment" && kind !== "link" && kind !== "method") {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled";
  const nowIso = new Date(0).toISOString();
  const base: MaterialRecordBase = {
    schemaVersion: MATERIAL_LIBRARY_SCHEMA_VERSION,
    id,
    kind,
    title,
    tags: sanitizeMaterialTags(
      Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    ),
    organizeStatus: raw.organizeStatus === "organized" ? "organized" : "inbox",
    userNotes: typeof raw.userNotes === "string" ? raw.userNotes : "",
    aiSummary: typeof raw.aiSummary === "string" ? raw.aiSummary : "",
    source: isPlainObject(raw.source)
      ? {
          ...(typeof raw.source.origin === "string" ? { origin: raw.source.origin } : {}),
          ...(typeof raw.source.capturedFrom === "string"
            ? { capturedFrom: raw.source.capturedFrom }
            : {}),
          addedBy: raw.source.addedBy === "agent" ? ("agent" as const) : ("user" as const),
          addedAt: typeof raw.source.addedAt === "string" ? raw.source.addedAt : nowIso,
        }
      : { addedBy: "user" as const, addedAt: nowIso },
    updatedBy: raw.updatedBy === "agent" ? ("agent" as const) : ("user" as const),
    ...(typeof raw.lastAgentEditAt === "string" ? { lastAgentEditAt: raw.lastAgentEditAt } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso,
    revision: typeof raw.revision === "number" && Number.isFinite(raw.revision) && raw.revision >= 1
      ? Math.floor(raw.revision)
      : 1,
    usages: Array.isArray(raw.usages)
      ? (raw.usages as unknown[]).filter(isPlainObject).map((usage) => ({
          projectId: typeof usage.projectId === "string" ? usage.projectId : "",
          ...(typeof usage.projectName === "string" ? { projectName: usage.projectName } : {}),
          ...(typeof usage.mediaIdInProject === "string"
            ? { mediaIdInProject: usage.mediaIdInProject }
            : {}),
          ...(typeof usage.startSec === "number" ? { startSec: usage.startSec } : {}),
          ...(typeof usage.endSec === "number" ? { endSec: usage.endSec } : {}),
          attachedAt: typeof usage.attachedAt === "string" ? usage.attachedAt : nowIso,
          attachedBy:
            usage.attachedBy === "agent" || usage.attachedBy === "user"
              ? usage.attachedBy
              : ("unknown" as const),
          status: usage.status === "historical" ? ("historical" as const) : ("current" as const),
          ...(typeof usage.historicalAt === "string"
            ? { historicalAt: usage.historicalAt }
            : {}),
          ...(usage.historicalReason === "replaced" || usage.historicalReason === "removed"
            ? { historicalReason: usage.historicalReason }
            : {}),
          ...(typeof usage.replacedByMediaIdInProject === "string"
            ? { replacedByMediaIdInProject: usage.replacedByMediaIdInProject }
            : {}),
          ...(typeof usage.replacedByMaterialId === "string"
            ? { replacedByMaterialId: usage.replacedByMaterialId }
            : {}),
          ...(typeof usage.replacesMediaIdInProject === "string"
            ? { replacesMediaIdInProject: usage.replacesMediaIdInProject }
            : {}),
          ...(typeof usage.replacesMaterialId === "string"
            ? { replacesMaterialId: usage.replacesMaterialId }
            : {}),
        }))
      : [],
  };

  switch (kind) {
    case "media": {
      const ref = isPlainObject(raw.fileRef)
        ? raw.fileRef
        : undefined;
      if (!ref || (ref.type !== "path" && ref.type !== "blob")) return null;
      if (ref.type === "path" && typeof ref.path !== "string") return null;
      const mediaType =
        raw.mediaType === "video" || raw.mediaType === "audio" || raw.mediaType === "image"
          ? raw.mediaType
          : null;
      if (!mediaType) return null;
      return {
        ...base,
        kind: "media",
        mediaType,
        fileRef: ref as unknown as MaterialFileRef,
        metadata: isPlainObject(raw.metadata)
          ? (raw.metadata as unknown as MaterialMediaMetadata)
          : {},
        ...(typeof raw.thumbnailDataUrl === "string"
          ? { thumbnailDataUrl: raw.thumbnailDataUrl }
          : {}),
      };
    }
    case "segment": {
      const parentMaterialId = typeof raw.parentMaterialId === "string" ? raw.parentMaterialId : "";
      const startSec = typeof raw.startSec === "number" ? raw.startSec : Number.NaN;
      const endSec = typeof raw.endSec === "number" ? raw.endSec : Number.NaN;
      if (!parentMaterialId || !isValidSegmentRange(startSec, endSec)) return null;
      return { ...base, kind: "segment", parentMaterialId, startSec, endSec };
    }
    case "link": {
      const url = typeof raw.url === "string" ? raw.url : "";
      if (!url) return null;
      return {
        ...base,
        kind: "link",
        url,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      };
    }
    case "method": {
      const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
      if (!prompt) return null;
      return {
        ...base,
        kind: "method",
        ...(typeof raw.skillName === "string" ? { skillName: raw.skillName } : {}),
        prompt,
        ...(Array.isArray(raw.steps)
          ? {
              steps: (raw.steps as unknown[]).filter((s): s is string => typeof s === "string"),
            }
          : {}),
        ...(Array.isArray(raw.inputs)
          ? {
              inputs: (raw.inputs as unknown[]).filter((s): s is string => typeof s === "string"),
            }
          : {}),
      };
    }
  }
}

export function normalizeMaterialJournalEntry(
  raw: unknown,
): MaterialJournalEntry | null {
  if (!isPlainObject(raw)) return null;
  if (!Array.isArray(raw.changes)) return null;
  const changes: MaterialJournalChange[] = [];
  for (const change of raw.changes) {
    if (!isPlainObject(change)) continue;
    if (typeof change.materialId !== "string") continue;
    const before =
      change.before === null ? null : normalizeMaterialRecord(change.before);
    const after = change.after === null ? null : normalizeMaterialRecord(change.after);
    // Drop changes whose payload failed to normalize — undo stays best-effort
    // rather than crashing the whole entry.
    if (change.before !== null && before === null) continue;
    if (change.after !== null && after === null) continue;
    changes.push({
      materialId: change.materialId,
      before,
      after,
    });
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    schemaVersion: MATERIAL_LIBRARY_SCHEMA_VERSION,
    at: typeof raw.at === "string" ? raw.at : new Date(0).toISOString(),
    actor: raw.actor === "agent" ? ("agent" as const) : ("user" as const),
    label: typeof raw.label === "string" ? raw.label : "material library change",
    ...(typeof raw.verb === "string" ? { verb: raw.verb } : {}),
    materialIds: Array.isArray(raw.materialIds)
      ? (raw.materialIds as unknown[]).filter((v): v is string => typeof v === "string")
      : changes.map((change) => change.materialId),
    changes,
    undone: raw.undone === true,
    ...(typeof raw.undoneAt === "string" ? { undoneAt: raw.undoneAt } : {}),
  };
}
