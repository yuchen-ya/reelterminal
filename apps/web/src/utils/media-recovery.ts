import type { MediaItem } from "@reelterminal/core";
import {
  beginPerfOperation,
  endPerfOperation,
  failPerfOperation,
  markPerfOperation,
  type PerfOperation,
} from "@reelterminal/core";

export async function generateThumbnailFromBlob(
  blob: Blob,
  type: "video" | "audio" | "image",
  parent?: PerfOperation,
): Promise<string | null> {
  const operation = beginPerfOperation("media.thumbnail.generate", parent);
  if (operation) {
    markPerfOperation(operation, "media.thumbnail.generate_started", {
      media_bytes: blob.size,
      is_video: type === "video",
      is_image: type === "image",
    });
  }
  if (type === "audio") {
    endPerfOperation(operation, "ok", operation ? { thumbnail_count: 0 } : undefined);
    return null;
  }

  if (type === "image") {
    try {
      const url = URL.createObjectURL(blob);
      if (operation) {
        markPerfOperation(operation, "media.thumbnail.url_created", {
          owner_transferred: true,
        });
      }
      endPerfOperation(operation, "ok", operation ? { thumbnail_count: 1 } : undefined);
      return url;
    } catch (error) {
      failPerfOperation(operation, error);
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    let operationEnded = false;
    let sourceUrlRevocationMarked = false;
    const finishOperation = (
      outcome: "ok" | "error" | "timeout",
      thumbnailCount: number,
    ) => {
      if (operationEnded) return;
      operationEnded = true;
      endPerfOperation(
        operation,
        outcome,
        operation ? { thumbnail_count: thumbnailCount } : undefined,
      );
    };
    let video: HTMLVideoElement;
    try {
      video = document.createElement("video");
    } catch (error) {
      failPerfOperation(operation, error);
      reject(error);
      return;
    }
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const cleanup = () => {
      URL.revokeObjectURL(video.src);
      if (!sourceUrlRevocationMarked) {
        sourceUrlRevocationMarked = true;
        markPerfOperation(operation, "media.thumbnail.source_url_revoked");
      }
      video.remove();
    };

    video.onloadeddata = () => {
      video.currentTime = 0.1;
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.min(video.videoWidth, 320);
        canvas.height = Math.min(
          video.videoHeight,
          (320 / video.videoWidth) * video.videoHeight,
        );

        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (thumbBlob) => {
              cleanup();
              if (thumbBlob) {
                const thumbnailUrl = URL.createObjectURL(thumbBlob);
                if (operation) {
                  markPerfOperation(operation, "media.thumbnail.url_created", {
                    owner_transferred: true,
                    thumbnail_bytes: thumbBlob.size,
                  });
                }
                finishOperation("ok", 1);
                resolve(thumbnailUrl);
              } else {
                finishOperation("ok", 0);
                resolve(null);
              }
            },
            "image/jpeg",
            0.7,
          );
        } else {
          cleanup();
          finishOperation("ok", 0);
          resolve(null);
        }
      } catch {
        cleanup();
        finishOperation("error", 0);
        resolve(null);
      }
    };

    video.onerror = () => {
      cleanup();
      finishOperation("error", 0);
      resolve(null);
    };

    setTimeout(() => {
      cleanup();
      finishOperation("timeout", 0);
      resolve(null);
    }, 5000);

    try {
      video.src = URL.createObjectURL(blob);
    } catch (error) {
      failPerfOperation(operation, error);
      reject(error);
      return;
    }
    if (operation) {
      markPerfOperation(operation, "media.thumbnail.source_url_created", {
        media_bytes: blob.size,
      });
    }
  });
}

export async function restoreMediaItem(
  item: MediaItem,
  storedBlob: Blob | undefined,
): Promise<MediaItem> {
  const operation = beginPerfOperation("media.restore_item");
  if (operation) {
    markPerfOperation(operation, "media.restore_item_started", {
      snapshot_blob_present: item.blob instanceof Blob,
      stored_blob_present: storedBlob instanceof Blob,
    });
  }
  try {
    // An auto-save snapshot stores the project as JSON, so a persisted Blob
    // deserializes back as a truthy `{}`. Only a real Blob counts as media
    // bytes; anything else (the fake snapshot object, null, undefined) is a
    // missing-media condition and must not reach playback or export.
    const blob =
      storedBlob instanceof Blob
        ? storedBlob
        : item.blob instanceof Blob
          ? item.blob
          : null;

    if (!blob) {
      // Same missing-asset state the JSON import path sets
      // (ProjectSerializer.importFromJson): AssetsPanel renders these items
      // with the placeholder UI and counts them as missing assets.
      const placeholder = {
        ...item,
        blob: null,
        isPlaceholder: true,
      };
      endPerfOperation(operation, "ok", operation ? { media_found: false } : undefined);
      return placeholder;
    }

    let thumbnailUrl = item.thumbnailUrl;

    if (!thumbnailUrl || thumbnailUrl.startsWith("blob:")) {
      thumbnailUrl = await generateThumbnailFromBlob(blob, item.type, operation);
    }

    const restored = {
      ...item,
      blob,
      thumbnailUrl,
      filmstripThumbnails: undefined,
    };
    endPerfOperation(
      operation,
      "ok",
      operation
        ? { media_found: true, thumbnail_available: thumbnailUrl !== null }
        : undefined,
    );
    return restored;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}
