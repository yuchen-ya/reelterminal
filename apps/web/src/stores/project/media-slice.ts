import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, MediaItem } from "@reelterminal/core";
import type { ProjectState } from "../project-store";
import { getMediaBridge, initializeMediaBridge } from "../../bridges/media-bridge";
import { saveMediaBlob, deleteMediaBlob } from "../../services/media-storage";
import {
  ensureProjectMediaGc,
  reconcileProjectMediaBytes,
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
  | "renameMedia"
  | "getMediaItem"
>;

/** Optional provenance/coordination data for an import. */
export interface ImportMediaOptions {
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
  /**
   * Renderer-only transaction hook used by compound import flows such as a
   * material segment attach. The returned synchronous core actions are
   * validated with media/import on one isolated draft and published as one
   * project commit + one undo unit. A failed action discards the newly
   * persisted blob and leaves project/history untouched.
   */
  readonly atomicFollowUpActions?: (mediaId: string) => readonly Action[];
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
    typeof window === "undefined" ? undefined : window.openreel?.fs?.getPathForFile;
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

/** Keep one IPC read bounded even when the host-side probe allowed a larger file. */
const MAX_LIVE_MEDIA_IMPORT_BYTES = 256 * 1024 * 1024;

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

export function createMediaSlice(set: Set, get: Get): MediaSlice {
  return {
    importMedia: async (file: File, options: ImportMediaOptions = {}) => {
      ensureProjectMediaGc(get().actionHistory, () => get().project);
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
        options.expectedRevision !== get().projectRevision
      ) {
        return importError(
          "INVALID_PARAMS",
          `Project revision mismatch: expected ${options.expectedRevision}, current ${get().projectRevision}`,
          { reason: "CONFLICT", currentRevision: get().projectRevision },
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

        const newMediaItem: MediaItem = {
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
        };
        let committedMediaId = newMediaItem.id;

        // The import can spend seconds probing/decoding. Re-check immediately
        // before the one canonical project write so a human edit cannot be
        // silently overwritten by an agent import.
        if (
          options.expectedRevision !== undefined &&
          options.expectedRevision !== get().projectRevision
        ) {
          return importError(
            "INVALID_PARAMS",
            `Project revision mismatch: expected ${options.expectedRevision}, current ${get().projectRevision}`,
            { reason: "CONFLICT", currentRevision: get().projectRevision },
          );
        }

        // Persistence is part of the import transaction. Saving after the
        // canonical commit used to report success even when IndexedDB failed,
        // leaving a media card that could not survive reload. Persist first;
        // only publish the project/history mutation after durable bytes exist.
        const persistenceProjectId = get().project.id;
        // Until the project entry is published the bytes have no other owner.
        // Concurrent reclamation (eviction, project switch, load sweep) must
        // treat them as live during this window.
        trackUncommittedMediaBlob(newMediaItem.id);
        try {
          await saveMediaBlob(
            persistenceProjectId,
            newMediaItem.id,
            file,
            newMediaItem.metadata,
          );
        } catch (err) {
          releaseUncommittedMediaBlob(newMediaItem.id);
          console.error("[ProjectStore] Failed to persist media blob:", err);
          return importError(
            "DECODE_ERROR",
            "Failed to persist imported media for project recovery",
          );
        }

        let discardPersistedBlob = true;
        const discardUncommittedBlob = async (): Promise<void> => {
          if (!discardPersistedBlob) return;
          discardPersistedBlob = false;
          releaseUncommittedMediaBlob(newMediaItem.id);
          await deleteMediaBlob(newMediaItem.id).catch((error) =>
            console.warn("[ProjectStore] Failed to discard uncommitted media blob:", error),
          );
        };

        try {
          // The user may switch projects while persistence is in flight. A
          // stored blob must never be committed into a different project.
          const commitProject = get().project;
          if (commitProject.id !== persistenceProjectId) {
            await discardUncommittedBlob();
            return importError(
              "DECODE_ERROR",
              "The active project changed while media was being persisted",
            );
          }
          if (
            options.expectedRevision !== undefined &&
            options.expectedRevision !== get().projectRevision
          ) {
            await discardUncommittedBlob();
            return importError(
              "INVALID_PARAMS",
              `Project revision mismatch: expected ${options.expectedRevision}, current ${get().projectRevision}`,
              { reason: "CONFLICT", currentRevision: get().projectRevision },
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
            const followUps = options.atomicFollowUpActions(newMediaItem.id);
            const batch = get().executeActionBatch(
              [importAction, ...followUps],
              {
                groupLabel:
                  options.historyGroupLabel ?? "Import media and add to timeline",
                historyOwner: owner,
              },
            );
            if (!batch.result.success) {
              await discardUncommittedBlob();
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
            const executor = get().actionExecutor;
            const history = executor.getHistory();
            const groupId = history.beginGroup(
              options.historyGroupLabel,
              options.historyOwner,
            );
            let actionResult: Awaited<ReturnType<typeof executor.execute>>;
            try {
              actionResult = await executor.execute(
                action,
                get().project,
                options.historyOwner,
              );
            } finally {
              history.endGroup(groupId);
            }
            if (!actionResult.success) {
              await discardUncommittedBlob();
              return actionResult;
            }

            committedMediaId = newMediaItem.id;
            updatedProject = {
              ...get().project,
              modifiedAt: Date.now(),
            };
          }

          // executeActionBatch already published the compound transaction.
          // The ordinary and history-only paths still publish here.
          if (!options.atomicFollowUpActions) set({ project: updatedProject });
          discardPersistedBlob = false;
          releaseUncommittedMediaBlob(newMediaItem.id);
        } catch (error) {
          await discardUncommittedBlob();
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
                const mediaIndex = currentProject.mediaLibrary.items.findIndex(
                  (m) => m.id === committedMediaId,
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
            code: "DECODE_ERROR" as const,
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

      const fsBridge = typeof window === "undefined" ? undefined : window.openreel?.fs;
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
      const result = await actionExecutor.execute(action, project);
      if (result.success) {
        set({ project: { ...project } });
        // The delete entry in the undo history can still restore the item, so
        // the stored bytes are kept until no history entry references them
        // anymore. Reconciliation reclaims them once the entry is evicted,
        // history is cleared, or the project is switched.
        void reconcileProjectMediaBytes(project, actionExecutor.getHistory());
      }
      return result;
    },

    replaceMediaAsset: async (
      mediaId: string,
      file: File,
      sourceFolder?: string,
    ) => {
      const { project } = get();

      try {
        const mediaBridge = getMediaBridge();
        if (!mediaBridge.isInitialized()) {
          await initializeMediaBridge();
        }

        const importResult = await mediaBridge.importFile(file, true);

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

        const mediaType = processedMedia.metadata.hasVideo
          ? "video"
          : processedMedia.metadata.hasAudio
            ? "audio"
            : "image";

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

        const updatedItem: MediaItem = {
          id: mediaId,
          name: file.name,
          type: mediaType,
          fileHandle: null,
          blob: file,
          metadata: {
            duration: processedMedia.metadata.duration || 0,
            width: processedMedia.metadata.width || 0,
            height: processedMedia.metadata.height || 0,
            frameRate: processedMedia.metadata.frameRate || 0,
            codec: processedMedia.metadata.codec || "",
            sampleRate: processedMedia.metadata.sampleRate || 0,
            channels: processedMedia.metadata.channels || 0,
            fileSize: file.size,
          },
          thumbnailUrl,
          waveformData: processedMedia.waveformData?.peaks || null,
          filmstripThumbnails:
            filmstripThumbnails.length > 0 ? filmstripThumbnails : undefined,
          isPlaceholder: false,
          sourceFile: {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            folder: sourceFolder,
          },
        };

        const updatedItems = project.mediaLibrary.items.map((item) =>
          item.id === mediaId ? updatedItem : item,
        );

        // Persistence is part of the replacement transaction, with the same
        // ordering as importMedia: durable bytes for this id must exist before
        // the project entry is published. Saving only after the commit used to
        // leave the previous blob in IndexedDB, so a save/reload silently
        // restored the old content while the entry named the new file.
        try {
          await saveMediaBlob(project.id, mediaId, file, updatedItem.metadata);
        } catch (err) {
          console.error("[ProjectStore] Failed to persist replaced media blob:", err);
          return {
            success: false,
            error: {
              code: "DECODE_ERROR" as const,
              message: "Failed to persist replaced media for project recovery",
            },
          };
        }

        set({
          project: {
            ...project,
            mediaLibrary: { items: updatedItems },
            modifiedAt: Date.now(),
          },
        });

        if (updatedItem.type === "video" && !updatedItem.thumbnailUrl) {
          setTimeout(async () => {
            try {
              const thumbs = await mediaBridge.generateThumbnailsForMedia(
                updatedItem.blob ?? file,
                updatedItem.type,
              );
              if (thumbs.length > 0) {
                const currentProject = get().project;
                const updatedItemsWithThumbs =
                  currentProject.mediaLibrary.items.map((item) =>
                    item.id === mediaId
                      ? {
                          ...item,
                          thumbnailUrl: thumbs[0].dataUrl,
                          filmstripThumbnails: thumbs.map((thumb) => ({
                            timestamp: thumb.timestamp,
                            url: thumb.dataUrl,
                          })),
                        }
                      : item,
                  );
                set({
                  project: {
                    ...currentProject,
                    mediaLibrary: { items: updatedItemsWithThumbs },
                    modifiedAt: Date.now(),
                  },
                });
              }
            } catch {
              // Background thumbnail generation is best-effort
            }
          }, 100);
        }

        return { success: true, actionId: uuidv4() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: "DECODE_ERROR" as const,
            message:
              error instanceof Error ? error.message : "Unknown import error",
          },
        };
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
        set({ project: { ...project } });
      }
      return result;
    },

    getMediaItem: (mediaId: string) =>
      get().project.mediaLibrary.items.find((item) => item.id === mediaId),
  };
}
