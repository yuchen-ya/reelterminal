import { describe, expect, it } from "vitest";
import type { MediaItem } from "@openreel/core";
import { restoreMediaItem } from "./media-recovery";

/**
 * What JSON.parse of an auto-save snapshot yields for a persisted Blob:
 * JSON.stringify cannot represent Blob and serializes it to `{}`, so a
 * restored item carries a truthy fake that must never reach the playback or
 * export pipeline (R1 / C04-D1).
 */
const SNAPSHOT_FAKE_BLOB = {} as Blob;

const THUMB_DATA_URL = "data:image/jpeg;base64,ZmFrZQ==";

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "m1",
    name: "clip.mp4",
    type: "video",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 3,
      width: 640,
      height: 360,
      frameRate: 30,
      codec: "h264",
      sampleRate: 48000,
      channels: 2,
      fileSize: 1024,
    },
    thumbnailUrl: THUMB_DATA_URL,
    waveformData: null,
    ...overrides,
  };
}

describe("restoreMediaItem", () => {
  it("marks an item as missing when the media store record is absent and the snapshot blob is the deserialized fake {}", async () => {
    const item = makeItem({ blob: SNAPSHOT_FAKE_BLOB });

    const restored = await restoreMediaItem(item, undefined);

    expect(restored.isPlaceholder).toBe(true);
    expect(restored.blob).toBeNull();
    // Non-blob fields survive so the placeholder card still renders metadata.
    expect(restored.name).toBe("clip.mp4");
    expect(restored.thumbnailUrl).toBe(THUMB_DATA_URL);
  });

  it("degrades to missing instead of throwing when the fake {} blob also has no usable thumbnail", async () => {
    const item = makeItem({ blob: SNAPSHOT_FAKE_BLOB, thumbnailUrl: null });

    const restored = await restoreMediaItem(item, undefined);

    expect(restored.isPlaceholder).toBe(true);
    expect(restored.blob).toBeNull();
  });

  it("keeps real bytes from the media store on the success path", async () => {
    const stored = new Blob(["real-bytes"]);
    const item = makeItem({ blob: SNAPSHOT_FAKE_BLOB });

    const restored = await restoreMediaItem(item, stored);

    expect(restored.blob).toBe(stored);
    expect(restored.isPlaceholder).toBeUndefined();
    expect(restored.thumbnailUrl).toBe(THUMB_DATA_URL);
  });

  it("still falls back to a real in-memory blob when the media store has no record", async () => {
    const real = new Blob(["in-memory"]);
    const item = makeItem({ blob: real });

    const restored = await restoreMediaItem(item, undefined);

    expect(restored.blob).toBe(real);
    expect(restored.isPlaceholder).toBeUndefined();
  });
});
