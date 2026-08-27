/**
 * Regression for the probe's memory contract: metadata extraction must
 * STREAM from disk via mediabunny's FilePathSource and explicitly dispose
 * the Input — never buffer the whole file (the earlier readFile+BlobSource
 * implementation did exactly that), and never leak the file handle.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// vi.hoisted: the captured probe-observation state must exist before the
// mocked module factory runs (mock factories execute at import time).
const observed = vi.hoisted(() => ({
  sources: [] as unknown[],
  disposeCalls: 0,
}));

vi.mock("mediabunny", async (importOriginal) => {
  const mod = await importOriginal<typeof import("mediabunny")>();
  class ObservedInput extends mod.Input {
    constructor(options: ConstructorParameters<typeof mod.Input>[0]) {
      observed.sources.push(options.source);
      super(options);
    }
    dispose(): void {
      observed.disposeCalls += 1;
      super.dispose();
    }
  }
  return { ...mod, Input: ObservedInput };
});

import { BlobSource, FilePathSource } from "mediabunny";
import { probeLocalMediaFile } from "./node-media-adapter";
import { tinyMp4Bytes, writeTinyMp4 } from "./fixtures/tiny-mp4";

describe("probeLocalMediaFile source & disposal contract", () => {
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "node-media-source-"));
    fixturePath = writeTinyMp4(fixtureDir);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it("probes through a FilePathSource, never a BlobSource", async () => {
    const before = observed.sources.length;
    const probed = await probeLocalMediaFile(fixturePath);

    expect(observed.sources.length).toBe(before + 1);
    const source = observed.sources[observed.sources.length - 1];
    expect(source).toBeInstanceOf(FilePathSource);
    expect(source).not.toBeInstanceOf(BlobSource);

    // Metadata still comes out correct through the streaming source, with
    // the file size taken from stat (equal to the real on-disk length).
    expect(probed.type).toBe("video");
    expect(probed.fileSize).toBe(tinyMp4Bytes().byteLength);
  }, 30000);

  it("disposes the Input exactly once per probe — success and failure alike", async () => {
    const beforeDispose = observed.disposeCalls;

    await probeLocalMediaFile(fixturePath);
    expect(observed.disposeCalls).toBe(beforeDispose + 1);

    // A non-media file must also dispose on its way out.
    const fake = path.join(fixtureDir, "not-media.mp4");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(fake, "definitely not an mp4", "utf8"),
    );
    await expect(probeLocalMediaFile(fake)).rejects.toThrowError(
      /failed to probe|unsupported media/i,
    );
    expect(observed.disposeCalls).toBe(beforeDispose + 2);
  }, 30000);
});
