import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  createPerformanceFixture,
  hasWoff2Signature,
  materializePerformanceFixtureAssets,
  performanceFixtureManifestSha256,
} from "../../performance/fixtures";

function pngForMediaUrl(url: string | undefined): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(url ?? "");
  if (!match) throw new Error("fixture media item has no PNG data URL");
  return Buffer.from(match[1]!, "base64");
}

function pngCenterRgb(url: string | undefined): number[] {
  const png = pngForMediaUrl(url);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("fixture media bytes are not PNG data");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 320 || height !== 180 || png[24] !== 8 || png[25] !== 2) {
    throw new Error("fixture PNG dimensions or color type are invalid");
  }
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const centerOffset = 90 * (320 * 3 + 1) + 1 + 160 * 3;
  return Array.from(pixels.subarray(centerOffset, centerOffset + 3));
}

describe("deterministic performance fixtures", () => {
  test.each([[500, 20], [2000, 50]] as const)("T03 scales %i clips across %i tracks with fixed media", (clipCount, trackCount) => {
    const fixture = createPerformanceFixture({ scenarioId: "T03", seed: "42", parameters: { clipCount, trackCount } });
    const project = fixture.project!;
    expect(project.timeline.tracks).toHaveLength(trackCount);
    expect(project.timeline.tracks.flatMap((track) => track.clips).length + project.textClips!.length).toBe(clipCount);
    expect(project.mediaLibrary.items).toHaveLength(1);
    expect(project.timeline.tracks[0]!.clips[0]).toMatchObject({ id: fixture.targetMediaClipId, startTime: 0, duration: 5 });
    expect(pngCenterRgb(project.mediaLibrary.items[0]!.contentUrl)).toEqual(fixture.targetMarker!.rgb);
    expect(createPerformanceFixture({ scenarioId: "T03", seed: "42", parameters: { clipCount, trackCount } }).manifest).toEqual(fixture.manifest);
  });
  test("same seed recreates the same T01 project and manifest; changing it changes identities", () => {
    const first = createPerformanceFixture({ scenarioId: "T01", seed: "review-seed" });
    const repeated = createPerformanceFixture({ scenarioId: "T01", seed: "review-seed" });
    const changed = createPerformanceFixture({ scenarioId: "T01", seed: "other-seed" });

    expect(first.manifest).toEqual(repeated.manifest);
    expect(first.project).toEqual(repeated.project);
    expect(performanceFixtureManifestSha256(first.manifest)).toBe(
      performanceFixtureManifestSha256(repeated.manifest),
    );
    expect(first.manifest.assets.map((asset) => asset.sha256)).not.toEqual(
      changed.manifest.assets.map((asset) => asset.sha256),
    );
    expect(first.project?.timeline.tracks[0]?.clips).toHaveLength(25);
    expect(first.project?.textClips).toHaveLength(25);
    expect(first.project?.timeline.tracks[0]?.clips[0]).toMatchObject({ startTime: 0, duration: 5 });
    expect(first.project?.textClips?.[0]).toMatchObject({ startTime: 0, duration: 5 });
    expect(first.project?.timeline.tracks[0]?.clips.slice(1).every((clip) => clip.startTime >= 6)).toBe(true);
    expect(first.project?.textClips?.slice(1).every((clip) => clip.startTime >= 6)).toBe(true);
    expect(first.project?.textClips?.[0]?.transform.position.y).toBe(0.15);
    expect(first.manifest.parameters.clipCount).toBe(50);
    expect(first.records?.projects).toHaveLength(1);
    expect(first.records?.workspaces[0]?.id).toBe(first.workspaceId);
    expect(first.records?.workspaces[0]?.project).toEqual(first.project);
    expect(first.targetMediaClipId).toBe(first.project?.timeline.tracks[0]?.clips[0]?.id);
    expect(first.targetTextClipId).toBe(first.project?.textClips?.[0]?.id);
    expect(first.targetMarker?.probe).toEqual({ x: 0.5, y: 0.5 });
    const imageId = first.project?.timeline.tracks[0]?.clips[0]?.mediaId;
    const imageUrl = first.project?.mediaLibrary.items.find((item) => item.id === imageId)?.contentUrl;
    expect(pngCenterRgb(imageUrl)).toEqual(first.targetMarker?.rgb);
    const firstAsset = first.assets[0]!;
    const pngBytes = Buffer.from(firstAsset.content, "base64");
    expect(firstAsset.encoding).toBe("base64");
    expect(firstAsset.mediaType).toBe("image/png");
    expect(firstAsset.byteLength).toBe(pngBytes.byteLength);
    expect(firstAsset.sha256).toBe(createHash("sha256").update(pngBytes).digest("hex"));
    expect(first.manifest.assets[0]).toMatchObject({
      encoding: "base64",
      mediaType: "image/png",
      byteLength: pngBytes.byteLength,
      sha256: firstAsset.sha256,
    });
  });

  test("H01 scales 10/100/1000 nodes while keeping small snapshots and a stable target", () => {
    const trees = [10, 100, 1000].map((nodeCount) =>
      createPerformanceFixture({
        scenarioId: "H01",
        seed: "tree-seed",
        parameters: { nodeCount },
      }),
    );
    const targetIds = trees.map((fixture) => fixture.nodeTree?.targetNodeId);

    expect(trees.map((fixture) => fixture.nodeTree?.nodes.length)).toEqual([10, 100, 1000]);
    expect(new Set(targetIds).size).toBe(1);
    for (const fixture of trees) {
      const tree = fixture.nodeTree!;
      expect(tree.nodes.some((node) => node.id === tree.targetNodeId)).toBe(true);
      expect(tree.nodes.every((node) => node.snapshot.name === "Synthetic Node")).toBe(true);
      expect(tree.nodes.every((node) => node.snapshot.fontStructure === undefined)).toBe(true);
      expect(tree.nodes.every((node) =>
        node.childIds.every((childId) => tree.nodes.some((child) => child.id === childId)),
      )).toBe(true);
      expect(fixture.records?.nodes).toHaveLength(tree.nodes.length);
      expect(fixture.records?.nodeSummaries).toHaveLength(tree.nodes.length);
      expect(fixture.targetNodeId).toBe(tree.targetNodeId);
      const targetNode = fixture.records?.nodes.find((node) => node.id === tree.targetNodeId)!;
      const workspaceImage = fixture.project?.mediaLibrary.items[0]?.contentUrl;
      const targetImage = targetNode.project.mediaLibrary.items[0]?.contentUrl;
      expect(targetImage).not.toBe(workspaceImage);
      expect(pngCenterRgb(targetImage)).toEqual(fixture.targetMarker?.rgb);
      expect(pngCenterRgb(workspaceImage)).toEqual([210, 75, 75]);
      expect(fixture.records?.nodeSummaries.find((summary) => summary.id === tree.targetNodeId)?.parentNodeId)
        .toBe(tree.nodes.find((node) => node.id === tree.targetNodeId)?.parentId);
    }
  });

  test("T02 creates an exact 32 MiB structural payload without claiming FontFace support", () => {
    const fixture = createPerformanceFixture({
      scenarioId: "T02",
      seed: "font-structure-seed",
      parameters: { clipCount: 35, fontPayloadMiB: 32 },
    });
    const fontAsset = fixture.assets.find((asset) => asset.kind === "synthetic-font-structure")!;

    expect(fixture.project?.timeline.tracks[0]?.clips).toHaveLength(18);
    expect(fixture.project?.textClips).toHaveLength(17);
    expect(fixture.project?.timeline.tracks[0]?.clips.slice(1).every((clip) => clip.startTime >= 6)).toBe(true);
    expect(fixture.project?.textClips?.slice(1).every((clip) => clip.startTime >= 6)).toBe(true);
    expect(fixture.project?.renderFonts).toBeUndefined();
    expect(fixture.project?.performanceFixture?.syntheticFontStructure.dataUrlStructure)
      .toBe(fontAsset.content);
    expect(fontAsset.encoding).toBe("utf8");
    expect(fixture.project?.textClips?.every((clip) => clip.style.fontFamily === "Arial")).toBe(true);
    expect(fontAsset.byteLength).toBe(32 * 1024 * 1024);
    expect(fixture.project?.performanceFixture?.syntheticFontStructure.fontFaceDecodeSupported)
      .toBe(false);
    expect(fixture.manifest.parameters.fontDecodeSupported).toBe(false);
    expect(fixture.manifest.parameters.fontPayloadLocation).toBe(
      "performanceFixture.syntheticFontStructure.dataUrlStructure",
    );
    expect(fixture.manifest.requiredCapabilities).not.toContain("fontface-decode");
    expect(hasWoff2Signature(fontAsset)).toBe(false);
    expect(fixture.records?.workspaces[0]?.project.performanceFixture?.syntheticFontStructure.dataUrlStructure)
      .toBe(fontAsset.content);
  });

  test("H02 keeps the large structure payload on a node without entering FontFace", () => {
    const fixture = createPerformanceFixture({
      scenarioId: "H02",
      seed: "font-node-seed",
      parameters: { fontPayloadMiB: 32 },
    });
    const targetNode = fixture.records?.nodes[0]!;

    expect(fixture.records?.workspaces[0]?.project.performanceFixture).toBeUndefined();
    expect(targetNode.project.renderFonts).toBeUndefined();
    expect(targetNode.project.performanceFixture?.syntheticFontStructure.dataUrlStructure)
      .toHaveLength(32 * 1024 * 1024);
    expect(targetNode.project.performanceFixture?.syntheticFontStructure.fontFaceDecodeSupported)
      .toBe(false);
    expect(targetNode.project.textClips).toHaveLength(0);
    expect(targetNode.project.mediaLibrary.items[0]?.contentUrl).not.toBe(
      fixture.records?.workspaces[0]?.project.mediaLibrary.items[0]?.contentUrl,
    );
    expect(pngCenterRgb(targetNode.project.mediaLibrary.items[0]?.contentUrl))
      .toEqual(fixture.targetMarker?.rgb);
    expect(targetNode.project.id).toBe(fixture.projectId);
    expect(fixture.records?.nodeSummaries).toHaveLength(1);
  });

  test("H02 supports the full 64 MiB structure scale exactly", () => {
    const fixture = createPerformanceFixture({
      scenarioId: "H02",
      seed: "font-node-64-seed",
      parameters: { fontPayloadMiB: 64 },
    });
    const payload = fixture.records?.nodes[0]?.project.performanceFixture?.syntheticFontStructure;

    expect(payload?.byteLength).toBe(64 * 1024 * 1024);
    expect(payload?.dataUrlStructure).toHaveLength(64 * 1024 * 1024);
    expect(payload?.fontFaceDecodeSupported).toBe(false);
    expect(fixture.manifest.parameters.fontPayloadLocation).toBe(
      "performanceFixture.syntheticFontStructure.dataUrlStructure",
    );
    expect(hasWoff2Signature(fixture.assets.find((asset) => asset.kind === "synthetic-font-structure")!))
      .toBe(false);
  });

  test("P01 exposes a deterministic three-step edit and exact durable readback state", () => {
    const fixture = createPerformanceFixture({ scenarioId: "P01", seed: "save-seed" });
    const imageClips = fixture.project?.timeline.tracks.find((track) => track.type === "image")?.clips;
    const targetImage = fixture.project?.mediaLibrary.items.find((item) => item.id === imageClips?.[0]?.mediaId);
    const controlImage = fixture.project?.mediaLibrary.items.find((item) => item.id === imageClips?.[1]?.mediaId);

    expect(fixture.gesturePlan?.steps.map((step) => step.kind)).toEqual([
      "move",
      "trim",
      "move",
    ]);
    expect(imageClips).toHaveLength(2);
    expect(imageClips?.[0]).toMatchObject({ startTime: 0, duration: 1 });
    expect(imageClips?.[1]).toMatchObject({ startTime: 6, duration: 1 });
    expect(fixture.project?.textClips).toHaveLength(1);
    expect(fixture.targetMediaClipId).toBe(imageClips?.[0]?.id);
    expect(fixture.controlMediaClipId).toBe(imageClips?.[1]?.id);
    expect(fixture.controlMarker?.probe).toEqual({ x: 0.5, y: 0.5 });
    expect(fixture.controlMarker?.rgb).toEqual(fixture.targetMarker?.rgb.map((channel) => channel ^ 0x80));
    expect(pngCenterRgb(targetImage?.contentUrl)).toEqual(fixture.targetMarker?.rgb);
    expect(pngCenterRgb(controlImage?.contentUrl)).toEqual(fixture.controlMarker?.rgb);
    expect(fixture.gesturePlan?.expectedDurableState).toEqual({
      startTime: 4,
      duration: 1.5,
    });
    expect(fixture.project?.timeline.tracks[0]?.clips[0]?.id).toBe(
      fixture.gesturePlan?.clipId,
    );
    expect(fixture.records?.workspaces[0]?.project).toEqual(fixture.project);
    expect(fixture.manifest.parameters).toMatchObject({
      clipCount: 3,
      imageClipCount: 2,
      textClipCount: 1,
      controlMediaClipId: fixture.controlMediaClipId,
      targetMarkerRgb: fixture.targetMarker?.rgb.join(","),
      controlMarkerRgb: fixture.controlMarker?.rgb.join(","),
    });
    expect(fixture.manifest.expectedOperations).toBe(5);
  });

  test("asset materialization writes only to a caller-provided temp directory", async () => {
    const fixture = createPerformanceFixture({ scenarioId: "T01", seed: "asset-seed" });
    const directory = await mkdtemp(path.join(tmpdir(), "reelterminal-performance-fixture-"));
    try {
      const paths = await materializePerformanceFixtureAssets(fixture, directory);
      const asset = fixture.assets[0]!;
      expect(Object.keys(paths)).toHaveLength(fixture.assets.length);
      expect(await readFile(paths[asset.assetId]!)).toEqual(Buffer.from(asset.content, "base64"));
      await expect(
        materializePerformanceFixtureAssets(fixture, path.resolve(tmpdir(), "..", ".fixture-output")),
      ).rejects.toThrow(/system temp directory/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("manifest hashing ignores object key insertion order", () => {
    const fixture = createPerformanceFixture({ scenarioId: "H01", seed: "hash-seed" });
    const reordered = Object.fromEntries(
      Object.entries(fixture.manifest).reverse(),
    ) as typeof fixture.manifest;

    expect(performanceFixtureManifestSha256(reordered)).toBe(
      performanceFixtureManifestSha256(fixture.manifest),
    );
  });

  test("rejects unsupported scale values and misspelled payload parameters", () => {
    expect(() => createPerformanceFixture({
      scenarioId: "T02",
      seed: "invalid-seed",
      parameters: { clipCount: 51 },
    })).toThrow(/between 35 and 50/);
    expect(() => createPerformanceFixture({
      scenarioId: "T02",
      seed: "invalid-seed",
      parameters: { fontPayloadMib: 64 },
    })).toThrow(/does not support fixture parameter/);
    expect(() => createPerformanceFixture({
      scenarioId: "H01",
      seed: "invalid-seed",
      parameters: { nodeCount: 25 },
    })).toThrow(/must be one of 10, 100, 1000/);
  });
});
