import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import { hashMediaBlob } from "@reelterminal/core";
import type { Action, MediaItem, Project } from "@reelterminal/core";
import type { ProjectState } from "../project-store";
import { getMediaBridge, initializeMediaBridge } from "../../bridges/media-bridge";
import {
  loadMediaBlob,
  loadMediaRecord,
  saveMediaBlob,
  withMediaReferenceWrite,
} from "../../services/media-storage";
import {
  ensureProjectMediaGc,
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
} from "../../services/project-media-gc";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type MediaSlice = Pick<
  ProjectState,
  | "importMedia"
  | "importMediaFromPath"
  | "deleteMedia"
  | "replaceMediaAsset"
  | "relinkMediaAsset"
  | "adoptMediaCandidate"
  | "renameMedia"
  | "getMediaItem"
>;

/** Optional provenance/coordination data for an import. */
export interface ImportMediaOptions {
  /** Explicit write target for multi-workspace callers. */
  readonly projectId?: string;
  readonly workspaceId?: string;
  /** Absolute path supplied by the desktop live-agent bridge. */
  readonly sourcePath?: string;
  /** CAS guard used by live-agent imports. */
  readonly expectedRevision?: number;
  /** Agent-probed media kind. The browser still decodes the bytes for UI data. */
  readonly type?: "video" | "audio" | "image";
  /** Agent-probed metadata, in facade units, when available. */
  readonly metadata?: {
    readonly durationSec: number;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly codec: string;
    readonly fileSize: number;
  };
  /** Source fingerprint supplied by the desktop agent. */
  readonly sourceFile?: {
    readonly name: string;
    readonly size: number;
    readonly lastModified: number;
    readonly folder?: string;
  };
  /** Internal live bridge marker: make this import one agent undo unit. */
  readonly historyOwner?: string;
  readonly historyGroupLabel?: string;
  /** Stable link back to the user-level material selected for this import. */
  readonly materialSource?: NonNullable<MediaItem["materialSource"]>;
  /** Immutable version lineage for explicit replacements. */
  readonly versionSource?: MediaItem["versionSource"];
  /**
   * Renderer-only transaction hook used by compound import flows such as a
   * material segment attach. The returned synchronous core actions are
   * validated with media/import on one isolated draft and published as one
   * project commit + one undo unit. A failed action discards the newly
   * persisted blob and leaves project/history untouched.
   */
  readonly atomicFollowUpActions?: (mediaId: string, mediaItem: MediaItem) => readonly Action[];
  /** Receives ids created by a successful compound import batch. */
  readonly onAtomicBatchCommitted?: (created: {
    readonly tracks: readonly string[];
    readonly clips: readonly string[];
  }) => void;
}

/**
 * Keep path handling in the renderer boundary. The live agent is allowed to
 * provide a local path, but the project store remains the only project writer.
 */
function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Recover provenance for a user-selected Electron File without making the
 * browser build depend on Electron. The preload is the trust boundary: it
 * resolves the path from the native File object via webUtils. Synthetic Files
 * and ordinary browser imports deliberately remain blob-only.
 */
function desktopFileSourcePath(file: File): string | undefined {
  const getPathForFile =
    typeof window === "undefined" ? undefined : window.reelterminal?.fs?.getPathForFile;
  if (!getPathForFile) return undefined;

  try {
    const sourcePath = getPathForFile(file);
    return sourcePath && isAbsoluteLocalPath(sourcePath) ? sourcePath : undefined;
  } catch {
    // A synthetic File is a valid import even though Electron cannot map it
    // back to disk. Preserve browser-compatible blob-only behavior.
    return undefined;
  }
}

function pathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "media";
}

export function mediaMimeType(value: string): string {
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

/** Keep one IPC read bounded even when the host-side probe allowed a larger file. */
const MAX_LIVE_MEDIA_IMPORT_BYTES = 256 * 1024 * 1024;

export interface MediaOperationContext {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly expectedRevision: number;
}

function currentMediaRevision(get: Get, workspaceId?: string | null): number {
  const state = get();
  return workspaceId ? state.workspaceRevision : state.projectRevision;
}

function mediaContextError(
  context: MediaOperationContext | undefined,
  get: Get,
): ReturnType<typeof importError> | null {
  if (!context) return null;
  const state = get();
  if (context.projectId !== state.project.id || context.workspaceId !== state.workspaceId) {
    return importError("INVALID_PARAMS", "The requested project or workspace is not this store instance");
  }
  if (context.expectedRevision !== state.workspaceRevision) {
    return importError(
      "INVALID_PARAMS",
      `Workspace revision mismatch: expected ${context.expectedRevision}, current ${state.workspaceRevision}`,
      { reason: "CONFLICT", currentRevision: state.workspaceRevision },
    );
  }
  return null;
}

function buildRepointActions(
  project: Project,
  oldMediaId: string,
  newMediaId: string,
  newDuration: number,
): Action[] {
  const actions: Action[] = [];
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.mediaId !== oldMediaId) continue;
      if (newDuration > 0 && clip.inPoint >= newDuration - 1e-6) {
        throw new MediaReplacementValidationError(
          `Clip "${clip.id}" starts beyond the replacement source duration ${newDuration}s`,
        );
      }
      const outPoint = newDuration > 0 ? Math.min(clip.outPoint, newDuration) : clip.outPoint;
      const shortened = outPoint < clip.outPoint - 1e-6;
      if (shortened && (clip.speedKeyframes?.length || clip.freezeFrames?.length)) {
        throw new MediaReplacementValidationError(
          `Clip "${clip.id}" must be trimmed before replacing it with a shorter source`,
        );
      }
      const duration = shortened
        ? Math.min(clip.duration, (outPoint - clip.inPoint) / Math.max(clip.speed ?? 1, 1e-6))
        : clip.duration;
      actions.push({
        type: "clip/repointSource",
        id: uuidv4(),
        timestamp: Date.now(),
        params: {
          clipId: clip.id,
          mediaId: newMediaId,
          inPoint: clip.inPoint,
          outPoint,
          duration,
          supersedesMediaId: oldMediaId,
        },
      });
    }
  }
  return actions;
}

class MediaReplacementValidationError extends Error {}

function liveMediaSizeError(path: string, bytes: number) {
  return importError(
    "INVALID_PARAMS",
    `AI media imports are limited to ${MAX_LIVE_MEDIA_IMPORT_BYTES} bytes per file`,
    { path, bytes, maxBytes: MAX_LIVE_MEDIA_IMPORT_BYTES },
  );
}

function importError(
  code: "DECODE_ERROR" | "INVALID_PARAMS",
  message: string,
  details?: Record<string, unknown>,
): { success: false; error: { code: typeof code; message: string; details?: Record<string, unknown> } } {
  return {
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

/**
 * Release the blob URLs an item owns (filmstrip thumbnails created from
 * OffscreenCanvas via createObjectURL; the rest are data: URLs). Only `blob:`
 * URLs made by this store are revoked; data: URLs need no release.
 */
function revokeMediaItemBlobUrls(item: MediaItem): void {
  const urls = [
    ...(item.thumbnailUrl ? [item.thumbnailUrl] : []),
    ...(item.filmstripThumbnails?.map((thumb) => thumb.url) ?? []),
  ];
  for (const url of urls) {
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  }
}

export function createMediaSlice(
  set: Set,
  get: Get,
  invalidateRedoBranches: () => Pick<ProjectState, "templateRedoStack" | "redoJournal">,
): MediaSlice {
  return {
    importMedia: async (file: File, options: ImportMediaOptions = {}) => {
      ensureProjectMediaGc(get().actionHistory, () => get().project);
      const persistenceProjectId = options.projectId ?? get().project.id;
      if (persistenceProjectId !== get().project.id) {
        return importError("INVALID_PARAMS", "The requested project is not this store instance");
      }
      if (options.workspaceId !== undefined && options.workspaceId !== get().workspaceId) {
        return importError("INVALID_PARAMS", "The requested workspace is not this store instance");
      }
      const persistenceActionExecutor = get().actionExecutor;
      if (options.sourcePath !== undefined && !isAbsoluteLocalPath(options.sourcePath)) {
        return importError(
          "INVALID_PARAMS",
          "Media sourcePath must be an absolute local file path",
          { path: options.sourcePath },
        );
      }

      // Resolve this synchronously while the original native File is in hand.
      // All GUI entry points funnel through importMedia, so file-picker and OS
      // drag/drop imports receive identical file-backed provenance.
      const sourcePath = options.sourcePath ?? desktopFileSourcePath(file);

      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== currentMediaRevision(get, options.workspaceId)
      ) {
        return importError(
          "INVALID_PARAMS",
          `Revision mismatch: expected ${options.expectedRevision}, current ${currentMediaRevision(get, options.workspaceId)}`,
          { reason: "CONFLICT", currentRevision: currentMediaRevision(get, options.workspaceId) },
        );
      }

      try {
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) {
          await initializeMediaBridge();
        }

        const isLargeFile = file.size > 50 * 1024 * 1024;
        const importResult = await mediaBridge.importFile(file, true, isLargeFile);

        if (!importResult.success || !importResult.media) {
          return {
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message: importResult.error || "Failed to import media",
            },
          };
        }

        const processedMedia = importResult.media;

        let thumbnailUrl: string | null = null;
        const filmstripThumbnails: { timestamp: number; url: string }[] = [];

        if (processedMedia.thumbnails && processedMedia.thumbnails.length > 0) {
          for (const thumb of processedMedia.thumbnails) {
            let thumbUrl: string | null = null;

            if (thumb.dataUrl) {
              thumbUrl = thumb.dataUrl;
            } else if (thumb.canvas) {
              try {
                if (thumb.canvas instanceof OffscreenCanvas) {
                  const blob = await thumb.canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.7,
                  });
                  thumbUrl = URL.createObjectURL(blob);
                } else if (thumb.canvas instanceof HTMLCanvasElement) {
                  thumbUrl = thumb.canvas.toDataURL("image/jpeg", 0.7);
                }
              } catch (e) {
                console.warn("Failed to convert thumbnail canvas to URL:", e);
              }
            }

            if (thumbUrl) {
              filmstripThumbnails.push({ timestamp: thumb.timestamp, url: thumbUrl });
            }
          }

          if (filmstripThumbnails.length > 0) {
            thumbnailUrl = filmstripThumbnails[0].url;
          }
        }

        let mediaType: "video" | "audio" | "image";
        if (options.type) {
          mediaType = options.type;
        } else if (file.type.startsWith("image/")) {
          mediaType = "image";
        } else if (processedMedia.metadata.hasVideo) {
          mediaType = "video";
        } else if (processedMedia.metadata.hasAudio) {
          mediaType = "audio";
        } else {
          mediaType = "image";
        }

        if (mediaType === "video" && !thumbnailUrl) {
          try {
            const thumbs = await mediaBridge.generateThumbnailsForMedia(
              processedMedia.blob ?? file,
              mediaType,
            );
            if (thumbs.length > 0) {
              thumbnailUrl = thumbs[0].dataUrl;
              filmstripThumbnails.push(
                ...thumbs.map((thumb) => ({
                  timestamp: thumb.timestamp,
                  url: thumb.dataUrl,
                })),
              );
            }
          } catch {
            // Background retry below is best-effort.
          }
        }

        let newMediaItem: MediaItem = {
          id: uuidv4(),
          name: file.name,
          type: mediaType,
          fileHandle: null,
          blob: file,
          metadata: {
            duration: options.metadata?.durationSec ?? (processedMedia.metadata.duration || 0),
            width: options.metadata?.width ?? (processedMedia.metadata.width || 0),
            height: options.metadata?.height ?? (processedMedia.metadata.height || 0),
            frameRate: options.metadata?.frameRate ?? (processedMedia.metadata.frameRate || 0),
            codec: options.metadata?.codec ?? (processedMedia.metadata.codec || ""),
            sampleRate: processedMedia.metadata.sampleRate || 0,
            channels: processedMedia.metadata.channels || 0,
            fileSize: options.metadata?.fileSize ?? file.size,
          },
          thumbnailUrl,
          waveformData: processedMedia.waveformData?.peaks || null,
          filmstripThumbnails:
            filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
          sourceFile: options.sourceFile ?? {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
          },
          ...(sourcePath ? { originalUrl: sourcePath } : {}),
          ...(options.materialSource
            ? { materialSource: options.materialSource }
            : {}),
          ...(options.versionSource ? { versionSource: options.versionSource } : {}),
        };
        let committedMediaId = newMediaItem.id;

        // The import can spend seconds probing/decoding. Re-check immediately
        // before the one canonical project write so a human edit cannot be
        // silently overwritten by an agent import.
        if (
          options.expectedRevision !== undefined &&
          options.expectedRevision !== currentMediaRevision(get, options.workspaceId)
        ) {
          revokeMediaItemBlobUrls(newMediaItem);
          return importError(
            "INVALID_PARAMS",
            `Revision mismatch: expected ${options.expectedRevision}, current ${currentMediaRevision(get, options.workspaceId)}`,
            { reason: "CONFLICT", currentRevision: currentMediaRevision(get, options.workspaceId) },
          );
        }

        if (
          get().project.id !== persistenceProjectId ||
          get().actionExecutor !== persistenceActionExecutor
        ) {
          revokeMediaItemBlobUrls(newMediaItem);
          return importError(
            "INVALID_PARAMS",
            "The active project changed while media was being decoded",
          );
        }

        // Persist bytes before publishing the project/history mutation so
        // a successful import survives reload.
        // Until the project entry is published the bytes have no other owner.
        // A reviewed cleanup plan must treat them as live during this window.
        trackUncommittedMediaBlob(newMediaItem.id, persistenceProjectId);
        try {
          const savedVersion = await saveMediaBlob(
            persistenceProjectId,
            newMediaItem.id,
            file,
            newMediaItem.metadata,
            file.name,
          );
          newMediaItem = {
            ...newMediaItem,
            contentHash: savedVersion.contentHash,
            ...(savedVersion.contentUrl ? { contentUrl: savedVersion.contentUrl } : {}),
          };
        } catch (err) {
          releaseUncommittedMediaBlob(newMediaItem.id);
          revokeMediaItemBlobUrls(newMediaItem);
          console.error("[ProjectStore] Failed to persist media blob:", err);
          return importError(
            "DECODE_ERROR",
            "Failed to persist imported media for project recovery",
          );
        }

        let discardPersistedBlob = true;
        const discardUncommittedBlob = (): void => {
          if (!discardPersistedBlob) return;
          discardPersistedBlob = false;
          releaseUncommittedMediaBlob(newMediaItem.id);
          revokeMediaItemBlobUrls(newMediaItem);
        };

        try {
          // The user may switch projects while persistence is in flight. A
          // stored blob must never be committed into a different project.
          const commitProject = get().project;
          if (
            commitProject.id !== persistenceProjectId ||
            get().actionExecutor !== persistenceActionExecutor
          ) {
            discardUncommittedBlob();
            return importError(
              "DECODE_ERROR",
              "The active project changed while media was being persisted",
            );
          }
          if (
            options.expectedRevision !== undefined &&
            options.expectedRevision !== currentMediaRevision(get, options.workspaceId)
          ) {
            discardUncommittedBlob();
            return importError(
              "INVALID_PARAMS",
              `Revision mismatch: expected ${options.expectedRevision}, current ${currentMediaRevision(get, options.workspaceId)}`,
              { reason: "CONFLICT", currentRevision: currentMediaRevision(get, options.workspaceId) },
            );
          }

          // Import decoding and persistence are asynchronous. Merge into the
          // project current at commit time so an intervening GUI edit is kept.
          let updatedProject = {
            ...commitProject,
            mediaLibrary: {
              ...commitProject.mediaLibrary,
              items: [...commitProject.mediaLibrary.items, newMediaItem],
            },
            modifiedAt: Date.now(),
          };

          if (options.atomicFollowUpActions) {
            const owner = options.historyOwner ?? "human";
            const importAction: Action = {
              type: "media/import",
              id: uuidv4(),
              timestamp: Date.now(),
              params: { file, mediaItem: newMediaItem },
            };
            const followUps = options.atomicFollowUpActions(newMediaItem.id, newMediaItem);
            const batch = await withMediaReferenceWrite(() =>
              get().executeActionBatch([importAction, ...followUps], {
                groupLabel:
                  options.historyGroupLabel ?? "Import media and add to timeline",
                historyOwner: owner,
              }),
            );
            if (!batch.result.success) {
              discardUncommittedBlob();
              return batch.result;
            }
            committedMediaId = newMediaItem.id;
            updatedProject = get().project;
            try {
              options.onAtomicBatchCommitted?.({
                tracks: batch.createdIds.tracks,
                clips: batch.createdIds.clips,
              });
            } catch (error) {
              // This callback only reports already-committed ids. Observer
              // failures cannot turn a durable project commit into a failure.
              console.warn("Compound media import observer failed", error);
            }
          } else if (options.historyOwner) {
            // Media import is not serializable as a wire action, but the
            // renderer already has the File bytes and fully-probed MediaItem.
            // Execute the canonical core action with that stable item so the
            // normal GUI undo/redo path removes and restores the same identity.
            const action: Action = {
              type: "media/import",
              id: uuidv4(),
              timestamp: Date.now(),
              // The complete item is part of the history action so redo keeps
              // the same id, metadata and file provenance. The persisted blob
              // remains under that stable id while the import is undone.
              params: { file, mediaItem: newMediaItem },
            };
            const executor = persistenceActionExecutor;
            const history = executor.getHistory();
            let actionResult: Awaited<ReturnType<typeof executor.execute>>;
            actionResult = await withMediaReferenceWrite(async () => {
              const groupId = history.beginGroup(
                options.historyGroupLabel,
                options.historyOwner,
              );
              try {
                return await executor.execute(
                  action,
                  get().project,
                  options.historyOwner,
                );
              } finally {
                history.endGroup(groupId);
              }
            });
            if (!actionResult.success) {
              discardUncommittedBlob();
              return actionResult;
            }

            if (
              get().project.id !== persistenceProjectId ||
              get().actionExecutor !== persistenceActionExecutor
            ) {
              discardUncommittedBlob();
              return importError(
                "INVALID_PARAMS",
                "The active project changed while media was being committed",
              );
            }

            committedMediaId = newMediaItem.id;
            updatedProject = {
              ...get().project,
              modifiedAt: Date.now(),
            };
          }

          // executeActionBatch already published the compound transaction.
          // The ordinary and history-only paths still publish here.
          if (!options.atomicFollowUpActions) {
            await withMediaReferenceWrite(() => set({ project: updatedProject }));
          }
          discardPersistedBlob = false;
          releaseUncommittedMediaBlob(newMediaItem.id);
        } catch (error) {
          discardUncommittedBlob();
          throw error;
        }

        if (mediaType === "video" && !thumbnailUrl) {
          setTimeout(async () => {
            try {
              const thumbs = await mediaBridge.generateThumbnailsForMedia(
                newMediaItem.blob ?? file,
                mediaType,
              );
              if (thumbs.length > 0) {
                const currentProject = get().project;
                if (
                  currentProject.id !== persistenceProjectId ||
                  get().actionExecutor !== persistenceActionExecutor
                ) return;
                const mediaIndex = currentProject.mediaLibrary.items.findIndex(
                  (m) =>
                    m.id === committedMediaId && m.blob === newMediaItem.blob,
                );
                if (mediaIndex !== -1) {
                  const updatedItems = [...currentProject.mediaLibrary.items];
                  updatedItems[mediaIndex] = {
                    ...updatedItems[mediaIndex],
                    thumbnailUrl: thumbs[0].dataUrl,
                    filmstripThumbnails: thumbs.map((t) => ({
                      timestamp: t.timestamp,
                      url: t.dataUrl,
                    })),
                  };
                  set({
                    project: {
                      ...currentProject,
                      mediaLibrary: {
                        ...currentProject.mediaLibrary,
                        items: updatedItems,
                      },
                      modifiedAt: Date.now(),
                    },
                  });
                }
              }
            } catch {
              // Background thumbnail generation is best-effort
            }
          }, 100);
        }

        return {
          success: true,
          actionId: committedMediaId,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: error instanceof MediaReplacementValidationError
              ? "INVALID_PARAMS" as const
              : "DECODE_ERROR" as const,
            message:
              error instanceof Error ? error.message : "Unknown import error",
          },
        };
      }
    },

    importMediaFromPath: async (
      sourcePath: string,
      name?: string,
      options: Omit<ImportMediaOptions, "sourcePath"> = {},
    ) => {
      if (!isAbsoluteLocalPath(sourcePath)) {
        return importError(
          "INVALID_PARAMS",
          "AI media imports require an absolute local file path",
          { path: sourcePath },
        );
      }

      const fsBridge = typeof window === "undefined" ? undefined : window.reelterminal?.fs;
      if (!fsBridge?.readFileBytes) {
        return importError(
          "DECODE_ERROR",
          "Desktop file access is unavailable in this editor",
        );
      }

      try {
        const hintedSize = options.sourceFile?.size ?? options.metadata?.fileSize;
        if (hintedSize !== undefined && hintedSize > MAX_LIVE_MEDIA_IMPORT_BYTES) {
          return liveMediaSizeError(sourcePath, hintedSize);
        }
        const bytes = await fsBridge.readFileBytes(
          sourcePath,
          MAX_LIVE_MEDIA_IMPORT_BYTES,
        );
        if (bytes.byteLength > MAX_LIVE_MEDIA_IMPORT_BYTES) {
          return liveMediaSizeError(sourcePath, bytes.byteLength);
        }
        const fileName = name?.trim() || pathBasename(sourcePath);
        const file = new File([bytes], fileName, {
          type: mediaMimeType(sourcePath),
          // A path import cannot obtain a portable FileSystemFileHandle. Keep
          // the browser File stable while originalUrl records the source path.
          lastModified: Date.now(),
        });
        return await get().importMedia(file, {
          projectId: options.projectId,
          workspaceId: options.workspaceId,
          sourcePath,
          expectedRevision: options.expectedRevision,
          type: options.type,
          metadata: options.metadata,
          sourceFile: options.sourceFile,
          historyOwner: options.historyOwner,
          historyGroupLabel: options.historyGroupLabel,
          materialSource: options.materialSource,
          atomicFollowUpActions: options.atomicFollowUpActions,
          onAtomicBatchCommitted: options.onAtomicBatchCommitted,
        });
      } catch (error) {
        return importError(
          "DECODE_ERROR",
          error instanceof Error ? error.message : "Failed to read local media file",
          { path: sourcePath },
        );
      }
    },

    deleteMedia: async (mediaId: string) => {
      ensureProjectMediaGc(get().actionHistory, () => get().project);
      const { project, actionExecutor } = get();
      const action: Action = {
        type: "media/delete",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { mediaId },
      };
      const result = await withMediaReferenceWrite(async () => {
        if (get().project !== project || get().actionExecutor !== actionExecutor) {
          return importError("INVALID_PARAMS", "Project changed before media could be removed", {
            reason: "CONFLICT",
            currentRevision: get().projectRevision,
          });
        }
        const actionResult = await actionExecutor.execute(action, project);
        if (actionResult.success) set({ project: { ...project }, ...invalidateRedoBranches() });
        return actionResult;
      });
      return result;
    },

    replaceMediaAsset: async (
      mediaId: string,
      file: File,
      sourceFolder?: string,
      context?: MediaOperationContext,
    ) => {
      const contextError = mediaContextError(context, get);
      if (contextError) return contextError;
      const project = get().project;
      const projectId = context?.projectId ?? project.id;
      const workspaceId = context?.workspaceId ?? get().workspaceId;
      const expectedRevision = context?.expectedRevision ?? currentMediaRevision(get, workspaceId);
      const oldItem = project.mediaLibrary.items.find((item) => item.id === mediaId);
      if (!oldItem) return importError("INVALID_PARAMS", "Media item does not exist");

      const sourcePath = desktopFileSourcePath(file);
      const result = await get().importMedia(file, {
        projectId,
        workspaceId: workspaceId ?? undefined,
        expectedRevision,
        ...(sourcePath ? { sourcePath } : {}),
        sourceFile: {
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          ...(sourceFolder ? { folder: sourceFolder } : {}),
        },
        versionSource: {
          supersedesMediaIdInProject: mediaId,
          ...(oldItem.materialSource ? { supersedesMaterialId: oldItem.materialSource.materialId } : {}),
          replacedAt: new Date().toISOString(),
          replacedBy: "user",
        },
        historyGroupLabel: "Replace media version",
        atomicFollowUpActions: (replacementId, replacementItem) =>
          buildRepointActions(project, mediaId, replacementId, replacementItem.metadata.duration),
      });
      return result;
    },

    adoptMediaCandidate: async (
      sourceMediaId: string,
      replacementMediaId: string,
      context?: MediaOperationContext,
    ) => {
      const contextError = mediaContextError(context, get);
      if (contextError) return contextError;
      if (sourceMediaId === replacementMediaId) {
        return importError("INVALID_PARAMS", "Choose a different media version to adopt");
      }
      const { project, actionExecutor } = get();
      const source = project.mediaLibrary.items.find((item) => item.id === sourceMediaId);
      const candidate = project.mediaLibrary.items.find((item) => item.id === replacementMediaId);
      if (!source || !candidate) return importError("INVALID_PARAMS", "Source or candidate media does not exist");
      if (source.type !== candidate.type) return importError("INVALID_PARAMS", "Media type does not match the source");

      let actions: Action[];
      try {
        actions = buildRepointActions(project, sourceMediaId, replacementMediaId, candidate.metadata.duration);
      } catch (error) {
        return importError("INVALID_PARAMS", error instanceof Error ? error.message : "Invalid replacement range");
      }
      if (actions.length === 0) return importError("INVALID_PARAMS", "No timeline clips reference the source media");
      if (
        context &&
        (get().project !== project || get().actionExecutor !== actionExecutor ||
          context.expectedRevision !== get().workspaceRevision)
      ) {
        return importError("INVALID_PARAMS", "Workspace changed before the candidate could be adopted", {
          reason: "CONFLICT",
          currentRevision: get().projectRevision,
        });
      }
      const batch = await withMediaReferenceWrite(() => {
        if (
          get().project !== project || get().actionExecutor !== actionExecutor ||
          (context && context.expectedRevision !== get().workspaceRevision)
        ) {
          return {
            result: importError("INVALID_PARAMS", "Workspace changed before the candidate could be adopted", {
              reason: "CONFLICT",
              currentRevision: get().projectRevision,
            }),
          };
        }
        return get().executeActionBatch(actions, {
          groupLabel: "Adopt media version",
          historyOwner: "human",
        });
      });
      return batch.result;
    },

    relinkMediaAsset: async (
      mediaId: string,
      file: File,
      sourceFolder?: string,
      context?: MediaOperationContext,
    ) => {
      const contextError = mediaContextError(context, get);
      if (contextError) return contextError;
      const { project, actionExecutor } = get();
      const oldItem = project.mediaLibrary.items.find((item) => item.id === mediaId);
      if (!oldItem) return importError("INVALID_PARAMS", "Media item does not exist");
      if (oldItem.blob instanceof Blob && oldItem.isPlaceholder !== true) {
        return importError("INVALID_PARAMS", "Only missing media can be relinked; use Replace to create a new version");
      }

      try {
        const storedRecord = await loadMediaRecord(mediaId);
        const persistedBlob = oldItem.blob instanceof Blob
          ? oldItem.blob
          : storedRecord?.blob ?? await loadMediaBlob(mediaId, project.id);
        const expectedHash = oldItem.contentHash ?? storedRecord?.contentHash ??
          (persistedBlob ? await hashMediaBlob(persistedBlob) : undefined);
        if (!expectedHash) {
          return importError("INVALID_PARAMS", "This legacy media has no saved content to verify; use Replace to create a new version");
        }
        const replacementHash = await hashMediaBlob(file);
        if (replacementHash !== expectedHash) {
          return importError("INVALID_PARAMS", "Selected file bytes do not match this media version");
        }

        const sourcePath = desktopFileSourcePath(file);
        const saved = await saveMediaBlob(project.id, mediaId, file, oldItem.metadata, file.name);
        if (
          get().project !== project || get().actionExecutor !== actionExecutor ||
          (context && context.expectedRevision !== get().workspaceRevision) ||
          get().project.mediaLibrary.items.find((item) => item.id === mediaId) !== oldItem
        ) {
          return importError("INVALID_PARAMS", "Workspace or media changed during relinking", {
            reason: "CONFLICT",
            currentRevision: get().projectRevision,
          });
        }

        const originalUrl = sourcePath ?? oldItem.originalUrl;
        if (originalUrl) {
          const action: Action = {
            type: "media/relinkSource",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              mediaId,
              originalUrl,
              sourceFile: {
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
              },
            },
          };
          const result = await withMediaReferenceWrite(async () => {
            if (context && context.expectedRevision !== get().workspaceRevision) {
              return importError("INVALID_PARAMS", "Workspace changed before relinking", {
                reason: "CONFLICT",
                currentRevision: get().projectRevision,
              });
            }
            const linked = await actionExecutor.execute(action, get().project);
            if (!linked.success) return linked;
            const latestProject = get().project;
            set({
              ...invalidateRedoBranches(),
              project: {
                ...latestProject,
                mediaLibrary: {
                  ...latestProject.mediaLibrary,
                  items: latestProject.mediaLibrary.items.map((item) => item.id === mediaId
                    ? {
                        ...item,
                        blob: file,
                        fileHandle: null,
                        isPlaceholder: false,
                        contentHash: saved.contentHash,
                        ...(saved.contentUrl ? { contentUrl: saved.contentUrl } : {}),
                        sourceFile: {
                          name: file.name,
                          size: file.size,
                          lastModified: file.lastModified,
                          ...(sourceFolder ? { folder: sourceFolder } : {}),
                        },
                      }
                    : item),
                },
                modifiedAt: Date.now(),
              },
            });
            return linked;
          });
          return result;
        }

        await withMediaReferenceWrite(() => set({
          project: {
            ...get().project,
            mediaLibrary: {
              ...get().project.mediaLibrary,
              items: get().project.mediaLibrary.items.map((item) => item.id === mediaId
                ? {
                    ...item,
                    blob: file,
                    fileHandle: null,
                    isPlaceholder: false,
                    contentHash: saved.contentHash,
                    ...(saved.contentUrl ? { contentUrl: saved.contentUrl } : {}),
                    sourceFile: {
                      name: file.name,
                      size: file.size,
                      lastModified: file.lastModified,
                      ...(sourceFolder ? { folder: sourceFolder } : {}),
                    },
                  }
                : item),
            },
            modifiedAt: Date.now(),
          },
        }));
        return { success: true };
      } catch (error) {
        return importError(
          "DECODE_ERROR",
          error instanceof Error ? error.message : "Failed to relink media",
        );
      }
    },
    renameMedia: async (mediaId: string, name: string) => {
      const { project, actionExecutor } = get();
      const action: Action = {
        type: "media/rename",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { mediaId, name },
      };
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project }, ...invalidateRedoBranches() });
      }
      return result;
    },

    getMediaItem: (mediaId: string) =>
      get().project.mediaLibrary.items.find((item) => item.id === mediaId),
  };
}
