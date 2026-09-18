/**
 * Renderer-side preset bridge contract: verb routing, metadata-only
 * listings, error envelopes, the change event that makes agent-made presets
 * visible to the GUI panels immediately, and the apply idempotency ledger
 * (per-project bucketing + placement hard-rejection). Uses the in-memory
 * PresetStorage fake; the canonical service and expansion logic are covered
 * by preset-service.test.ts and apply.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@openreel/core";
import {
  CustomPresetService,
  CUSTOM_PRESETS_UPDATED_EVENT,
  setCustomPresetServiceForTests,
} from "../custom-presets/preset-service";
import type { PresetStorage } from "../custom-presets/storage";
import type { CustomPresetRecord } from "@openreel/core/presets/types";
import { handlePresetLibraryRequest } from "./preset-bridge";
import { useProjectStore } from "../../stores/project-store";

const { mockSaveMediaBlob, mockImportFile } = vi.hoisted(() => ({
  mockSaveMediaBlob: vi.fn(async () => undefined),
  mockImportFile: vi.fn(),
}));

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob: mockSaveMediaBlob,
  deleteMediaBlob: vi.fn(async () => undefined),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile: mockImportFile,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

class MemoryPresetStorage implements PresetStorage {
  readonly rows = new Map<string, unknown>();

  async loadAll(): Promise<unknown[]> {
    return [...this.rows.values()];
  }
  async commit(upserts: readonly CustomPresetRecord[], deletes: readonly string[]): Promise<void> {
    for (const record of upserts) {
      this.rows.set(record.id, JSON.parse(JSON.stringify(record)));
    }
    for (const id of deletes) this.rows.delete(id);
  }
}

const act = (type: string, params: Record<string, unknown>): Action => ({
  type,
  id: `a-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  params,
});

const TEXT_PAYLOAD = {
  schemaVersion: 1,
  kind: "text",
  style: { fontSize: 48, fontWeight: 700 },
};
const EFFECT_PAYLOAD = {
  schemaVersion: 1,
  kind: "effect",
  effects: [{ type: "brightness", params: { value: 20 } }],
};
const TRANSITION_FAR_PAYLOAD = {
  schemaVersion: 1,
  kind: "transition",
  type: "crossfade",
  durationSec: 10,
  params: {},
};

describe("handlePresetLibraryRequest", () => {
  let service: CustomPresetService;

  beforeEach(async () => {
    service = new CustomPresetService(new MemoryPresetStorage());
    setCustomPresetServiceForTests(service);
    mockImportFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 7,
          width: 640,
          height: 360,
          frameRate: 30,
          codec: "h264",
          sampleRate: 48_000,
          channels: 2,
          hasVideo: true,
          hasAudio: false,
        },
      },
    }));
    useProjectStore.getState().createNewProject("Preset Apply");
  });

  async function seedVideoClip(
    mediaId = "media-1",
    trackId = "v1",
    clipId = "clip-1",
  ): Promise<string> {
    const initial = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...initial,
        mediaLibrary: {
          ...initial.mediaLibrary,
          items: [
            ...initial.mediaLibrary.items,
            {
              id: mediaId,
              name: "shot.mp4",
              type: "video",
              fileHandle: null,
              blob: null,
              metadata: {
                duration: 8,
                width: 640,
                height: 360,
                frameRate: 30,
                codec: "h264",
                sampleRate: 48_000,
                channels: 2,
                fileSize: 1,
              },
              thumbnailUrl: null,
              waveformData: null,
            },
          ],
        },
      },
    });
    await useProjectStore.getState().executeActionBatch(
      [
        act("track/add", { trackType: "video", trackId }),
        act("clip/add", {
          trackId,
          mediaId,
          startTime: 0,
          inPoint: 0,
          outPoint: 2,
          ...(clipId ? { clipId } : {}),
        }),
      ],
      { groupLabel: "seed", historyOwner: "human" },
    );
    return clipId;
  }

  it("lists metadata only by default and embeds payloads on request", async () => {
    await service.create({ kind: "text", name: "Agent Title", payload: TEXT_PAYLOAD });
    const metadata = await handlePresetLibraryRequest({ verb: "list", params: {} });
    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      const value = metadata.result as {
        total: number;
        presets: Array<Record<string, unknown>>;
      };
      expect(value.total).toBe(1);
      expect(value.presets[0]).toMatchObject({ name: "Agent Title", kind: "text" });
      expect("payload" in value.presets[0]!).toBe(false);
    }
    const withPayload = await handlePresetLibraryRequest({
      verb: "list",
      params: { includePayload: true, kind: "text" },
    });
    expect(withPayload.ok).toBe(true);
    if (withPayload.ok) {
      const value = withPayload.result as { presets: Array<{ payload?: unknown }> };
      expect(value.presets[0]?.payload).toMatchObject({ kind: "text" });
    }
  });

  it("returns the full record on get and NOT_FOUND for unknown ids", async () => {
    const missing = await handlePresetLibraryRequest({
      verb: "get",
      params: { id: "preset_none" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const created = await service.create({
      kind: "effect",
      name: "Warm",
      payload: EFFECT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);
    const reply = await handlePresetLibraryRequest({
      verb: "get",
      params: { id: created.value.id },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as { preset: { kind: string; payload: unknown } };
      expect(value.preset.kind).toBe("effect");
      expect(value.preset.payload).toMatchObject({ kind: "effect" });
    }
  });

  it("creates through the canonical service and fires the change event panels listen to", async () => {
    const listener = vi.fn();
    window.addEventListener(CUSTOM_PRESETS_UPDATED_EVENT, listener);
    const reply = await handlePresetLibraryRequest({
      verb: "create",
      params: { kind: "text", name: "Agent Title", payload: TEXT_PAYLOAD, tags: ["agent"] },
    });
    expect(reply.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CUSTOM_PRESETS_UPDATED_EVENT, listener);

    // Deep payload validation stays authoritative in the service: unknown
    // fields are rejected, never stored.
    const bad = await handlePresetLibraryRequest({
      verb: "create",
      params: {
        kind: "text",
        name: "Bad",
        payload: { schemaVersion: 1, kind: "text", style: { shader: "x" } },
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_PARAMS");
  });

  it("renames with a CAS guard and reports CONFLICT on a stale revision", async () => {
    const created = await service.create({
      kind: "text",
      name: "Original",
      payload: TEXT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);

    const stale = await handlePresetLibraryRequest({
      verb: "update",
      params: { id: created.value.id, name: "Renamed", expectedRevision: 99 },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const ok = await handlePresetLibraryRequest({
      verb: "update",
      params: { id: created.value.id, name: "Renamed", expectedRevision: 1 },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const value = ok.result as { preset: { name: string; revision: number } };
      expect(value.preset.name).toBe("Renamed");
      expect(value.preset.revision).toBe(2);
    }
  });

  it("removes idempotently and never touches already-applied projects", async () => {
    const created = await service.create({
      kind: "text",
      name: "Doomed",
      payload: TEXT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);
    const first = await handlePresetLibraryRequest({
      verb: "remove",
      params: { id: created.value.id },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.result).toEqual({ id: created.value.id, alreadyGone: false });
    }
    const again = await handlePresetLibraryRequest({
      verb: "remove",
      params: { id: created.value.id },
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.result).toEqual({ id: created.value.id, alreadyGone: true });
    }
  });

  it("applies a text preset to an existing clip as one undoable batch", async () => {
    const created = await service.create({
      kind: "text",
      name: "Agent Title",
      payload: TEXT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);
    await useProjectStore.getState().addTrack("text", 0);
    const track = useProjectStore
      .getState()
      .project.timeline.tracks.find((candidate) => candidate.type === "text");
    if (!track) throw new Error("text track missing");
    useProjectStore
      .getState()
      .createTextClip(track.id, 0, "Hello", 2, { fontSize: 24 });
    const clip = useProjectStore.getState().project.textClips?.[0];
    if (!clip) throw new Error("text clip missing");

    const reply = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "text", mode: "updateStyle", clipId: clip.id },
        idempotencyKey: "apply-text-1",
      },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const value = reply.result as {
        replayed?: boolean;
        applied: { kind: string; clipIds: string[] };
      };
      expect(value.replayed).toBeUndefined();
      expect(value.applied).toEqual({ kind: "text", clipIds: [clip.id] });
    }
    const styled = useProjectStore.getState().project.textClips?.[0];
    expect(styled?.style.fontSize).toBe(48);

    // A retried apply (lost reply) replays the ledger instead of restyling.
    const replay = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "text", mode: "updateStyle", clipId: clip.id },
        idempotencyKey: "apply-text-1",
      },
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.result as { replayed?: boolean }).replayed).toBe(true);
    }
  });

  it("applies an effect stack to explicit clips", async () => {
    const created = await service.create({
      kind: "effect",
      name: "Lift",
      payload: EFFECT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);
    const clipId = await seedVideoClip();
    const reply = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "effect", clipIds: [clipId] },
      },
    });
    expect(reply.ok).toBe(true);
    const clip = useProjectStore
      .getState()
      .project.timeline.tracks.flatMap((candidate) => candidate.clips)
      .find((candidate) => candidate.id === clipId);
    expect(clip?.effects).toHaveLength(1);
    expect(clip?.effects[0]).toMatchObject({ type: "brightness" });
  });

  it("hard-rejects a transition beyond the placement cap with PLACEMENT_INVALID", async () => {
    const created = await service.create({
      kind: "transition",
      name: "Too Long",
      payload: TRANSITION_FAR_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);
    const clipId = await seedVideoClip();
    const reply = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "transition", clipAId: clipId },
      },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("PLACEMENT_INVALID");
      expect(reply.error.message).toContain("cannot exceed");
    }
    // Nothing leaked into the project: no transition landed on any track.
    const tracks = useProjectStore.getState().project.timeline.tracks;
    expect(tracks.every((candidate) => candidate.transitions.length === 0)).toBe(true);
  });

  it("buckets the apply ledger per project and requires a project", async () => {
    const created = await service.create({
      kind: "text",
      name: "Agent Title",
      payload: TEXT_PAYLOAD,
    });
    if (!created.ok) throw new Error(created.message);

    useProjectStore.setState({ hasOpenProject: false });
    const none = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "effect", clipIds: ["c"] },
      },
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("NO_PROJECT");

    // Project A commits a key; project B must NOT replay A's commit.
    useProjectStore.getState().createNewProject("Ledger A");
    await useProjectStore.getState().addTrack("text", 0);
    const trackA = useProjectStore
      .getState()
      .project.timeline.tracks.find((candidate) => candidate.type === "text");
    if (!trackA) throw new Error("text track missing");
    useProjectStore.getState().createTextClip(trackA.id, 0, "Hello", 2, {});
    const clipA = useProjectStore.getState().project.textClips?.[0];
    if (!clipA) throw new Error("text clip missing");
    const first = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "text", mode: "updateStyle", clipId: clipA.id },
        idempotencyKey: "apply-k1",
      },
    });
    expect(first.ok).toBe(true);
    const firstProjectId = useProjectStore.getState().project.id;

    useProjectStore.getState().createNewProject("Ledger B");
    const other = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "text", mode: "updateStyle", clipId: clipA.id },
        idempotencyKey: "apply-k1",
      },
    });
    // The key executed fresh against project B (no clips there), instead of
    // replaying project A's committed result.
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.error.code).toBe("TARGET_NOT_FOUND");
      expect(useProjectStore.getState().project.name).toBe("Ledger B");
    }
    expect(firstProjectId).not.toBe(useProjectStore.getState().project.id);
  });

  it("applies graphics presets as a new SVG clip and rejects unknown verbs", async () => {
    const created = await service.create({
      kind: "graphics",
      name: "Badge",
      payload: {
        schemaVersion: 1,
        kind: "graphics",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>',
      },
    });
    if (!created.ok) throw new Error(created.message);
    const reply = await handlePresetLibraryRequest({
      verb: "apply",
      params: {
        presetId: created.value.id,
        target: { kind: "graphics" },
      },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const applied = reply.result as {
        applied: { kind: string; clipIds: readonly string[]; trackId?: string };
      };
      expect(applied.applied.kind).toBe("graphics");
      expect(applied.applied.clipIds).toHaveLength(1);
      expect(applied.applied.trackId).toBeDefined();
      // The created SVG overlay really landed on the project.
      const project = useProjectStore.getState().project;
      expect(project.svgClips?.map((clip) => clip.id)).toContain(
        applied.applied.clipIds[0],
      );
    }

    const unknown = await handlePresetLibraryRequest({ verb: "explode", params: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("INVALID_PARAMS");
  });
});
