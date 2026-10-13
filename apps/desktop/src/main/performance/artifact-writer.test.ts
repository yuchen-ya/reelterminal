import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ArtifactWriterError,
  PerformanceArtifactWriter,
} from "./artifact-writer";

const created: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "perf-artifacts-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("PerformanceArtifactWriter", () => {
  it("writes valid artifacts inside the approved root and creates parents", async () => {
    const root = await tempRoot();
    const writer = new PerformanceArtifactWriter([root]);
    const result = await writer.writeJson("runs/scenario-a/result.json", { status: "complete" });
    expect(result.path.startsWith(root)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    const stored = JSON.parse(await readFile(result.path, "utf8"));
    expect(stored).toEqual({ status: "complete" });
  });

  it("prefers the first approved root for relative names", async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const writer = new PerformanceArtifactWriter([rootA, rootB]);
    const result = await writer.writeJson("x.json", 1);
    expect(result.path.startsWith(rootA)).toBe(true);
  });

  it("rejects traversal, absolute paths, drives and backslashes", async () => {
    const root = await tempRoot();
    const writer = new PerformanceArtifactWriter([root]);
    const bad = [
      "../escape.json",
      "..\\..\\escape.json",
      "C:\\Users\\evil.json",
      "/etc/passwd",
      "a b.json",
      "",
      ".hidden-start",
      "runs/../x.json",
    ];
    for (const name of bad) {
      await expect(writer.writeJson(name, {})).rejects.toThrow(ArtifactWriterError);
    }
  });

  it("refuses payloads over the size cap instead of truncating", async () => {
    const root = await tempRoot();
    const writer = new PerformanceArtifactWriter([root]);
    try {
      await writer.writeJson("big.json", { blob: "x".repeat(64) }, { maxBytes: 8 });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactWriterError);
      expect((error as ArtifactWriterError).code).toBe("payload_too_large");
    }
  });

  it("requires absolute approved roots", () => {
    expect(() => new PerformanceArtifactWriter([])).toThrow(ArtifactWriterError);
    expect(() => new PerformanceArtifactWriter([`relative${sep}root`])).toThrow(ArtifactWriterError);
  });

  it("surfaces write failures under write_failed", async () => {
    const root = await tempRoot();
    const writer = new PerformanceArtifactWriter([root], {
      writeFile: async () => {
        throw new Error("disk on fire");
      },
    });
    await expect(writer.writeJson("x.json", {})).rejects.toThrow(ArtifactWriterError);
  });
});
