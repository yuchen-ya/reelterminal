import type { MediaMetadata, Project } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import { saveMediaBlob } from "./media-storage";
import type { WorkspaceManager } from "./workspace-manager";

/**
 * Deterministic fixtures for the phase-4 performance baselines
 * (changesets 07–10). Every value is derived from fixed constants so
 * repeated runs measure the same data: three projects, two workspaces and
 * two saved nodes per project, a media library mixing trusted-hash items,
 * legacy items without a hash, and one placeholder, plus one font family
 * referenced from a text clip. Speed-keyframe clips live in the core-side
 * fixture (packages/core/src/video/speed-engine.perf.test.ts) because the
 * speed integral hot path never touches workspace persistence.
 */

export const PERF_PROJECT_COUNT = 3;
const BASE_TIMESTAMP = 1_700_000_000_000;

/** Deterministic LCG bytes so media hashes are stable across runs. */
export function perfMediaBytes(seed: number, sizeBytes: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(sizeBytes));
  let state = (seed * 2654435761) >>> 0;
  for (let i = 0; i < sizeBytes; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

export interface PerfMediaSpec {
  readonly id: string;
  readonly type: "video" | "audio" | "image";
  readonly sizeBytes: number;
  /** When false the library item omits contentHash (legacy-item baseline). */
  readonly trustedHash: boolean;
  readonly placeholder: boolean;
}

export interface PerfProjectSeed {
  readonly projectId: string;
  readonly project: Project;
  readonly mediaBlobs: readonly { id: string; blob: Blob; metadata: MediaMetadata }[];
  readonly fontFamily: string;
}

export interface PerfLibraryHandle {
  readonly projects: readonly {
    readonly projectId: string;
    readonly defaultWorkspaceId: string;
    readonly extraWorkspaceId: string;
    readonly nodeIds: readonly string[];
    readonly mediaIds: readonly string[];
    readonly fontFamily: string;
  }[];
}

function perfMediaMetadata(sizeBytes: number, type: "video" | "audio" | "image"): MediaMetadata {
  return {
    duration: type === "image" ? 0 : 10,
    width: 1920,
    height: 1080,
    frameRate: 30,
    codec: type === "image" ? "" : "avc1",
    sampleRate: type === "video" ? 0 : 48000,
    channels: type === "video" ? 0 : 2,
    fileSize: sizeBytes,
  };
}

function perfMediaSpecs(index: number): PerfMediaSpec[] {
  return [
    { id: `perf-media-${index}-0`, type: "video", sizeBytes: 96 * 1024, trustedHash: true, placeholder: false },
    { id: `perf-media-${index}-1`, type: "audio", sizeBytes: 64 * 1024, trustedHash: true, placeholder: false },
    { id: `perf-media-${index}-2`, type: "image", sizeBytes: 48 * 1024, trustedHash: true, placeholder: false },
    { id: `perf-media-${index}-3`, type: "video", sizeBytes: 32 * 1024, trustedHash: false, placeholder: false },
    { id: `perf-media-${index}-4`, type: "image", sizeBytes: 32 * 1024, trustedHash: false, placeholder: false },
    { id: `perf-media-${index}-5`, type: "image", sizeBytes: 0, trustedHash: false, placeholder: true },
  ];
}

function mimeType(type: PerfMediaSpec["type"]): string {
  if (type === "video") return "video/mp4";
  if (type === "audio") return "audio/wav";
  return "image/png";
}

/**
 * Builds the fixed project for `index`. `storedHashes` maps media ids to
 * the content hash of the already-stored bytes; items flagged trustedHash
 * carry that hash on the library item, legacy items omit it.
 */
export function createPerfProjectSeed(index: number, storedHashes: ReadonlyMap<string, string>): PerfProjectSeed {
  const projectId = `perf-project-${index}`;
  const specs = perfMediaSpecs(index);
  const fontFamily = `PerfFont-${index}`;
  const base = createEmptyProject(`Perf Project ${index}`);
  const project: Project = {
    ...base,
    id: projectId,
    name: `Perf Project ${index}`,
    createdAt: BASE_TIMESTAMP + index,
    modifiedAt: BASE_TIMESTAMP + index,
    mediaLibrary: {
      items: specs.map((spec) => ({
        id: spec.id,
        name: spec.id,
        type: spec.type,
        fileHandle: null,
        blob: spec.placeholder ? null : new Blob(
          [perfMediaBytes(index * 16 + Number(spec.id.slice(-1)), spec.sizeBytes)],
          { type: mimeType(spec.type) },
        ),
        metadata: perfMediaMetadata(spec.sizeBytes, spec.type),
        thumbnailUrl: null,
        waveformData: null,
        ...(spec.placeholder ? { isPlaceholder: true } : {}),
        ...(spec.trustedHash && storedHashes.has(spec.id) ? { contentHash: storedHashes.get(spec.id)! } : {}),
      })),
    },
    textClips: [{ style: { fontFamily } }] as unknown as Project["textClips"],
    renderFonts: [{
      family: fontFamily,
      style: "normal",
      weight: "400",
      dataUrl: "data:font/woff2;base64,AA==",
    }],
  };
  return {
    projectId,
    project,
    mediaBlobs: specs
      .filter((spec) => !spec.placeholder)
      .map((spec) => ({
        id: spec.id,
        blob: project.mediaLibrary.items.find((item) => item.id === spec.id)!.blob!,
        metadata: perfMediaMetadata(spec.sizeBytes, spec.type),
      })),
    fontFamily,
  };
}

/**
 * Seeds the fixed library into `manager` (call on a fresh WorkspaceManager
 * over a fresh fake-indexeddb factory). Media bytes are durably stored via
 * saveMediaBlob so archive checks and runtime hydration observe real
 * records; trusted items carry the hash of the stored bytes.
 */
export async function seedPerfLibrary(manager: WorkspaceManager): Promise<PerfLibraryHandle> {
  const projects: PerfLibraryHandle["projects"][number][] = [];
  for (let index = 0; index < PERF_PROJECT_COUNT; index++) {
    const preliminary = createPerfProjectSeed(index, new Map());
    const storedHashes = new Map<string, string>();
    for (const item of preliminary.mediaBlobs) {
      const saved = await saveMediaBlob(preliminary.projectId, item.id, item.blob, item.metadata);
      storedHashes.set(item.id, saved.contentHash);
    }
    const seed = createPerfProjectSeed(index, storedHashes);
    const created = await manager.createProject(seed.project, {
      idempotencyKey: `perf-create-${index}`,
      requestPayload: { name: seed.project.name, settings: seed.project.settings },
    });
    const target = { projectId: seed.projectId, workspaceId: created.defaultWorkspaceId };
    const firstNode = await manager.saveNode({
      target,
      name: `Perf node A ${index}`,
      idempotencyKey: `perf-node-a-${index}`,
    });
    const context = await manager.getWorkspaceContext(target);
    context.store.setState({
      project: {
        ...context.store.getState().project,
        name: `Perf Project ${index} edited`,
        modifiedAt: BASE_TIMESTAMP + 100 + index,
      },
    });
    const secondNode = await manager.saveNode({
      target,
      name: `Perf node B ${index}`,
      idempotencyKey: `perf-node-b-${index}`,
    });
    const extra = await manager.createWorkspace(seed.projectId, {
      name: `Perf extra ${index}`,
      sourceNodeId: firstNode.node.id,
    });
    projects.push({
      projectId: seed.projectId,
      defaultWorkspaceId: created.defaultWorkspaceId,
      extraWorkspaceId: extra.id,
      nodeIds: [firstNode.node.id, secondNode.node.id],
      mediaIds: seed.mediaBlobs.map((item) => item.id),
      fontFamily: seed.fontFamily,
    });
  }
  return { projects };
}
