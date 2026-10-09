import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlledMediaStore } from "./controlled-media-store";

describe("ControlledMediaStore", () => {
  let root: string;
  let store: ControlledMediaStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-media-store-"));
    store = new ControlledMediaStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  async function save(mediaId: string, bytes: Buffer, extension = "mp4") {
    const session = await store.beginWrite({
      projectId: "project-1",
      mediaId,
      expectedHash: hash(bytes),
      extension,
    });
    await store.writeChunk(session, bytes);
    return store.commitWrite(session);
  }

  it("publishes a complete, content-verified file and reads it back", async () => {
    const bytes = Buffer.from("version-one");
    const saved = await save("media-1", bytes, "mp4");

    expect(saved.created).toBe(true);
    expect(saved.contentHash).toBe(hash(bytes));
    expect(await readFile(saved.path)).toEqual(bytes);
    expect(await store.read("project-1", "media-1")).toEqual(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(await store.listProject("project-1")).toMatchObject([
      { mediaId: "media-1", path: saved.path, sizeBytes: bytes.byteLength },
    ]);
  });

  it("treats identical writes as idempotent and rejects different bytes for the same id", async () => {
    const original = Buffer.from("version-one");
    const first = await save("media-1", original, "mp4");
    const replay = await save("media-1", original, "mov");
    expect(replay).toEqual({ ...first, created: false });

    const session = await store.beginWrite({
      projectId: "project-1",
      mediaId: "media-1",
      expectedHash: hash(Buffer.from("version-two")),
      extension: "mp4",
    });
    await store.writeChunk(session, Buffer.from("version-two"));
    await expect(store.commitWrite(session)).rejects.toThrow(/immutable/i);
    expect(await readFile(first.path)).toEqual(original);
    expect((await readdir(path.dirname(first.path))).filter((name) => !name.startsWith(".pending-"))).toEqual([
      "media-1.mp4",
    ]);
  });

  it("shares an identical immutable version across project owners", async () => {
    const bytes = Buffer.from("shared-version");
    const first = await save("shared-media", bytes, "png");
    const session = await store.beginWrite({
      projectId: "project-2",
      mediaId: "shared-media",
      expectedHash: hash(bytes),
      extension: "png",
    });
    await store.writeChunk(session, bytes);

    const second = await store.commitWrite(session);

    expect(second).toEqual({ ...first, created: false });
    expect(await store.readAny("shared-media")).toEqual(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  });

  it("rejects chunks whose bytes do not match the expected hash", async () => {
    const session = await store.beginWrite({
      projectId: "project-1",
      mediaId: "media-1",
      expectedHash: hash(Buffer.from("expected")),
      extension: "png",
    });
    await store.writeChunk(session, Buffer.from("different"));
    await expect(store.commitWrite(session)).rejects.toThrow(/SHA-256/i);
    expect(await store.listProject("project-1")).toEqual([]);
  });

  it("deletes all controlled copies of the requested immutable version", async () => {
    const version = await save("media-1", Buffer.from("version-one"));
    expect(await store.read("project-1", "missing")).toBeNull();
    await store.delete("media-1");
    expect(await store.read("project-1", "media-1")).toBeNull();
    expect(await store.listProject("project-1")).toEqual([]);
    expect(await store.listProject("project-2")).toEqual([]);
    expect(version.path).toContain("media-1.mp4");
  });
});
