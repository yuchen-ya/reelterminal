/**
 * Preview byte resolution for material records: builds a temporary object
 * URL for media/segment previews. Path references read through the desktop
 * fs bridge (bounded like attach); blob references read the library's own
 * copy. Never loads anything during listing/paging — only on explicit
 * preview/attach actions.
 */
import type { MaterialRecord } from "@reelterminal/core";
import { getMaterialLibraryService } from "./library-service";

const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;

export type PreviewSource =
  | { readonly kind: "url"; readonly url: string; readonly cleanup: () => void }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "link"; readonly url: string }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    };

async function objectUrlForMedia(
  record: MaterialRecord,
): Promise<PreviewSource> {
  if (record.kind !== "media") {
    return { kind: "unavailable", reason: "not a media material" };
  }
  if (record.fileRef.type === "path") {
    const fsBridge = typeof window === "undefined" ? undefined : window.reelterminal?.fs;
    if (!fsBridge?.readFileBytes) {
      return {
        kind: "unavailable",
        reason:
          "path-referenced media can only be previewed in the desktop app (this file lives outside the browser's storage)",
      };
    }
    try {
      const status = await fsBridge.pathStatus(record.fileRef.path);
      if (!status.exists || !status.isFile) {
        return { kind: "unavailable", reason: `source file is missing: ${record.fileRef.path}` };
      }
      if ((status.sizeBytes ?? 0) > MAX_PREVIEW_BYTES) {
        return {
          kind: "unavailable",
          reason: "file is too large for in-app preview (attach still works through the import path)",
        };
      }
      const bytes = await fsBridge.readFileBytes(record.fileRef.path, MAX_PREVIEW_BYTES);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: undefined }),
      );
      return { kind: "url", url, cleanup: () => URL.revokeObjectURL(url) };
    } catch (error) {
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const blob = await getMaterialLibraryService().loadBlobFor(record.id);
  if (!blob) {
    return {
      kind: "unavailable",
      reason: `the stored copy of "${record.fileRef.fileName}" is missing from this browser's material library`,
    };
  }
  const url = URL.createObjectURL(blob);
  return { kind: "url", url, cleanup: () => URL.revokeObjectURL(url) };
}

/** Resolve a preview for any material record (segment resolves its parent). */
export async function loadMaterialPreview(
  record: MaterialRecord,
): Promise<PreviewSource> {
  if (record.kind === "link") {
    return { kind: "link", url: record.url };
  }
  if (record.kind === "method") {
    const parts = [
      ...(record.skillName ? [`Skill: ${record.skillName}`] : []),
      record.prompt,
      ...(record.steps && record.steps.length > 0
        ? ["", "Steps:", ...record.steps.map((step, index) => `${index + 1}. ${step}`)]
        : []),
      ...(record.inputs && record.inputs.length > 0
        ? ["", "Inputs:", ...record.inputs.map((input) => `- ${input}`)]
        : []),
    ];
    return { kind: "text", value: parts.join("\n") };
  }
  if (record.kind === "segment") {
    const parent = await getMaterialLibraryService().get(record.parentMaterialId);
    if (!parent.ok) {
      return {
        kind: "unavailable",
        reason: "the segment's parent material no longer exists in the library",
      };
    }
    return objectUrlForMedia(parent.value);
  }
  return objectUrlForMedia(record);
}
