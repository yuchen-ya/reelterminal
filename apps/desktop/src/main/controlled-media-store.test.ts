import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
  symlink,
  unlink,
} from "node:fs/promises";
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

  const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");

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
    expect(await store.listProject("project-1")).toEqual([
      {
        projectId: "project-1",
        mediaId: "media-1",
        path: saved.path,
        sizeBytes: bytes.byteLength,
        lastModifiedMs: expect.any(Number),
        contentHash: hash(bytes),
      },
    ]);
    expect((await store.listAll())[0]?.contentHash).toBe(hash(bytes));
  });

  it("retains a same-size file changed after the reviewed fingerprint", async () => {
    const saved = await save("cleanup-media", Buffer.from("original"));
    const reviewed = await store.listAll();
    await writeFile(saved.path, Buffer.from("replaced"));
    const changed = new Date(reviewed[0].lastModifiedMs + 2000);
    await utimes(saved.path, changed, changed);
    await expect(store.delete("cleanup-media", reviewed)).rejects.toThrow(
      /changed after cleanup review/,
    );
    expect(await readFile(saved.path, "utf8")).toBe("replaced");
  });

  it("deletes only the exact reviewed file set and rejects a scope expansion", async () => {
    const saved = await save("cleanup-media", Buffer.from("original"));
    const reviewed = await store.listAll();
    const additional = path.join(
      path.dirname(saved.path),
      "cleanup-media.webm",
    );
    await writeFile(additional, "new version");
    await expect(store.delete("cleanup-media", reviewed)).rejects.toThrow(
      /changed/,
    );
    expect(await readFile(saved.path, "utf8")).toBe("original");
    await unlink(additional);
    await store.delete("cleanup-media", reviewed);
    expect(await store.listAll()).toEqual([]);
  });

  it("never follows a directory junction to delete an external original", async () => {
    const external = await mkdtemp(
      path.join(os.tmpdir(), "reelterminal-cleanup-external-"),
    );
    try {
      const original = path.join(external, "outside-media.mp4");
      await writeFile(original, "external original");
      const junction = path.join(root, "external-project");
      await symlink(
        external,
        junction,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        store.delete("outside-media", [
          {
            path: path.join(junction, "outside-media.mp4"),
            sizeBytes: 17,
            lastModifiedMs: 0,
          },
        ]),
      ).rejects.toThrow(/changed|escapes/);
      expect(await readFile(original, "utf8")).toBe("external original");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
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
    expect(
      (await readdir(path.dirname(first.path))).filter(
        (name) => !name.startsWith(".pending-"),
      ),
    ).toEqual([`media-1.${hash(original)}.mp4`]);
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
    expect(version.path).toMatch(/media-1\.[0-9a-f]{64}\.mp4$/);
  });

  it("lists hash-encoded names without reading bytes and keeps legacy names readable", async () => {
    const bytes = Buffer.from("legacy-bytes");
    const legacyPath = path.join(root, "project-1", "legacy-media.mp4");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, bytes);

    const legacyEntries = await store.listProject("project-1");
    expect(legacyEntries).toEqual([
      {
        projectId: "project-1",
        mediaId: "legacy-media",
        path: legacyPath,
        sizeBytes: bytes.byteLength,
        lastModifiedMs: expect.any(Number),
      },
    ]);
    expect(await store.read("project-1", "legacy-media")).toEqual(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );

    // A pre-hash-encoding file keeps working through the immutable commit
    // path: identical bytes dedupe onto it, different bytes are refused.
    const session = await store.beginWrite({
      projectId: "project-1",
      mediaId: "legacy-media",
      expectedHash: hash(bytes),
      extension: "mp4",
    });
    await store.writeChunk(session, bytes);
    const replay = await store.commitWrite(session);
    expect(replay).toEqual({
      path: legacyPath,
      contentHash: hash(bytes),
      created: false,
    });
    const committed = await store.listProject("project-1");
    expect(committed).toHaveLength(1);
    expect(committed[0]?.contentHash).toBeUndefined();

    const other = await store.beginWrite({
      projectId: "project-1",
      mediaId: "legacy-media",
      expectedHash: hash(Buffer.from("other-bytes")),
      extension: "mp4",
    });
    await store.writeChunk(other, Buffer.from("other-bytes"));
    await expect(store.commitWrite(other)).rejects.toThrow(/immutable/i);
  });
});
