/**
 * PartFileWriter byte accounting for chunked MP4 writes.
 *
 * The chunked mediabunny StreamTarget writes with absolute positions and
 * REWRITES regions (header patches after a mid-stream flush). `bytes` must
 * be the high-water mark of written end positions — i.e. the real file
 * size — never a sum of every write. Overlapping writes must not inflate the
 * reported file size.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PartFileWriter } from "./runtime";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "part-file-writer-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeChunks(
  name: string,
  writes: ReadonlyArray<{ seek?: number; data: string }>,
): Promise<{ writer: PartFileWriter; finalPath: string }> {
  const finalPath = path.join(dir, name);
  const writer = await PartFileWriter.open(finalPath);
  for (const write of writes) {
    if (write.seek !== undefined) await writer.seek(write.seek);
    await writer.writeBase64(Buffer.from(write.data, "utf8").toString("base64"));
  }
  return { writer, finalPath };
}

describe("PartFileWriter byte accounting", () => {
  it("sequential writes report the plain total", async () => {
    const { writer, finalPath } = await writeChunks("sequential.mp4", [
      { data: "aaaa" },
      { data: "bbbb" },
      { data: "cccc" },
    ]);
    expect(writer.bytes).toBe(12);
    expect(await writer.finalize()).toBe(12);
    expect((await stat(finalPath)).size).toBe(12);
  });

  it("a backward rewrite (chunked StreamTarget patch) does not overcount", async () => {
    // 8-byte payload followed by an 8-byte rewrite of its first half: the
    // exact +8 overcount shape from the >4 MiB export failure.
    const { writer, finalPath } = await writeChunks("rewrite.mp4", [
      { data: "01234567" },
      { seek: 0, data: "ABCDEFGH" },
    ]);
    expect(writer.bytes).toBe(8);
    expect(await writer.finalize()).toBe(8);
    const onDisk = await stat(finalPath);
    expect(onDisk.size).toBe(8);
    expect(onDisk.size).toBe(writer.bytes);
  });

  it("a rewrite extending past the previous end grows the high-water mark", async () => {
    const { writer, finalPath } = await writeChunks("extend.mp4", [
      { data: "0123456789" },
      { seek: 8, data: "abcdef" }, // end 14 > previous 10
    ]);
    expect(writer.bytes).toBe(14);
    expect(await writer.finalize()).toBe(14);
    expect((await stat(finalPath)).size).toBe(14);
  });

  it("a forward seek leaves a hole that counts toward the size, matching fs.stat", async () => {
    const { writer, finalPath } = await writeChunks("sparse.mp4", [
      { data: "aaaa" },
      { seek: 10, data: "bb" },
    ]);
    expect(writer.bytes).toBe(12);
    expect(await writer.finalize()).toBe(12);
    expect((await stat(finalPath)).size).toBe(12);
  });
});
