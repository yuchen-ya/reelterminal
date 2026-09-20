/**
 * Best-effort availability probing for media material files.
 *
 * Status is COMPUTED, never persisted: a material may legitimately exist in
 * the library while its source file is missing (renamed, external drive
 * unplugged…). The UI shows that state explicitly instead of pretending the
 * resource is usable, and attach/preview fail with a clear error.
 */
import type {
  MaterialFileStatus,
  MaterialRecord,
  MediaMaterialRecord,
} from "@reelterminal/core";
import { getMaterialLibraryService } from "./library-service";

export function isMediaMaterial(
  record: MaterialRecord,
): record is MediaMaterialRecord {
  return record.kind === "media";
}

/**
 * Probe one media material. Path references need the desktop fs bridge;
 * blob references check the library's own blob store. "unknown" means the
 * current runtime cannot verify (e.g. a desktop path material opened in a
 * browser) — shown as unverified, not as missing.
 */
export async function probeMaterialFileStatus(
  record: MaterialRecord,
): Promise<MaterialFileStatus> {
  if (!isMediaMaterial(record)) return "ok";
  if (record.fileRef.type === "path") {
    const pathStatus = typeof window === "undefined" ? undefined : window.reelterminal?.fs?.pathStatus;
    if (!pathStatus) return "unknown";
    try {
      const status = await pathStatus(record.fileRef.path);
      return status.exists && status.isFile ? "ok" : "missing";
    } catch {
      return "unknown";
    }
  }
  try {
    const service = getMaterialLibraryService();
    const blob = await service.loadBlobFor(record.id);
    return blob ? "ok" : "missing";
  } catch {
    return "unknown";
  }
}

/** Probe a page of media materials in parallel; segments resolve via parents. */
export async function probeMaterialFileStatuses(
  records: readonly MaterialRecord[],
): Promise<Map<string, MaterialFileStatus>> {
  const results = new Map<string, MaterialFileStatus>();
  const mediaById = new Map<string, MediaMaterialRecord>();
  for (const record of records) {
    if (isMediaMaterial(record)) mediaById.set(record.id, record);
  }
  await Promise.all(
    [...mediaById.values()].map(async (record) => {
      results.set(record.id, await probeMaterialFileStatus(record));
    }),
  );
  for (const record of records) {
    if (record.kind === "segment") {
      results.set(record.id, results.get(record.parentMaterialId) ?? "unknown");
    }
  }
  return results;
}
