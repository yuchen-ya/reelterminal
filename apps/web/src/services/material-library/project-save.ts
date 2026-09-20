/**
 * Save a PROJECT media item into the user-level material library.
 *
 * Reference strategy (documented, never silent):
 *  - Desktop items with a known absolute source path (originalUrl) become
 *    PATH references — the original file is never copied or moved.
 *  - Blob-backed items (browser imports) are stored as the library's own
 *    blob copy, exactly like a direct "add file to library" action.
 * The project keeps its own copy either way; removing the library entry or
 * the project reference never affects the other side.
 */
import type { MediaItem } from "@reelterminal/core";
import type { MediaMaterialRecord } from "@reelterminal/core";
import { getMaterialLibraryService } from "./library-service";

const MAX_SAVED_BLOB_BYTES = 256 * 1024 * 1024;

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Best-effort small inline thumbnail for a freshly added image file. */
async function imageThumbnailDataUrl(file: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch {
    return undefined;
  }
}

export interface SaveProjectMediaResult {
  readonly ok: boolean;
  readonly material?: MediaMaterialRecord;
  readonly error?: { code: string; message: string };
}

/** Find an existing library material created from this project media path. */
export async function findMaterialBySourcePath(
  path: string,
): Promise<MediaMaterialRecord | null> {
  const service = getMaterialLibraryService();
  const list = await service.list({ page: 1, pageSize: 200, kind: "media" });
  if (!list.ok) return null;
  for (const record of list.value.items) {
    if (record.kind === "media" && record.fileRef.type === "path" && record.fileRef.path === path) {
      return record;
    }
  }
  // Continue through pages only when the first page was full.
  for (let page = 2; page <= list.value.totalPages && page <= 10; page += 1) {
    const next = await service.list({ page, pageSize: 200, kind: "media" });
    if (!next.ok) return null;
    for (const record of next.value.items) {
      if (
        record.kind === "media" &&
        record.fileRef.type === "path" &&
        record.fileRef.path === path
      ) {
        return record;
      }
    }
  }
  return null;
}

export async function saveProjectMediaToLibrary(
  item: MediaItem,
): Promise<SaveProjectMediaResult> {
  const service = getMaterialLibraryService();
  const mediaType = item.type;

  // Desktop path reference.
  const sourcePath = item.originalUrl;
  if (sourcePath && isAbsoluteLocalPath(sourcePath)) {
    const existing = await findMaterialBySourcePath(sourcePath);
    if (existing) return { ok: true, material: existing };
    const fileName =
      item.sourceFile?.name ?? sourcePath.split(/[\\/]/).pop() ?? item.name;
    const result = await service.create(
      {
        kind: "media",
        title: item.name,
        mediaType,
        fileRef: {
          type: "path",
          path: sourcePath,
          fileName,
          ...(item.sourceFile?.size !== undefined
            ? { sizeBytes: item.sourceFile.size }
            : item.metadata?.fileSize !== undefined
              ? { sizeBytes: item.metadata.fileSize }
              : {}),
          ...(item.sourceFile?.lastModified !== undefined
            ? { lastModifiedMs: item.sourceFile.lastModified }
            : {}),
        },
        metadata: {
          ...(item.metadata?.duration !== undefined
            ? { durationSec: item.metadata.duration }
            : {}),
          ...(item.metadata?.width ? { width: item.metadata.width } : {}),
          ...(item.metadata?.height ? { height: item.metadata.height } : {}),
          ...(item.metadata?.frameRate ? { frameRate: item.metadata.frameRate } : {}),
          ...(item.metadata?.codec ? { codec: item.metadata.codec } : {}),
          ...(item.metadata?.sampleRate
            ? { sampleRate: item.metadata.sampleRate }
            : {}),
          ...(item.metadata?.channels ? { channels: item.metadata.channels } : {}),
          ...(item.metadata?.fileSize !== undefined
            ? { fileSizeBytes: item.metadata.fileSize }
            : {}),
        },
        ...(item.thumbnailUrl?.startsWith("data:")
          ? { thumbnailDataUrl: item.thumbnailUrl }
          : {}),
        origin: "Saved from project media",
      },
      "user",
    );
    if (!result.ok) {
      return { ok: false, error: { code: result.code, message: result.message } };
    }
    return { ok: true, material: result.value.material as MediaMaterialRecord };
  }

  // Blob copy (browser import or FSA handle).
  let blob: Blob | null = item.blob;
  if (!blob && item.fileHandle) {
    try {
      blob = await item.fileHandle.getFile();
    } catch {
      blob = null;
    }
  }
  if (!blob) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message:
          "This project media has no readable source (missing blob, handle, and path) and cannot be saved to the library",
      },
    };
  }
  if (blob.size > MAX_SAVED_BLOB_BYTES) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: `File exceeds the ${MAX_SAVED_BLOB_BYTES}-byte library copy limit; move it to a stable location and add it by path (desktop)`,
      },
    };
  }
  const thumbnail =
    mediaType === "image" ? await imageThumbnailDataUrl(blob) : undefined;
  const result = await service.create(
    {
      kind: "media",
      title: item.name,
      mediaType,
      fileRef: {
        type: "blob",
        fileName: item.name,
        ...(blob.type ? { mimeType: blob.type } : {}),
        sizeBytes: blob.size,
        lastModifiedMs: blob instanceof File ? blob.lastModified : Date.now(),
      },
      metadata: {
        ...(item.metadata?.duration !== undefined
          ? { durationSec: item.metadata.duration }
          : {}),
        ...(item.metadata?.width ? { width: item.metadata.width } : {}),
        ...(item.metadata?.height ? { height: item.metadata.height } : {}),
        ...(item.metadata?.frameRate ? { frameRate: item.metadata.frameRate } : {}),
        ...(item.metadata?.codec ? { codec: item.metadata.codec } : {}),
        ...(item.metadata?.fileSize !== undefined
          ? { fileSizeBytes: item.metadata.fileSize }
          : {}),
      },
      ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {}),
      ...(item.thumbnailUrl?.startsWith("data:")
        ? { thumbnailDataUrl: item.thumbnailUrl }
        : {}),
      origin: "Saved from project media",
    },
    "user",
  );
  if (!result.ok) {
    return { ok: false, error: { code: result.code, message: result.message } };
  }
  return { ok: true, material: result.value.material as MediaMaterialRecord };
}

/** Add a brand-new local file (picker) as a media material. */
export async function saveLocalFileToLibrary(file: File): Promise<SaveProjectMediaResult> {
  const service = getMaterialLibraryService();
  if (file.size > MAX_SAVED_BLOB_BYTES) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: `File exceeds the ${MAX_SAVED_BLOB_BYTES}-byte library copy limit`,
      },
    };
  }
  const mediaType: "video" | "audio" | "image" = file.type.startsWith("audio/")
    ? "audio"
    : file.type.startsWith("image/")
      ? "image"
      : "video";
  const thumbnail =
    mediaType === "image" ? await imageThumbnailDataUrl(file) : undefined;
  // Desktop: prefer a stable path reference over copying bytes.
  const pathForFile =
    typeof window === "undefined"
      ? undefined
      : (() => {
          try {
            const resolved = window.openreel?.fs?.getPathForFile(file);
            return resolved && isAbsoluteLocalPath(resolved) ? resolved : undefined;
          } catch {
            return undefined;
          }
        })();
  const result = await service.create(
    {
      kind: "media",
      mediaType,
      ...(pathForFile
        ? {
            fileRef: {
              type: "path" as const,
              path: pathForFile,
              fileName: file.name,
              sizeBytes: file.size,
              lastModifiedMs: file.lastModified,
            },
          }
        : {
            fileRef: {
              type: "blob" as const,
              fileName: file.name,
              ...(file.type ? { mimeType: file.type } : {}),
              sizeBytes: file.size,
              lastModifiedMs: file.lastModified,
            },
            blob: file,
          }),
      ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {}),
      origin: "Added from file",
    },
    "user",
  );
  if (!result.ok) {
    return { ok: false, error: { code: result.code, message: result.message } };
  }
  return { ok: true, material: result.value.material as MediaMaterialRecord };
}
