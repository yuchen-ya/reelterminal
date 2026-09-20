import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action, MediaItem, Project } from "@reelterminal/core";
const storage = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));
vi.mock("../media-storage", () => ({ saveMediaBlob: storage.save, deleteMediaBlob: storage.remove }));
import { prepareLiveMedia } from "./prepare-live-media";
const project = { id: "p", mediaLibrary: { items: [] } } as unknown as Project;
const media = (id: string) => ({ id, name: "shot.mp4", type: "video", originalUrl: "/root/shot.mp4", metadata: { fileSize: 3 } }) as MediaItem;
const action = (id: string) => ({ type: "media/import", id: `a-${id}`, timestamp: 0, params: { mediaItem: media(id) } }) as Action;
afterEach(() => { vi.resetAllMocks(); delete (window as { reelterminal?: unknown }).reelterminal; });
describe("live replacement bytes", () => {
  it("hydrates and persists before project commit; discard deletes only prepared new media", async () => {
    const readFileBytes = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    Object.assign(window, { reelterminal: { fs: { readFileBytes } } });
    const input = action("new");
    const prepared = await prepareLiveMedia([input], project);
    const item = (prepared.actions[0].params as { mediaItem: MediaItem }).mediaItem;
    expect(item.blob?.size).toBe(3);
    expect((input.params as { mediaItem: MediaItem }).mediaItem.blob).toBeUndefined();
    expect(storage.save).toHaveBeenCalledWith("p", "new", item.blob, item.metadata);
    expect(project.mediaLibrary.items).toHaveLength(0);
    await prepared.discard();
    await prepared.discard();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith("new");
  });
  it("cleans earlier prepared blobs if a later source fails without touching original bytes", async () => {
    Object.assign(window, { reelterminal: { fs: { readFileBytes: vi.fn()
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer).mockRejectedValueOnce(new Error("missing file")) } } });
    await expect(prepareLiveMedia([action("a"), action("b")], project)).rejects.toThrow("missing file");
    expect(storage.remove).toHaveBeenCalledWith("a");
    expect(storage.remove).not.toHaveBeenCalledWith("b");
  });
  it("rejects a colliding media id before storage overwrite", async () => {
    await expect(prepareLiveMedia([action("old")], { ...project, mediaLibrary: { items: [media("old")] } } as Project)).rejects.toThrow("already exists");
    expect(storage.save).not.toHaveBeenCalled();
  });
});
