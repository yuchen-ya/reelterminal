import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileBytes } from "./fs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function tempFile(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reelterminal-fs-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "media.bin");
  await writeFile(file, bytes);
  return file;
}

describe("readFileBytes", () => {
  it("reads through the bounded file-handle path", async () => {
    const file = await tempFile(new Uint8Array([1, 2, 3, 4]));

    const result = await readFileBytes({ path: file, maxBytes: 4 });

    expect([...new Uint8Array(result)]).toEqual([1, 2, 3, 4]);
  });

  it("rejects a file larger than the requested limit", async () => {
    const file = await tempFile(new Uint8Array([1, 2, 3, 4, 5]));

    await expect(readFileBytes({ path: file, maxBytes: 4 })).rejects.toThrow(
      "4-byte read limit",
    );
  });
});
