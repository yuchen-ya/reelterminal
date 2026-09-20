/**
 * Access service for user-level custom presets.
 *
 * Single source of truth for preset CRUD: an in-memory cache over the
 * storage layer, one promise-chained write lane serializing every mutation,
 * and a monotonic per-record `revision` used as a CAS guard so a concurrent
 * editor (GUI panel vs agent session) is rejected with CONFLICT instead of
 * being silently overwritten.
 *
 * Every successful change commits in one storage transaction and then
 * broadcasts `reelterminal:custom-presets-updated` on `window`, so open panels
 * re-render without any polling. There is deliberately NO undo journal:
 * deleting a preset is final, and applied projects are unaffected by
 * deletion because application copies payloads by value.
 */
import { v4 as uuid } from "uuid";
import {
  PRESET_RECORD_VERSION,
  PRESET_KINDS,
  type CustomPresetRecord,
  type PresetKind,
} from "@reelterminal/core/presets/types";
import {
  validatePresetName,
  validatePresetPayload,
  validatePresetRecord,
  validatePresetThumbnail,
} from "@reelterminal/core/presets/validate";
import { createIdbPresetStorage, PresetStorageUnavailableError, type PresetStorage } from "./storage";

export const CUSTOM_PRESETS_UPDATED_EVENT = "reelterminal:custom-presets-updated";

export function notifyPresetsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CUSTOM_PRESETS_UPDATED_EVENT));
  }
}

export type PresetServiceErrorCode =
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_PARAMS"
  | "INTERNAL";

export interface PresetServiceError {
  readonly ok: false;
  readonly code: PresetServiceErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface PresetServiceResult<T> {
  readonly ok: true;
  readonly value: T;
}

export type PresetServiceOutcome<T> = PresetServiceResult<T> | PresetServiceError;

export interface PresetUnreadableEntry {
  readonly id: string;
  readonly reason: string;
}

export interface PresetListResult {
  /** Usable records, newest-first by updatedAt. */
  readonly presets: readonly CustomPresetRecord[];
  /** Rows skipped at load: newer record versions or failed validation. */
  readonly unreadable: readonly PresetUnreadableEntry[];
}

export interface CustomPresetCreateInput {
  readonly kind: PresetKind;
  readonly name: string;
  /** Unknown-shaped payload; must pass core validation before persisting. */
  readonly payload: unknown;
  readonly tags?: readonly string[];
  readonly builtinBaseId?: string;
  readonly thumbnailDataUrl?: string;
  /** Client-chosen id (defaults to `preset_<uuid>`); duplicates are CONFLICT. */
  readonly id?: string;
  /** Session-scoped idempotency key: same key replays the first result. */
  readonly requestId?: string;
  readonly now?: number;
}

export interface CustomPresetUpdateInput {
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly payload?: unknown;
  /** Pass null to clear the thumbnail. */
  readonly thumbnailDataUrl?: string | null;
  /** CAS guard: the revision the caller last saw. */
  readonly expectedRevision?: number;
  readonly now?: number;
}

export interface CustomPresetRemoveResult {
  readonly id: string;
  readonly alreadyGone: boolean;
}

function fail<T>(
  code: PresetServiceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): PresetServiceOutcome<T> {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  return tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

function toUnreadable(id: string, reason: string): PresetUnreadableEntry {
  return { id, reason };
}

export class CustomPresetService {
  private readonly storage: PresetStorage;
  private readonly records = new Map<string, CustomPresetRecord>();
  private readonly requestIdIndex = new Map<string, CustomPresetRecord>();
  private unreadableEntries: PresetUnreadableEntry[] = [];
  private snapshot: CustomPresetRecord[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: PresetStorage = createIdbPresetStorage()) {
    this.storage = storage;
  }

  /** Load + normalize persisted state once (idempotent, conservative). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const rawRows = await this.storage.loadAll();
        const unreadable: PresetUnreadableEntry[] = [];
        for (const raw of rawRows) {
          const id =
            typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
              ? ((raw as { id: string }).id)
              : "<missing-id>";
          const recordVersion =
            typeof raw === "object" && raw !== null
              ? ((raw as { recordVersion?: unknown }).recordVersion ?? PRESET_RECORD_VERSION)
              : undefined;
          // Newer record versions are skipped, never misread and never dropped.
          if (typeof recordVersion === "number" && recordVersion > PRESET_RECORD_VERSION) {
            unreadable.push(
              toUnreadable(id, `record version ${recordVersion} is newer than supported version ${PRESET_RECORD_VERSION}`),
            );
            continue;
          }
          const result = validatePresetRecord(raw);
          if (result.ok) {
            this.records.set(result.value.id, result.value);
          } else {
            unreadable.push(toUnreadable(id, `${result.code}: ${result.message}`));
          }
        }
        this.unreadableEntries = unreadable;
        this.rebuildSnapshot();
        this.loaded = true;
      })().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private rebuildSnapshot(): void {
    this.snapshot = [...this.records.values()].sort(
      (first, second) =>
        second.updatedAt - first.updatedAt || first.id.localeCompare(second.id),
    );
  }

  private enqueue<T>(body: () => Promise<PresetServiceOutcome<T>>): Promise<PresetServiceOutcome<T>> {
    const next = this.chain.then(body, body);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private mapStorageError(error: unknown): PresetServiceErrorCode {
    if (error instanceof PresetStorageUnavailableError) return "UNAVAILABLE";
    return "INTERNAL";
  }

  /* ------------------------------ reads ------------------------------ */

  async list(
    kind?: PresetKind,
    query?: string,
  ): Promise<PresetServiceOutcome<PresetListResult>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      const needle = query?.trim().toLowerCase();
      const presets = this.snapshot.filter((record) => {
        if (kind && record.kind !== kind) return false;
        if (!needle) return true;
        return (
          record.name.toLowerCase().includes(needle) ||
          record.tags.some((tag) => tag.toLowerCase().includes(needle))
        );
      });
      return { ok: true, value: { presets, unreadable: this.unreadableEntries } };
    } catch (error) {
      return fail(this.mapStorageError(error), `preset list failed: ${String(error)}`);
    }
  }

  async get(id: string): Promise<PresetServiceOutcome<CustomPresetRecord>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      const record = this.records.get(id);
      if (!record) return fail("NOT_FOUND", `preset "${id}" was not found`, { id });
      return { ok: true, value: record };
    } catch (error) {
      return fail(this.mapStorageError(error), `preset read failed: ${String(error)}`);
    }
  }

  /** Synchronous snapshot for hook initial state (may be empty before load). */
  getSnapshot(kind?: PresetKind): readonly CustomPresetRecord[] {
    if (!kind) return this.snapshot;
    return this.snapshot.filter((record) => record.kind === kind);
  }

  /* ---------------------------- mutations ---------------------------- */

  async create(input: CustomPresetCreateInput): Promise<PresetServiceOutcome<CustomPresetRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        if (input.requestId) {
          const replayed = this.requestIdIndex.get(input.requestId);
          if (replayed) return { ok: true, value: replayed };
        }
        if (!(PRESET_KINDS as readonly string[]).includes(input.kind)) {
          return fail("INVALID_PARAMS", `unknown preset kind: ${String(input.kind)}`, {
            field: "kind",
          });
        }
        const name = validatePresetName(input.name);
        if (!name.ok) {
          return fail("INVALID_PARAMS", name.message, { validationCode: name.code });
        }
        const payload = validatePresetPayload(input.payload);
        if (!payload.ok) {
          return fail("INVALID_PARAMS", payload.message, {
            validationCode: payload.code,
            details: payload.details,
          });
        }
        if (input.thumbnailDataUrl !== undefined) {
          const thumbnail = validatePresetThumbnail(input.thumbnailDataUrl);
          if (!thumbnail.ok) {
            return fail("INVALID_PARAMS", thumbnail.message, {
              validationCode: thumbnail.code,
              details: thumbnail.details,
            });
          }
        }
        const id = input.id ?? `preset_${uuid()}`;
        if (this.records.has(id)) {
          return fail("CONFLICT", `preset "${id}" already exists`, { id });
        }
        const now = input.now ?? Date.now();
        const record: CustomPresetRecord = {
          id,
          kind: input.kind,
          name: name.value,
          tags: normalizeTags(input.tags),
          ...(input.builtinBaseId !== undefined ? { builtinBaseId: input.builtinBaseId } : {}),
          ...(input.thumbnailDataUrl !== undefined
            ? { thumbnailDataUrl: input.thumbnailDataUrl }
            : {}),
          payload: payload.value,
          createdAt: now,
          updatedAt: now,
          revision: 1,
          recordVersion: PRESET_RECORD_VERSION,
        };
        await this.storage.commit([record], []);
        this.records.set(record.id, record);
        if (input.requestId) this.requestIdIndex.set(input.requestId, record);
        this.rebuildSnapshot();
        notifyPresetsChanged();
        return { ok: true, value: record };
      } catch (error) {
        return fail(this.mapStorageError(error), `preset create failed: ${String(error)}`);
      }
    });
  }

  async update(
    id: string,
    patch: CustomPresetUpdateInput,
  ): Promise<PresetServiceOutcome<CustomPresetRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `preset "${id}" was not found`, { id });
        if (
          patch.expectedRevision !== undefined &&
          patch.expectedRevision !== current.revision
        ) {
          return fail(
            "CONFLICT",
            `preset "${id}" was modified concurrently: expected revision ${patch.expectedRevision}, current is ${current.revision} — re-read and retry`,
            { id, currentRevision: current.revision, expectedRevision: patch.expectedRevision },
          );
        }

        let name = current.name;
        if (patch.name !== undefined) {
          const validated = validatePresetName(patch.name);
          if (!validated.ok) {
            return fail("INVALID_PARAMS", validated.message, { validationCode: validated.code });
          }
          name = validated.value;
        }
        let payload = current.payload;
        if (patch.payload !== undefined) {
          const validated = validatePresetPayload(patch.payload);
          if (!validated.ok) {
            return fail("INVALID_PARAMS", validated.message, {
              validationCode: validated.code,
              details: validated.details,
            });
          }
          payload = validated.value;
        }
        let thumbnailDataUrl = current.thumbnailDataUrl;
        if (patch.thumbnailDataUrl !== undefined) {
          if (patch.thumbnailDataUrl === null) {
            thumbnailDataUrl = undefined;
          } else {
            const validated = validatePresetThumbnail(patch.thumbnailDataUrl);
            if (!validated.ok) {
              return fail("INVALID_PARAMS", validated.message, {
                validationCode: validated.code,
                details: validated.details,
              });
            }
            thumbnailDataUrl = validated.value;
          }
        }

        const next: CustomPresetRecord = {
          id: current.id,
          kind: current.kind,
          name,
          tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
          ...(current.builtinBaseId !== undefined
            ? { builtinBaseId: current.builtinBaseId }
            : {}),
          ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
          payload,
          createdAt: current.createdAt,
          updatedAt: patch.now ?? Date.now(),
          revision: current.revision + 1,
          recordVersion: current.recordVersion,
        };
        await this.storage.commit([next], []);
        this.records.set(next.id, next);
        this.rebuildSnapshot();
        notifyPresetsChanged();
        return { ok: true, value: next };
      } catch (error) {
        return fail(this.mapStorageError(error), `preset update failed: ${String(error)}`);
      }
    });
  }

  /** Idempotent: removing an absent id succeeds with `alreadyGone: true`. */
  async remove(id: string): Promise<PresetServiceOutcome<CustomPresetRemoveResult>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const existing = this.records.get(id);
        if (!existing) return { ok: true, value: { id, alreadyGone: true } };
        await this.storage.commit([], [id]);
        this.records.delete(id);
        for (const [key, record] of this.requestIdIndex) {
          if (record.id === id) this.requestIdIndex.delete(key);
        }
        this.rebuildSnapshot();
        notifyPresetsChanged();
        return { ok: true, value: { id, alreadyGone: false } };
      } catch (error) {
        return fail(this.mapStorageError(error), `preset remove failed: ${String(error)}`);
      }
    });
  }
}

let singleton: CustomPresetService | null = null;

/** Process-wide service bound to the real IndexedDB storage. */
export function getCustomPresetService(): CustomPresetService {
  if (!singleton) singleton = new CustomPresetService();
  return singleton;
}

/** Test-only: replace the process-wide service (e.g. with an in-memory one). */
export function setCustomPresetServiceForTests(service: CustomPresetService | null): void {
  singleton = service;
}

let initPromise: Promise<void> | null = null;

/**
 * Warms the cache once; safe to call from every panel mount. Failures do not
 * throw to the caller — panels render whatever the snapshot holds and the
 * service surfaces UNAVAILABLE on actual operations.
 */
export function initCustomPresets(): Promise<void> {
  if (!initPromise) {
    initPromise = getCustomPresetService()
      .ensureLoaded()
      .catch(() => undefined);
  }
  return initPromise;
}
