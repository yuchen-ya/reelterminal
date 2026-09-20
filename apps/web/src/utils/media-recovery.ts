import type { MediaItem } from "@reelterminal/core";

export async function generateThumbnailFromBlob(
  blob: Blob,
  type: "video" | "audio" | "image",
): Promise<string | null> {
  if (type === "audio") {
    return null;
  }

  if (type === "image") {
    return URL.createObjectURL(blob);
  }

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const cleanup = () => {
      URL.revokeObjectURL(video.src);
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
                resolve(URL.createObjectURL(thumbBlob));
              } else {
                resolve(null);
              }
            },
            "image/jpeg",
            0.7,
          );
        } else {
          cleanup();
          resolve(null);
        }
      } catch {
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => {
      cleanup();
      resolve(null);
    };

    setTimeout(() => {
      cleanup();
      resolve(null);
    }, 5000);

    video.src = URL.createObjectURL(blob);
  });
}

export async function restoreMediaItem(
  item: MediaItem,
  storedBlob: Blob | undefined,
): Promise<MediaItem> {
  // An auto-save snapshot stores the project as JSON, so a persisted Blob
  // deserializes back as a truthy `{}`. Only a real Blob counts as media
  // bytes; anything else (the fake snapshot object, null, undefined) is a
  // missing-media condition and must not reach playback or export.
  const blob =
    storedBlob instanceof Blob ? storedBlob : item.blob instanceof Blob ? item.blob : null;

  if (!blob) {
    // Same missing-asset state the JSON import path sets
    // (ProjectSerializer.importFromJson): AssetsPanel renders these items
    // with the placeholder UI and counts them as missing assets.
    return {
      ...item,
      blob: null,
      isPlaceholder: true,
    };
  }

  let thumbnailUrl = item.thumbnailUrl;

  if (!thumbnailUrl || thumbnailUrl.startsWith("blob:")) {
    thumbnailUrl = await generateThumbnailFromBlob(blob, item.type);
  }

  return {
    ...item,
    blob,
    thumbnailUrl,
    filmstripThumbnails: undefined,
  };
}
