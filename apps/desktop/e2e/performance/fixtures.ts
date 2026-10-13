import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip, Track, Transform } from "@reelterminal/core/types/timeline";
import type { TextClip } from "@reelterminal/core/text/types";

export type TimelinePerformanceScenarioId = "T01" | "T02" | "T03" | "H01" | "H02" | "P01";
export type PerformanceScenarioId = TimelinePerformanceScenarioId | "A01" | "R01" | "R02" | "E01";
export type FixtureParameter = string | number | boolean;

export interface PerformanceFixtureAsset {
  readonly assetId: string;
  readonly kind: "synthetic-image" | "synthetic-font-structure";
  readonly mediaType: string;
  readonly fileName: string;
  readonly encoding: "base64" | "utf8";
  readonly content: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SyntheticFontStructurePayload {
  readonly assetId: string;
  readonly dataUrlStructure: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly fontFaceDecodeSupported: false;
}

/** Test-only extension carried by production-shaped project records. */
export interface PerformanceFixtureProject extends Project {
  readonly performanceFixture?: Readonly<{
    readonly syntheticFontStructure: SyntheticFontStructurePayload;
  }>;
}

export interface PerformanceFixtureManifest {
  readonly schema: "reelterminal.performance-fixture/v1";
  readonly scenarioId: PerformanceScenarioId;
  readonly version: 1;
  readonly seed: string;
  readonly parameters: Readonly<Record<string, FixtureParameter>>;
  readonly expectedSemantics: readonly string[];
  readonly assets: readonly {
    readonly assetId: string;
    readonly kind: PerformanceFixtureAsset["kind"];
    readonly mediaType: string;
    readonly encoding: PerformanceFixtureAsset["encoding"];
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly requiredCapabilities: readonly string[];
  readonly expectedOperations: number;
  readonly timeBudgetMs: number;
}

export interface SyntheticNodeSnapshot {
  readonly id: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly snapshot: Readonly<{
    readonly kind: "synthetic-node";
    readonly name: "Synthetic Node";
    readonly visible: true;
    readonly x: 0;
    readonly y: 0;
    readonly scale: 1;
    readonly opacity: 1;
    readonly fontStructure?: Readonly<{
      readonly assetId: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly fontFaceDecodeSupported: false;
    }>;
  }>;
}

export interface SyntheticNodeTree {
  readonly rootNodeId: string;
  readonly targetNodeId: string;
  readonly nodes: readonly SyntheticNodeSnapshot[];
}

export interface PerformanceGesturePlan {
  readonly clipId: string;
  readonly steps: readonly [
    { readonly kind: "move"; readonly startTime: number },
    { readonly kind: "trim"; readonly duration: number },
    { readonly kind: "move"; readonly startTime: number },
  ];
  readonly expectedDurableState: Readonly<{
    readonly startTime: number;
    readonly duration: number;
  }>;
}

export interface WorkspaceProjectRecordSeed {
  readonly id: string;
  readonly name: string;
  readonly defaultWorkspaceId: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
}

export interface WorkspaceRecordSeed {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: "default";
  readonly baseNodeId: string | null;
  readonly revision: number;
  readonly updatedAt: number;
  readonly dirty: boolean;
  readonly project: PerformanceFixtureProject;
}

export interface WorkspaceNodeRecordSeed {
  readonly id: string;
  readonly projectId: string;
  readonly parentNodeId: string | null;
  readonly name: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly formatVersion: 1;
  readonly project: PerformanceFixtureProject;
  readonly mediaIds: readonly string[];
  readonly missingDependencies: readonly string[];
}

export type WorkspaceNodeSummarySeed = Omit<WorkspaceNodeRecordSeed, "project">;

export interface WorkspaceDatabaseSeedRecords {
  readonly projects: readonly WorkspaceProjectRecordSeed[];
  readonly workspaces: readonly WorkspaceRecordSeed[];
  readonly nodes: readonly WorkspaceNodeRecordSeed[];
  readonly nodeSummaries: readonly WorkspaceNodeSummarySeed[];
}

export interface FixtureTargetMarker {
  readonly rgb: readonly [number, number, number];
  readonly probe: Readonly<{ x: 0.5; y: 0.5 }>;
}

export interface PerformanceFixture {
  readonly manifest: PerformanceFixtureManifest;
  readonly assets: readonly PerformanceFixtureAsset[];
  /** A core Project snapshot for scenarios that exercise timeline persistence. */
  readonly project?: PerformanceFixtureProject;
  /** Production IndexedDB v3 seed rows; store names are plural and keyPath-ready. */
  readonly records?: WorkspaceDatabaseSeedRecords;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly targetNodeId?: string;
  readonly targetMediaClipId?: string;
  readonly controlMediaClipId?: string;
  readonly targetTextClipId?: string;
  readonly targetMarker?: FixtureTargetMarker;
  readonly controlMarker?: FixtureTargetMarker;
  /** Flat, stable-ID tree used by H01 and H02. */
  readonly nodeTree?: SyntheticNodeTree;
  /** P01 input sequence and the exact state that must survive relaunch. */
  readonly gesturePlan?: PerformanceGesturePlan;
}

export interface PerformanceFixtureRequest {
  readonly scenarioId: TimelinePerformanceScenarioId;
  readonly seed: string;
  readonly parameters?: Readonly<Record<string, FixtureParameter>>;
}

const MEBIBYTE = 1024 * 1024;
const FIXTURE_EPOCH_MS = 1_700_000_000_000;
const FONT_DATA_URL_PREFIX = "data:font/woff2;base64,";
const EXPECTED_FONT_FACE_HEADER = Buffer.from("wOF2", "ascii");
const PNG_WIDTH = 320;
const PNG_HEIGHT = 180;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function seedTag(seed: string): string {
  return sha256(seed).slice(0, 12);
}

function parameterNumber(
  parameters: Readonly<Record<string, FixtureParameter>>,
  name: string,
  fallback: number,
): number {
  const value = parameters[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`fixture parameter ${name} must be an integer`);
  }
  return value;
}

function assertOnlyParameters(
  scenarioId: PerformanceScenarioId,
  parameters: Readonly<Record<string, FixtureParameter>>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(parameters).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RangeError(`${scenarioId} does not support fixture parameter(s): ${unknown.join(", ")}`);
  }
}

function parameterChoice<T extends number>(
  parameters: Readonly<Record<string, FixtureParameter>>,
  name: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = parameterNumber(parameters, name, fallback);
  if (!allowed.includes(value as T)) {
    throw new RangeError(`fixture parameter ${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function makeAsset(
  assetId: string,
  kind: PerformanceFixtureAsset["kind"],
  mediaType: string,
  fileName: string,
  content: string,
  encoding: PerformanceFixtureAsset["encoding"] = "utf8",
): PerformanceFixtureAsset {
  const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  return {
    assetId,
    kind,
    mediaType,
    fileName,
    encoding,
    content,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function withSyntheticFontStructure(
  project: PerformanceFixtureProject,
  asset: PerformanceFixtureAsset,
): PerformanceFixtureProject {
  return {
    ...project,
    performanceFixture: {
      syntheticFontStructure: {
        assetId: asset.assetId,
        dataUrlStructure: asset.content,
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        fontFaceDecodeSupported: false,
      },
    },
  };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function encodePng(pixelAt: (x: number, y: number) => readonly [number, number, number]): Buffer {
  const rowBytes = PNG_WIDTH * 3;
  const pixels = Buffer.alloc(PNG_HEIGHT * (rowBytes + 1));
  for (let y = 0; y < PNG_HEIGHT; y++) {
    const rowOffset = y * (rowBytes + 1);
    pixels[rowOffset] = 0;
    for (let x = 0; x < PNG_WIDTH; x++) {
      const pixelOffset = rowOffset + 1 + x * 3;
      const [red, green, blue] = pixelAt(x, y);
      pixels[pixelOffset] = red;
      pixels[pixelOffset + 1] = green;
      pixels[pixelOffset + 2] = blue;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(PNG_WIDTH, 0);
  header.writeUInt32BE(PNG_HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngColorCard(seed: string, label: string, centerColor?: string): Buffer {
  const digest = sha256(`${seed}:${label}`);
  const colors = [0, 6, 12].map((offset) => rgbFromHex(`#${digest.slice(offset, offset + 6)}`));
  const center = centerColor ? rgbFromHex(centerColor) : colors[2]!;
  return encodePng((x, y) => {
    if (x >= 140 && x < 180 && y >= 80 && y < 100) return center;
    return colors[(Math.floor(x / 40) + Math.floor(y / 30)) % colors.length]!;
  });
}

function dataUrl(asset: PerformanceFixtureAsset): string {
  const content = asset.encoding === "base64"
    ? asset.content
    : Buffer.from(asset.content, "utf8").toString("base64");
  return `data:${asset.mediaType};base64,${content}`;
}

function defaultTransform(): Transform {
  return {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

function makeImageClip(
  index: number,
  mediaId: string,
  trackId: string,
  firstDuration: number,
): Clip {
  const startTime = index === 0
    ? 0
    : firstDuration >= 5
      ? 6 + (index - 1) * 1.25
      : index * 1.25;
  const duration = index === 0 ? firstDuration : 1;
  return {
    id: `image-clip-${String(index + 1).padStart(4, "0")}`,
    mediaId,
    trackId,
    startTime,
    duration,
    inPoint: 0,
    outPoint: duration,
    effects: [],
    audioEffects: [],
    transform: defaultTransform(),
    volume: 1,
    keyframes: [],
  };
}

function makeTextClip(
  index: number,
  seed: string,
  trackId: string,
  firstDuration: number,
): TextClip {
  const transform = defaultTransform();
  const positionedTransform = index === 0
    ? { ...transform, position: { x: 0.25, y: 0.15 } }
    : transform;
  const startTime = index === 0
    ? 0
    : firstDuration >= 5
      ? 6 + (index - 1) * 1.25
      : index * 1.25 + 0.15;
  return {
    id: `text-clip-${String(index + 1).padStart(4, "0")}`,
    trackId,
    startTime,
    duration: index === 0 ? firstDuration : 0.8,
    text: `SYNTH-${seedTag(seed)}-${String(index + 1).padStart(3, "0")}`,
    style: {
      fontFamily: "Arial",
      fontSize: 36,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#ffffff",
      textAlign: "center",
      verticalAlign: "middle",
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    transform: positionedTransform,
    keyframes: [],
  };
}

function makeTrack(id: string, type: Track["type"], clips: Clip[]): Track {
  return {
    id,
    type,
    name: `Synthetic ${type} track`,
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function makeTimelineProject(options: {
  readonly scenarioId: PerformanceScenarioId;
  readonly seed: string;
  readonly imageCount: number;
  readonly textCount: number;
  readonly assets: PerformanceFixtureAsset[];
  readonly firstMediaDuration?: number;
  readonly firstTextDuration?: number;
}): PerformanceFixtureProject {
  const imageTrackId = "synthetic-image-track";
  const textTrackId = "synthetic-text-track";
  const mediaItems = options.assets.map((asset, index) => {
      const contentUrl = dataUrl(asset);
    return {
      id: asset.assetId,
      name: asset.fileName,
      displayName: `Synthetic image ${String(index + 1).padStart(3, "0")}`,
      type: "image" as const,
      fileHandle: null,
      blob: null,
      metadata: {
        duration: Math.max(5, options.firstMediaDuration ?? 1),
        width: 320,
        height: 180,
        frameRate: 0,
        codec: "png",
        sampleRate: 0,
        channels: 0,
        fileSize: asset.byteLength,
      },
      thumbnailUrl: contentUrl,
      waveformData: null,
      contentUrl,
      contentHash: asset.sha256,
      isPlaceholder: false,
    };
  });
  const imageClips = mediaItems.map((media, index) =>
    makeImageClip(index, media.id, imageTrackId, options.firstMediaDuration ?? 1),
  );
  const textClips = Array.from({ length: options.textCount }, (_, index) =>
    makeTextClip(index, options.seed, textTrackId, options.firstTextDuration ?? 0.8),
  );
  const firstMediaDuration = options.firstMediaDuration ?? 1;
  const firstTextDuration = options.firstTextDuration ?? 0.8;
  const imageEnd = options.imageCount === 0
    ? 0
    : options.imageCount === 1
      ? firstMediaDuration
      : firstMediaDuration >= 5
        ? 6 + (options.imageCount - 2) * 1.25 + 1
        : (options.imageCount - 1) * 1.25 + 1;
  const textEnd = options.textCount === 0
    ? 0
    : options.textCount === 1
      ? firstTextDuration
      : firstTextDuration >= 5
        ? 6 + (options.textCount - 2) * 1.25 + 0.8
        : (options.textCount - 1) * 1.25 + 0.15 + 0.8;
  const duration = Math.max(10, Math.ceil(Math.max(imageEnd, textEnd)));

  return {
    id: `performance-${options.scenarioId.toLowerCase()}-${seedTag(options.seed)}`,
    name: `Synthetic performance fixture ${options.scenarioId}`,
    createdAt: FIXTURE_EPOCH_MS,
    modifiedAt: FIXTURE_EPOCH_MS,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48_000, channels: 2 },
    mediaLibrary: { items: mediaItems },
    timeline: {
      tracks: [makeTrack(imageTrackId, "image", imageClips), makeTrack(textTrackId, "text", [])],
      subtitles: [],
      duration,
      markers: [],
    },
    textClips,
  };
}

function createSyntheticFontStructure(seed: string, payloadMiB: number): PerformanceFixtureAsset {
  const totalBytes = payloadMiB * MEBIBYTE;
  const fillerLength = totalBytes - Buffer.byteLength(FONT_DATA_URL_PREFIX, "utf8");
  if (fillerLength < 0) throw new RangeError("font structure payload is too small");
  // Repeated base64 alphabet characters create a deterministic serialization
  // payload. The decoded prefix is not the WOFF2 signature and is not a font.
  const pattern = seedTag(seed);
  const filler = pattern.repeat(Math.ceil(fillerLength / pattern.length)).slice(0, fillerLength);
  const dataUrl = `${FONT_DATA_URL_PREFIX}${filler}`;
  const asset = makeAsset(
    `synthetic-font-structure-${seedTag(seed)}-${payloadMiB}mib`,
    "synthetic-font-structure",
    "application/x-reelterminal-font-structure",
    `synthetic-font-structure-${seedTag(seed)}-${payloadMiB}mib.fixture.txt`,
    dataUrl,
  );
  return asset;
}

function createNodeTree(seed: string, count: number): SyntheticNodeTree {
  const tag = seedTag(seed);
  const childIndexes = Array.from({ length: count }, (_, index) => {
    const firstChild = index * 4 + 1;
    return Array.from({ length: 4 }, (_, offset) => firstChild + offset).filter(
      (childIndex) => childIndex < count,
    );
  });
  const ids = Array.from({ length: count }, (_, index) =>
    `node-${tag}-${String(index + 1).padStart(4, "0")}`,
  );
  const nodes = ids.map((id, index): SyntheticNodeSnapshot => ({
    id,
    parentId: index === 0 ? null : ids[Math.floor((index - 1) / 4)]!,
    childIds: childIndexes[index]!.map((childIndex) => ids[childIndex]!),
    snapshot: {
      kind: "synthetic-node",
      name: "Synthetic Node",
      visible: true,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
    },
  }));
  return { rootNodeId: ids[0]!, targetNodeId: ids[Math.min(5, count - 1)]!, nodes };
}

function baseManifest(options: {
  readonly scenarioId: PerformanceScenarioId;
  readonly seed: string;
  readonly parameters: Readonly<Record<string, FixtureParameter>>;
  readonly expectedSemantics: readonly string[];
  readonly assets: readonly PerformanceFixtureAsset[];
  readonly requiredCapabilities: readonly string[];
  readonly expectedOperations: number;
  readonly timeBudgetMs: number;
}): PerformanceFixtureManifest {
  return {
    schema: "reelterminal.performance-fixture/v1",
    scenarioId: options.scenarioId,
    version: 1,
    seed: options.seed,
    parameters: options.parameters,
    expectedSemantics: options.expectedSemantics,
    assets: options.assets.map(({ assetId, kind, mediaType, encoding, byteLength, sha256: hash }) => ({
      assetId,
      kind,
      mediaType,
      encoding,
      byteLength,
      sha256: hash,
    })),
    requiredCapabilities: options.requiredCapabilities,
    expectedOperations: options.expectedOperations,
    timeBudgetMs: options.timeBudgetMs,
  };
}

function colorFor(seed: string, label: string): string {
  return `#${sha256(`${seed}:${label}`).slice(0, 6)}`;
}

function rgbFromHex(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function fixtureAssets(
  scenarioId: PerformanceScenarioId,
  seed: string,
  count: number,
  firstMarkerColor?: string,
): PerformanceFixtureAsset[] {
  return Array.from({ length: count }, (_, index) => {
    const content = pngColorCard(seed, `image:${index}`, index === 0 ? firstMarkerColor : undefined).toString("base64");
    return makeAsset(
      `synthetic-image-${scenarioId.toLowerCase()}-${seedTag(seed)}-${String(index + 1).padStart(3, "0")}`,
      "synthetic-image",
      "image/png",
      `synthetic-image-${scenarioId.toLowerCase()}-${String(index + 1).padStart(3, "0")}.png`,
      content,
      "base64",
    );
  });
}

function markerAsset(
  scenarioId: "H01" | "H02" | "P01",
  seed: string,
  role: string,
  color: string,
): PerformanceFixtureAsset {
  const assetId = `synthetic-${scenarioId.toLowerCase()}-${role}-${seedTag(seed)}`;
  const content = pngColorCard(seed, role, color).toString("base64");
  return makeAsset(
    assetId,
    "synthetic-image",
    "image/png",
    `${assetId}.png`,
    content,
    "base64",
  );
}

function markerProject(
  scenarioId: "H01" | "H02",
  seed: string,
  asset: PerformanceFixtureAsset,
  fontAsset?: PerformanceFixtureAsset,
): PerformanceFixtureProject {
  const project = makeTimelineProject({
    scenarioId,
    seed,
    imageCount: 1,
    textCount: 0,
    assets: [asset],
    firstMediaDuration: 5,
  });
  return fontAsset ? withSyntheticFontStructure(project, fontAsset) : project;
}

function workspaceRecords(
  project: PerformanceFixtureProject,
  options: {
    readonly nodeTree?: SyntheticNodeTree;
    readonly targetNodeProject?: PerformanceFixtureProject;
    readonly otherNodeProject?: PerformanceFixtureProject;
    readonly nodeSummary?: string;
  } = {},
): { readonly workspaceId: string; readonly records: WorkspaceDatabaseSeedRecords } {
  const workspaceId = `workspace-${project.id.replace(/^performance-/, "")}`;
  const projectRecord: WorkspaceProjectRecordSeed = {
    id: project.id,
    name: project.name,
    defaultWorkspaceId: workspaceId,
    createdAt: project.createdAt,
    modifiedAt: project.modifiedAt,
  };
  const workspaceRecord: WorkspaceRecordSeed = {
    id: workspaceId,
    projectId: project.id,
    name: "Synthetic performance workspace",
    kind: "default",
    baseNodeId: null,
    revision: 0,
    updatedAt: FIXTURE_EPOCH_MS,
    dirty: false,
    project,
  };
  const nodes = (options.nodeTree?.nodes ?? []).map((treeNode, index): WorkspaceNodeRecordSeed => {
    const nodeProject = treeNode.id === options.nodeTree?.targetNodeId
      ? options.targetNodeProject ?? project
      : options.otherNodeProject ?? project;
    return {
      id: treeNode.id,
      projectId: project.id,
      parentNodeId: treeNode.parentId,
      name: `Synthetic Node ${String(index + 1).padStart(4, "0")}`,
      summary: options.nodeSummary ?? "Fixed small synthetic snapshot",
      createdAt: FIXTURE_EPOCH_MS + index + 1,
      formatVersion: 1,
      project: nodeProject,
      mediaIds: nodeProject.mediaLibrary.items.map((item) => item.id).sort(),
      missingDependencies: [],
    };
  });
  const nodeSummaries = nodes.map(({ project: _project, ...summary }) => summary);
  return {
    workspaceId,
    records: {
      projects: [projectRecord],
      workspaces: [workspaceRecord],
      nodes,
      nodeSummaries,
    },
  };
}

function targetForProject(
  project: PerformanceFixtureProject,
  markerColor: string,
  targetNodeId?: string,
): Pick<PerformanceFixture,
  "projectId" | "targetNodeId" | "targetMediaClipId" | "targetTextClipId" | "targetMarker"
> {
  return {
    projectId: project.id,
    ...(targetNodeId ? { targetNodeId } : {}),
    targetMediaClipId: project.timeline.tracks
      .find((track) => track.type === "image")?.clips[0]?.id,
    targetTextClipId: project.textClips?.[0]?.id,
    targetMarker: { rgb: rgbFromHex(markerColor), probe: { x: 0.5, y: 0.5 } },
  };
}

function createT01(seed: string): PerformanceFixture {
  const markerColor = colorFor(seed, "T01-target");
  const assets = fixtureAssets("T01", seed, 25, markerColor);
  const project = makeTimelineProject({
    scenarioId: "T01",
    seed,
    imageCount: 25,
    textCount: 25,
    assets,
    firstMediaDuration: 5,
    firstTextDuration: 5,
  });
  const target = targetForProject(project, markerColor);
  const { workspaceId, records } = workspaceRecords(project);
  return {
    project,
    ...target,
    workspaceId,
    records,
    assets,
    manifest: baseManifest({
      scenarioId: "T01",
      seed,
      parameters: {
        clipCount: 50,
        imageClipCount: 25,
        textClipCount: 25,
        trackCount: 2,
        operationCount: 100,
        targetMediaClipId: target.targetMediaClipId!,
        targetTextClipId: target.targetTextClipId!,
        targetMarkerRgb: target.targetMarker!.rgb.join(","),
      },
      expectedSemantics: [
        "The project contains exactly 50 deterministic image and text clips.",
        "The first image and text clips start at time 0 and each remain visible for at least 5 seconds.",
        "Remaining timeline clips start at or after 6 seconds, so the target frame stays visible for the 5-second probe window.",
        "A completed media move/trim/seek leaves the selected clip at the requested state.",
      ],
      assets,
      requiredCapabilities: ["workspace-db-v3", "synthetic-image-media", "timeline-text-clips"],
      expectedOperations: 100,
      timeBudgetMs: 60_000,
    }),
  };
}

function createT03(seed: string, parameters: Readonly<Record<string, FixtureParameter>>): PerformanceFixture {
  assertOnlyParameters("T03", parameters, ["clipCount", "trackCount"]);
  const clipCount = parameterChoice(parameters, "clipCount", 500, [500, 2000] as const);
  const trackCount = parameterChoice(parameters, "trackCount", 20, [20, 50] as const);
  // Keep media bytes fixed while scaling timeline geometry and subscriptions.
  const base = createT01(seed);
  const imageAsset = base.assets[0]!;
  const imageTrackIds = Array.from({ length: trackCount - 1 }, (_, index) => `scale-image-track-${index}`);
  const clipsPerTrack = Math.floor((clipCount - 1) / imageTrackIds.length);
  const extraClips = (clipCount - 1) % imageTrackIds.length;
  const tracks = imageTrackIds.map((id, trackIndex) => makeTrack(id, "image",
    Array.from({ length: clipsPerTrack + (trackIndex < extraClips ? 1 : 0) }, (_, index) => ({
      ...makeImageClip(index, imageAsset.assetId, id, 5),
      id: `scale-clip-${trackIndex}-${index}`,
      // Only the target occupies the marker's warmup interval.
      startTime: trackIndex === 0 && index === 0 ? 0 : 6 + index * 1.25,
    }))));
  const textTrack = makeTrack("scale-text-track", "text", []);
  const text = { ...base.project!.textClips![0]!, trackId: textTrack.id };
  const project: PerformanceFixtureProject = {
    ...base.project!, id: `performance-t03-${seedTag(seed)}`, name: "Synthetic performance fixture T03",
    mediaLibrary: { items: [base.project!.mediaLibrary.items[0]!] },
    timeline: { ...base.project!.timeline, tracks: [...tracks, textTrack], duration: 6 + Math.ceil(clipCount / imageTrackIds.length) * 1.25 },
    textClips: [text],
  };
  const target = targetForProject(project, colorFor(seed, "T01-target"));
  const { workspaceId, records } = workspaceRecords(project);
  return {
    project, ...target, workspaceId, records, assets: [imageAsset],
    manifest: baseManifest({
      scenarioId: "T03", seed, parameters: { clipCount, trackCount, imageClipCount: clipCount - 1, textClipCount: 1, independentMediaCount: 1 },
      expectedSemantics: ["Scale only timeline clip and track counts with fixed synthetic media.", "Real pointer input hits the stable target and commits exactly one revision; wheel input changes the visible scroll region."],
      assets: [imageAsset], requiredCapabilities: ["workspace-db-v3", "synthetic-image-media", "timeline-text-clips"], expectedOperations: 100, timeBudgetMs: 120_000,
    }),
  };
}

function createT02(
  seed: string,
  parameters: Readonly<Record<string, FixtureParameter>>,
): PerformanceFixture {
  assertOnlyParameters("T02", parameters, ["clipCount", "fontPayloadMiB"]);
  const clipCount = parameterNumber(parameters, "clipCount", 40);
  if (clipCount < 35 || clipCount > 50) {
    throw new RangeError("T02 clipCount must be between 35 and 50");
  }
  const fontPayloadMiB = parameterChoice(parameters, "fontPayloadMiB", 32, [32, 64] as const);
  const markerColor = colorFor(seed, "T02-target");
  const imageCount = Math.ceil(clipCount / 2);
  const imageAssets = fixtureAssets("T02", seed, imageCount, markerColor);
  const fontAsset = createSyntheticFontStructure(seed, fontPayloadMiB);
  const assets = [...imageAssets, fontAsset];
  const project = withSyntheticFontStructure(makeTimelineProject({
    scenarioId: "T02",
    seed,
    imageCount,
    textCount: clipCount - imageCount,
    assets: imageAssets,
    firstMediaDuration: 5,
    firstTextDuration: 5,
  }), fontAsset);
  const target = targetForProject(project, markerColor);
  const { workspaceId, records } = workspaceRecords(project);
  return {
    project,
    ...target,
    workspaceId,
    records,
    assets,
    manifest: baseManifest({
      scenarioId: "T02",
      seed,
      parameters: {
        clipCount,
        imageClipCount: imageCount,
        textClipCount: clipCount - imageCount,
        fontPayloadMiB,
        fontDataUrlUtf8Bytes: fontAsset.byteLength,
        fontPayloadLocation: "performanceFixture.syntheticFontStructure.dataUrlStructure",
        fontDecodeSupported: false,
        targetMediaClipId: target.targetMediaClipId!,
        targetTextClipId: target.targetTextClipId!,
        targetMarkerRgb: target.targetMarker!.rgb.join(","),
      },
      expectedSemantics: [
        `The project contains ${clipCount} deterministic image and text clips.`,
        "The first image and text clips start at time 0 and each remain visible for at least 5 seconds.",
        "Remaining timeline clips start at or after 6 seconds, so the target frame stays visible for the 5-second probe window.",
        "The test-only structure extension carries a data:font/woff2-shaped string; it is never passed through renderFonts or FontFace.",
        "Image and text gesture runs are measured separately; the fixture makes no real-font decode claim.",
      ],
      assets,
      requiredCapabilities: ["workspace-db-v3", "synthetic-image-media", "timeline-text-clips", "font-structure-storage"],
      expectedOperations: 2,
      timeBudgetMs: 120_000,
    }),
  };
}

function createH01(
  seed: string,
  parameters: Readonly<Record<string, FixtureParameter>>,
): PerformanceFixture {
  assertOnlyParameters("H01", parameters, ["nodeCount"]);
  const nodeCount = parameterChoice(parameters, "nodeCount", 100, [10, 100, 1000] as const);
  const nodeTree = createNodeTree(seed, nodeCount);
  const currentColor = "#d24b4b";
  const nodeColor = "#4666cc";
  const targetColor = "#21a675";
  const currentAsset = markerAsset("H01", seed, "workspace-current", currentColor);
  const nodeAsset = markerAsset("H01", seed, "node-snapshot", nodeColor);
  const targetAsset = markerAsset("H01", seed, "node-target", targetColor);
  const assets = [currentAsset, nodeAsset, targetAsset];
  const project = markerProject("H01", seed, currentAsset);
  const targetNodeProject = markerProject("H01", seed, targetAsset);
  const otherNodeProject = markerProject("H01", seed, nodeAsset);
  const { workspaceId, records } = workspaceRecords(project, {
    nodeTree,
    targetNodeProject,
    otherNodeProject,
  });
  const target = targetForProject(targetNodeProject, targetColor, nodeTree.targetNodeId);
  return {
    project,
    nodeTree,
    ...target,
    workspaceId,
    records,
    assets,
    manifest: baseManifest({
      scenarioId: "H01",
      seed,
      parameters: {
        nodeCount,
        snapshotKind: "fixed-small-scalar",
        branchWidth: 4,
        targetNodeId: nodeTree.targetNodeId,
        targetMediaClipId: target.targetMediaClipId!,
        targetMarkerRgb: target.targetMarker!.rgb.join(","),
        targetProbeX: 0.5,
        targetProbeY: 0.5,
      },
      expectedSemantics: [
        `The deterministic tree contains exactly ${nodeCount} nodes with fixed small snapshots.`,
        "The target node ID is stable for a given seed and can be opened without prewalking the tree inside the measured window.",
        "The opened target node renders a solid marker distinct from the workspace's current frame.",
      ],
      assets,
      requiredCapabilities: ["workspace-db-v3", "node-tree-snapshot", "stable-node-target", "synthetic-image-media"],
      expectedOperations: 2,
      timeBudgetMs: 30_000,
    }),
  };
}

function createH02(
  seed: string,
  parameters: Readonly<Record<string, FixtureParameter>>,
): PerformanceFixture {
  assertOnlyParameters("H02", parameters, ["fontPayloadMiB"]);
  const fontPayloadMiB = parameterChoice(parameters, "fontPayloadMiB", 32, [32, 64] as const);
  const fontAsset = createSyntheticFontStructure(seed, fontPayloadMiB);
  const nodeTree = createNodeTree(seed, 1);
  const currentColor = "#d24b4b";
  const targetColor = "#21a675";
  const currentAsset = markerAsset("H02", seed, "workspace-current", currentColor);
  const targetAsset = markerAsset("H02", seed, "node-target", targetColor);
  const project = markerProject("H02", seed, currentAsset);
  const targetNodeProject = markerProject("H02", seed, targetAsset, fontAsset);
  const root: SyntheticNodeSnapshot = {
    ...nodeTree.nodes[0]!,
    snapshot: {
      ...nodeTree.nodes[0]!.snapshot,
      // This is a storage payload only; it is not passed to a FontFace decoder.
      fontStructure: {
        assetId: fontAsset.assetId,
        byteLength: fontAsset.byteLength,
        sha256: fontAsset.sha256,
        fontFaceDecodeSupported: false,
      },
    },
  };
  const targetNodeTree = { ...nodeTree, nodes: [root] };
  const assets = [currentAsset, targetAsset, fontAsset];
  const { workspaceId, records } = workspaceRecords(project, {
    nodeTree: targetNodeTree,
    targetNodeProject,
    nodeSummary: "One node with opaque synthetic font structure",
  });
  const target = targetForProject(targetNodeProject, targetColor, targetNodeTree.targetNodeId);
  return {
    project,
    nodeTree: targetNodeTree,
    ...target,
    workspaceId,
    records,
    assets,
    manifest: baseManifest({
      scenarioId: "H02",
      seed,
      parameters: {
        nodeCount: 1,
        fontPayloadMiB,
        fontDataUrlUtf8Bytes: fontAsset.byteLength,
        fontPayloadLocation: "performanceFixture.syntheticFontStructure.dataUrlStructure",
        fontDecodeSupported: false,
        targetNodeId: target.targetNodeId!,
        targetMediaClipId: target.targetMediaClipId!,
        targetMarkerRgb: target.targetMarker!.rgb.join(","),
        targetProbeX: 0.5,
        targetProbeY: 0.5,
      },
      expectedSemantics: [
        "The cold-node fixture references one large synthetic font structure payload.",
        "The payload lives in the test-only project extension and bypasses renderFonts and FontFace.",
        "The payload is opaque storage data and does not prove browser font loading or preview decode.",
        "The target node renders a solid marker distinct from the workspace's current frame.",
      ],
      assets,
      requiredCapabilities: ["workspace-db-v3", "node-tree-snapshot", "font-structure-storage", "synthetic-image-media"],
      expectedOperations: 2,
      timeBudgetMs: 60_000,
    }),
  };
}

function createP01(seed: string): PerformanceFixture {
  const markerColor = colorFor(seed, "P01-target");
  const targetImage = fixtureAssets("P01", seed, 1, markerColor)[0]!;
  const targetRgb = rgbFromHex(markerColor);
  const controlRgb = targetRgb.map((channel) => channel ^ 0x80) as [number, number, number];
  const controlColor = `#${controlRgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const controlImage = markerAsset("P01", seed, "control", controlColor);
  const assets = [targetImage, controlImage];
  const baseProject = makeTimelineProject({
    scenarioId: "P01",
    seed,
    imageCount: 2,
    textCount: 1,
    assets,
    firstMediaDuration: 1,
    firstTextDuration: 1,
  });
  const project: PerformanceFixtureProject = {
    ...baseProject,
    timeline: {
      ...baseProject.timeline,
      tracks: baseProject.timeline.tracks.map((track) => track.type === "image"
        ? {
          ...track,
          clips: track.clips.map((clip, index) => index === 1
            ? { ...clip, startTime: 6, duration: 1, inPoint: 0, outPoint: 1 }
            : clip),
        }
        : track),
    },
  };
  const target = targetForProject(project, markerColor);
  const controlMarker: FixtureTargetMarker = { rgb: controlRgb, probe: { x: 0.5, y: 0.5 } };
  const controlMediaClipId = project.timeline.tracks.find((track) => track.type === "image")!.clips[1]!.id;
  const { workspaceId, records } = workspaceRecords(project);
  const clipId = project.timeline.tracks[0]!.clips[0]!.id;
  const gesturePlan: PerformanceGesturePlan = {
    clipId,
    steps: [
      { kind: "move", startTime: 2 },
      { kind: "trim", duration: 1.5 },
      { kind: "move", startTime: 4 },
    ],
    expectedDurableState: { startTime: 4, duration: 1.5 },
  };
  return {
    project,
    ...target,
    controlMediaClipId,
    controlMarker,
    workspaceId,
    records,
    assets,
    gesturePlan,
    manifest: baseManifest({
      scenarioId: "P01",
      seed,
      parameters: {
        clipCount: 3,
        imageClipCount: 2,
        textClipCount: 1,
        gestureSteps: 3,
        saveFlushes: 1,
        relaunchReadbacks: 1,
        targetMediaClipId: target.targetMediaClipId!,
        controlMediaClipId,
        targetTextClipId: target.targetTextClipId!,
        targetMarkerRgb: target.targetMarker!.rgb.join(","),
        controlMarkerRgb: controlMarker.rgb.join(","),
      },
      expectedSemantics: [
        "The project has a target image clip at time 0 and a separate control image clip at time 6, each lasting 1 second.",
        "The target and control cards have distinct center markers so both seeks verify known content without assuming a blank gap clears the canvas.",
        "All three pointer gestures complete before one explicit save flush.",
        "An isolated relaunch reads the final clip start time and duration from durable storage.",
      ],
      assets,
      requiredCapabilities: ["workspace-db-v3", "synthetic-image-media", "save-flush", "isolated-relaunch"],
      expectedOperations: 5,
      timeBudgetMs: 30_000,
    }),
  };
}

/**
 * Builds the deterministic data contract for a P2 scenario. It performs no
 * filesystem writes; call `materializePerformanceFixtureAssets` with a path
 * inside the e2e harness's temporary run directory before launching Electron.
 */
export function createPerformanceFixture(request: PerformanceFixtureRequest): PerformanceFixture {
  if (request.seed.length === 0 || request.seed.length > 128) {
    throw new RangeError("fixture seed must contain 1–128 characters");
  }
  const parameters = request.parameters ?? {};
  if (request.scenarioId === "T01" || request.scenarioId === "P01") {
    assertOnlyParameters(request.scenarioId, parameters, []);
  }
  switch (request.scenarioId) {
    case "T01":
      return createT01(request.seed);
    case "T02":
      return createT02(request.seed, parameters);
    case "T03":
      return createT03(request.seed, parameters);
    case "H01":
      return createH01(request.seed, parameters);
    case "H02":
      return createH02(request.seed, parameters);
    case "P01":
      return createP01(request.seed);
  }
}

/**
 * Writes fixture assets only beneath the system temp directory. Keep this
 * call before `launchApp` so asset generation and IO stay outside timing data.
 */
export async function materializePerformanceFixtureAssets(
  fixture: PerformanceFixture,
  directory: string,
): Promise<Readonly<Record<string, string>>> {
  const targetDirectory = path.resolve(directory);
  const relativeToTemp = path.relative(path.resolve(tmpdir()), targetDirectory);
  if (relativeToTemp === ".." || relativeToTemp.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTemp)) {
    throw new RangeError("performance fixture assets must be written beneath the system temp directory");
  }
  await mkdir(targetDirectory, { recursive: true });
  const paths: Record<string, string> = {};
  for (const asset of fixture.assets) {
    const assetPath = path.join(targetDirectory, asset.fileName);
    const content = asset.encoding === "base64" ? Buffer.from(asset.content, "base64") : asset.content;
    await writeFile(assetPath, content, { flag: "wx" });
    paths[asset.assetId] = assetPath;
  }
  return paths;
}

/** True only when a declared font structure asset contains a real WOFF2 signature. */
export function hasWoff2Signature(asset: PerformanceFixtureAsset): boolean {
  if (asset.kind !== "synthetic-font-structure") return false;
  const encoded = asset.content.slice(FONT_DATA_URL_PREFIX.length, FONT_DATA_URL_PREFIX.length + 8);
  const decodedHeader = Buffer.from(encoded, "base64").subarray(0, EXPECTED_FONT_FACE_HEADER.length);
  return decodedHeader.equals(EXPECTED_FONT_FACE_HEADER);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/** Stable SHA-256 identity for the exact fixture manifest and its ordered assets. */
export function performanceFixtureManifestSha256(
  manifest: PerformanceFixtureManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(manifest)), "utf8")
    .digest("hex");
}
