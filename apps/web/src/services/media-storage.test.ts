/**
 * @vitest-environment node
 */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { saveMediaBlob, loadMediaRecord, getMediaIdsByProject } from "./media-storage";

beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

const previousWindow = typeof window === "undefined" ? undefined : window;

afterEach(() => {
  vi.stubGlobal("window", previousWindow);
});

const metadata = {
  duration: 1,
  width: 640,
  height: 360,
  frameRate: 30,
  codec: "h264",
  sampleRate: 0,
  channels: 0,
  fileSize: 12,
};

describe("immutable media storage", () => {
  it("reuses one content id across projects without overwriting or losing either owner", async () => {
    const mediaId = `shared-${crypto.randomUUID()}`;
    const projectA = `project-a-${crypto.randomUUID()}`;
    const projectB = `project-b-${crypto.randomUUID()}`;
    const original = new Blob(["same-content"], { type: "video/mp4" });

    const first = await saveMediaBlob(projectA, mediaId, original, metadata, "clip.mp4");
    const second = await saveMediaBlob(projectB, mediaId, original, metadata, "clip.mp4");

    expect(first.contentHash).toBe(second.contentHash);
    expect(second.created).toBe(false);
    expect(await getMediaIdsByProject(projectA)).toContain(mediaId);
    expect(await getMediaIdsByProject(projectB)).toContain(mediaId);
    expect(await loadMediaRecord(mediaId)).toMatchObject({
      id: mediaId,
      projectId: projectA,
      projectIds: expect.arrayContaining([projectA, projectB]),
      contentHash: first.contentHash,
    });
  });

  it("rejects changed bytes for an existing content id", async () => {
    const mediaId = `immutable-${crypto.randomUUID()}`;
    const projectId = `project-${crypto.randomUUID()}`;
    await saveMediaBlob(projectId, mediaId, new Blob(["version-one"]), metadata);

    await expect(saveMediaBlob(
      projectId,
      mediaId,
      new Blob(["version-two"]),
      metadata,
    )).rejects.toThrow(/immutable/i);
    expect(await getMediaIdsByProject(projectId)).toContain(mediaId);
  });

  it("stores generic image bytes with a browser-decodable controlled-file extension", async () => {
    let expectedHash = "";
    const beginWrite = vi.fn(async (input: { extension: string; expectedHash: string }) => {
      expectedHash = input.expectedHash;
      return "session";
    });
    const mediaStore = {
      getVersion: vi.fn(async () => null),
      beginWrite,
      writeChunk: vi.fn(async () => undefined),
      commitWrite: vi.fn(async () => ({
        path: "C:/app/controlled-media/project/media.png",
        contentHash: expectedHash,
        created: true,
      })),
      abortWrite: vi.fn(async () => undefined),
    };
    vi.stubGlobal("window", {
      reelterminal: { platform: "desktop", mediaStore },
    } as unknown as Window);

    const projectId = `project-${crypto.randomUUID()}`;
    const mediaId = `image-${crypto.randomUUID()}`;
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await saveMediaBlob(
      projectId,
      mediaId,
      new Blob([pngHeader], { type: "application/octet-stream" }),
      metadata,
      "image.bin",
    );

    expect(beginWrite).toHaveBeenCalledWith(expect.objectContaining({ extension: "png" }));
    expect(result.contentUrl).toBe("C:/app/controlled-media/project/media.png");
  });
});
