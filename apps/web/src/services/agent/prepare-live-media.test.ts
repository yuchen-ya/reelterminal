import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashMediaBytes, type Action, type MediaItem, type Project } from "@reelterminal/core";

const storage = vi.hoisted(() => ({ save: vi.fn(), loadRecord: vi.fn(), loadBlob: vi.fn() }));
const gc = vi.hoisted(() => ({
  track: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../media-storage", () => ({
  saveMediaBlob: storage.save,
  loadMediaRecord: storage.loadRecord,
  loadMediaBlob: storage.loadBlob,
}));
vi.mock("../project-media-gc", () => ({
  trackUncommittedMediaBlob: gc.track,
  releaseUncommittedMediaBlob: gc.release,
}));

import { prepareLiveMedia } from "./prepare-live-media";

const project = { id: "p", mediaLibrary: { items: [] } } as unknown as Project;
const media = (id: string) => ({
  id,
  name: "shot.mp4",
  type: "video",
  originalUrl: "/root/shot.mp4",
  metadata: { fileSize: 3 },
}) as MediaItem;
const action = (id: string) => ({
  type: "media/import",
  id: `a-${id}`,
  timestamp: 0,
  params: { mediaItem: media(id) },
}) as Action;

afterEach(() => {
  vi.resetAllMocks();
  delete (window as { reelterminal?: unknown }).reelterminal;
});

beforeEach(() => {
  storage.save.mockResolvedValue({ contentHash: "a".repeat(64), contentUrl: "/controlled/p/new.mp4", created: true });
  storage.loadRecord.mockResolvedValue(null);
  storage.loadBlob.mockResolvedValue(null);
});

describe("live replacement bytes", () => {
  it("hydrates, registers pending bytes, then releases them after the canonical commit", async () => {
    const readFileBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });
    const input = action("new");
    const prepared = await prepareLiveMedia([input], project, {
      projectId: "p",
      workspaceId: "w",
      expectedRevision: 4,
    });
    const item = (prepared.actions[0].params as { mediaItem: MediaItem }).mediaItem;
    expect(item.blob?.size).toBe(3);
    expect(item.contentHash).toBe("a".repeat(64));
    expect(item.contentUrl).toBe("/controlled/p/new.mp4");
    expect((input.params as { mediaItem: MediaItem }).mediaItem.blob).toBeUndefined();
    expect(storage.save).toHaveBeenCalledWith("p", "new", item.blob, item.metadata, item.name);
    expect(gc.track).toHaveBeenCalledWith("new", "p");
    expect(project.mediaLibrary.items).toHaveLength(0);

    prepared.commit();
    expect(gc.release).toHaveBeenCalledWith("new");
    await prepared.discard();
  });

  it("reads a controlled version before the mutable source path", async () => {
    const readFileBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });
    const candidate = {
      ...media("candidate"),
      contentUrl: "/controlled/p/candidate.mp4",
    } as MediaItem;
    const prepared = await prepareLiveMedia([{
      ...action("candidate"),
      params: { mediaItem: candidate },
    }], project, { projectId: "p", workspaceId: "w", expectedRevision: 0 });

    expect(readFileBytes).toHaveBeenCalledWith("/controlled/p/candidate.mp4", 256 * 1024 * 1024);
    await prepared.discard();
  });

  it("retains the actual image MIME when staging a newly imported image", async () => {
    const readFileBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });
    const image = { ...media("new-image"), name: "poster.png", type: "image" } as MediaItem;
    const prepared = await prepareLiveMedia([{
      ...action("new-image"),
      params: { mediaItem: image },
    }], project, { projectId: "p", workspaceId: "w", expectedRevision: 0 });

    const item = (prepared.actions[0].params as { mediaItem: MediaItem }).mediaItem;
    expect(item.blob?.type).toBe("image/png");
    await prepared.discard();
  });

  it("rejects an overwritten relink path even when the controlled version exists", async () => {
    const originalBytes = new Uint8Array([1, 2, 3]);
    const wrongBytes = new Uint8Array([8, 9, 10]);
    const item = {
      ...media("saved-version"),
      contentUrl: "/controlled/p/saved-version.mp4",
      contentHash: await hashMediaBytes(originalBytes),
    } as MediaItem;
    const relink: Action = {
      type: "media/relinkSource",
      id: "relink-action",
      timestamp: 0,
      params: { mediaId: item.id, originalUrl: "/source/overwritten.mp4" },
    };
    const readFileBytes = vi.fn().mockResolvedValue(wrongBytes.buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });

    await expect(prepareLiveMedia(
      [relink],
      { ...project, mediaLibrary: { items: [item] } } as Project,
    )).rejects.toThrow("Selected file bytes do not match this media version");
    expect(readFileBytes).toHaveBeenCalledWith("/source/overwritten.mp4", 256 * 1024 * 1024);
    expect(storage.save).not.toHaveBeenCalled();
    expect(gc.track).not.toHaveBeenCalled();
  });

  it("accepts only a relink source whose bytes match the saved content hash", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const item = {
      ...media("saved-version"),
      contentUrl: "/controlled/p/saved-version.mp4",
      contentHash: await hashMediaBytes(bytes),
    } as MediaItem;
    const relink: Action = {
      type: "media/relinkSource",
      id: "relink-action",
      timestamp: 0,
      params: { mediaId: item.id, originalUrl: "/source/matching.mp4" },
    };
    const readFileBytes = vi.fn().mockResolvedValue(bytes.buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });

    const prepared = await prepareLiveMedia(
      [relink],
      { ...project, mediaLibrary: { items: [item] } } as Project,
    );
    expect(prepared.actions).toEqual([relink]);
    expect(readFileBytes).toHaveBeenCalledWith("/source/matching.mp4", 256 * 1024 * 1024);
    prepared.commit();
  });

  it("releases failed candidate bytes without running unreviewed cleanup", async () => {
    Object.assign(window, {
      reelterminal: {
        fs: { readFileBytes: vi.fn()
          .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer)
          .mockRejectedValueOnce(new Error("missing file")) },
      },
    });
    await expect(prepareLiveMedia([action("a"), action("b")], project)).rejects.toThrow("missing file");
    expect(gc.release).toHaveBeenCalledWith("a");
  });

  it("rejects a colliding media id before controlled storage is written", async () => {
    await expect(prepareLiveMedia(
      [action("old")],
      { ...project, mediaLibrary: { items: [media("old")] } } as Project,
    )).rejects.toThrow("already exists");
    expect(storage.save).not.toHaveBeenCalled();
  });
});
