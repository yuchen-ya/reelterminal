/**
 * Attach a user-level material to the CURRENT project.
 *
 * The project references the material — it never owns it:
 *  1. resolve the material's bytes (desktop path read or the library's own
 *     blob copy); a missing source fails loudly with MISSING_FILE;
 *  2. import through the canonical project-store import path (same code as
 *     picker/drop/agent imports: metadata, persistence, autosave, one
 *     history group, project-revision CAS);
 *  3. optionally add the timeline clip — segments always add their stored
 *     range as in/out points;
 *  4. record the usage on the material (informational provenance).
 *
 * Nothing here deletes or moves the user's original file, and removing the
 * project reference later never touches the library.
 */
import type { Action } from "@openreel/core";
import {
  isValidSegmentRange,
  type MaterialRecord,
  type MaterialUsage,
  type MediaMaterialRecord,
} from "@openreel/core";
import { v4 as uuidv4 } from "uuid";
import { getProjectRevision, useProjectStore } from "../../stores/project-store";
import { getMaterialLibraryService } from "./library-service";

/** Same whole-file bound as the live import path (Electron IPC ArrayBuffer). */
export const MAX_MATERIAL_ATTACH_BYTES = 256 * 1024 * 1024;

export interface AttachMaterialOptions {
  readonly materialId: string;
  /** Optional range override for MEDIA materials (segments use their own). */
  readonly startSec?: number;
  readonly endSec?: number;
  /** Project revision CAS (the agent path always passes a fresh one). */
  readonly expectedRevision?: number;
  readonly actor: "user" | "agent";
  /** Add a timeline clip (default: true for segments/ranges, false for whole media). */
  readonly addClip?: boolean;
  /** Timeline position for the clip; default: end of the current timeline. */
  readonly startTimeSec?: number;
}

export interface AttachMaterialSuccess {
  readonly materialId: string;
  readonly mediaIdInProject: string;
  readonly projectId: string;
  readonly projectName: string;
  /** Set when a timeline clip was added. */
  readonly clipId: string | null;
  readonly rangeSec: { readonly startSec: number; readonly endSec: number } | null;
  readonly revision: number;
}

export type AttachMaterialResult =
  | { readonly ok: true; readonly value: AttachMaterialSuccess }
  | {
      readonly ok: false;
      readonly code: "NOT_FOUND" | "INVALID_PARAMS" | "CONFLICT" | "MISSING_FILE" | "INTERNAL";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

function pathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "media";
}

function mediaMimeType(value: string): string {
  const extension = pathBasename(value).split(".").pop()?.toLowerCase();
  switch (extension) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Resolve the readable bytes of a media material record. */
async function resolveMediaFile(
  record: MediaMaterialRecord,
): Promise<{ file: File; sourcePath?: string } | { error: AttachMaterialResult }> {
  if (record.fileRef.type === "path") {
    const fsBridge =
      typeof window === "undefined" ? undefined : window.openreel?.fs;
    if (!fsBridge?.readFileBytes || !fsBridge.pathStatus) {
      return {
        error: {
          ok: false,
          code: "INVALID_PARAMS",
          message:
            "desktop file access is unavailable in this editor, so this path-referenced material cannot be attached here",
          details: { path: record.fileRef.path },
        },
      };
    }
    const status = await fsBridge.pathStatus(record.fileRef.path);
    if (!status.exists || !status.isFile) {
      return {
        error: {
          ok: false,
          code: "MISSING_FILE",
          message: `source file is missing: ${record.fileRef.path}`,
          details: { path: record.fileRef.path },
        },
      };
    }
    if ((status.sizeBytes ?? 0) > MAX_MATERIAL_ATTACH_BYTES) {
      return {
        error: {
          ok: false,
          code: "INVALID_PARAMS",
          message: `source file exceeds the ${MAX_MATERIAL_ATTACH_BYTES}-byte attach limit`,
          details: { path: record.fileRef.path, bytes: status.sizeBytes },
        },
      };
    }
    try {
      const bytes = await fsBridge.readFileBytes(
        record.fileRef.path,
        MAX_MATERIAL_ATTACH_BYTES,
      );
      return {
        file: new File([bytes], record.fileRef.fileName, {
          type: record.fileRef.path ? mediaMimeType(record.fileRef.path) : "application/octet-stream",
          lastModified: record.fileRef.lastModifiedMs ?? Date.now(),
        }),
        sourcePath: record.fileRef.path,
      };
    } catch (error) {
      return {
        error: {
          ok: false,
          code: "INVALID_PARAMS",
          message: error instanceof Error ? error.message : "failed to read local media file",
          details: { path: record.fileRef.path },
        },
      };
    }
  }
  const service = getMaterialLibraryService();
  const blob = await service.loadBlobFor(record.id);
  if (!blob) {
    return {
      error: {
        ok: false,
        code: "MISSING_FILE",
        message: `the stored copy of "${record.fileRef.fileName}" is missing from this browser's material library`,
        details: { materialId: record.id },
      },
    };
  }
  return {
    file: new File([blob], record.fileRef.fileName, {
      type: blob.type || "application/octet-stream",
      lastModified: record.fileRef.lastModifiedMs ?? Date.now(),
    }),
  };
}

function trackTypeFor(mediaType: MediaMaterialRecord["mediaType"]): "video" | "audio" | "image" {
  if (mediaType === "audio") return "audio";
  if (mediaType === "image") return "image";
  return "video";
}

/** Attach one material to the current project. See module doc. */
export async function attachMaterialToProject(
  options: AttachMaterialOptions,
): Promise<AttachMaterialResult> {
  const service = getMaterialLibraryService();
  const materialResult = await service.get(options.materialId);
  if (!materialResult.ok) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: materialResult.message,
      details: { materialId: options.materialId },
    };
  }
  const material: MaterialRecord = materialResult.value;

  // Segments attach through their parent media, scoped to the stored range.
  let sourceMedia: MediaMaterialRecord;
  let range: { startSec: number; endSec: number } | null = null;
  if (material.kind === "segment") {
    const parentResult = await service.get(material.parentMaterialId);
    if (!parentResult.ok) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `the segment's parent material "${material.parentMaterialId}" no longer exists in the library`,
        details: { parentMaterialId: material.parentMaterialId },
      };
    }
    if (parentResult.value.kind !== "media") {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: "the segment's parent is not a media material",
      };
    }
    sourceMedia = parentResult.value;
    range = { startSec: material.startSec, endSec: material.endSec };
  } else if (material.kind === "media") {
    sourceMedia = material;
    if (
      options.startSec !== undefined &&
      options.endSec !== undefined
    ) {
      const duration = sourceMedia.metadata.durationSec;
      if (!isValidSegmentRange(options.startSec, options.endSec, duration)) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: `attach range must satisfy 0 <= startSec < endSec${
            duration !== undefined ? ` within the material duration (${duration}s)` : ""
          }`,
          details: { startSec: options.startSec, endSec: options.endSec },
        };
      }
      range = { startSec: options.startSec, endSec: options.endSec };
    }
  } else {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `only media and segment materials can be attached to a project (this is a "${material.kind}")`,
      details: { materialId: material.id, kind: material.kind },
    };
  }

  const store = useProjectStore.getState();
  if (!store.hasOpenProject) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "no project is open in the editor",
    };
  }

  const resolved = await resolveMediaFile(sourceMedia);
  if ("error" in resolved) return resolved.error;

  const importResult = await useProjectStore.getState().importMedia(resolved.file, {
    ...(resolved.sourcePath ? { sourcePath: resolved.sourcePath } : {}),
    ...(options.expectedRevision !== undefined
      ? { expectedRevision: options.expectedRevision }
      : {}),
    type: sourceMedia.mediaType === "image" ? "image" : sourceMedia.mediaType,
    ...(options.actor === "agent"
      ? {
          historyOwner: "agent",
          historyGroupLabel: "agent: material.attach",
        }
      : {}),
  });
  if (!importResult.success || !importResult.actionId) {
    const reason = importResult.error?.details?.reason;
    return {
      ok: false,
      code: reason === "CONFLICT" ? "CONFLICT" : "INVALID_PARAMS",
      message: importResult.error?.message ?? "failed to import the material into the project",
      ...(importResult.error?.details ? { details: importResult.error.details } : {}),
    };
  }
  const mediaIdInProject = importResult.actionId;

  // Optional timeline clip. Segments default to on (their range is the
  // point); plain media defaults to import-only, matching the media panel's
  // import UX.
  const wantClip = options.addClip ?? range !== null;
  let clipId: string | null = null;
  if (wantClip) {
    const current = useProjectStore.getState();
    const startTime =
      options.startTimeSec !== undefined
        ? Math.max(0, options.startTimeSec)
        : current.getTimelineDuration();
    const trackId = `track-${uuidv4()}`;
    const clipAction: Action = {
      type: "clip/add",
      id: uuidv4(),
      timestamp: Date.now(),
      params: {
        trackId,
        mediaId: mediaIdInProject,
        startTime,
        ...(range
          ? {
              inPoint: range.startSec,
              outPoint: range.endSec,
              duration: range.endSec - range.startSec,
            }
          : {}),
      },
    };
    const trackAction: Action = {
      type: "track/add",
      id: uuidv4(),
      timestamp: Date.now(),
      params: { trackType: trackTypeFor(sourceMedia.mediaType), trackId },
    };
    const batch = current.executeActionBatch([trackAction, clipAction], {
      groupLabel:
        options.actor === "agent"
          ? "agent: material.attach clip"
          : "Add material clip to timeline",
      historyOwner: options.actor === "agent" ? "agent" : "human",
    });
    if (!batch.result.success) {
      return {
        ok: false,
        code: "INTERNAL",
        message:
          batch.result.error?.message ??
          "the material was imported but its timeline clip could not be added",
        details: { mediaIdInProject },
      };
    }
    clipId = batch.createdIds.clips[0] ?? null;
    window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));
  }

  const finalState = useProjectStore.getState();
  const usage: MaterialUsage = {
    projectId: finalState.project.id,
    projectName: finalState.project.name,
    mediaIdInProject,
    ...(range ? { startSec: range.startSec, endSec: range.endSec } : {}),
    attachedAt: new Date().toISOString(),
    attachedBy: options.actor,
  };
  await service.recordUsage(material.id, usage);

  return {
    ok: true,
    value: {
      materialId: material.id,
      mediaIdInProject,
      projectId: finalState.project.id,
      projectName: finalState.project.name,
      clipId,
      rangeSec: range,
      revision: getProjectRevision(),
    },
  };
}
