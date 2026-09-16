import { describe, expect, it } from "vitest";
import { captureWorkAssetFromClip } from "./capture";
import { ActionExecutor } from "../actions/action-executor";
import { ActionValidator } from "../actions/action-validator";
import type { Clip, Track } from "../types/timeline";
import type { Project } from "../types";

function makeTrack(id: string, type: Track["type"], clips: Clip[]): Track {
  return {
    id,
    type,
    name: id,
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    mediaId: "m1",
    trackId: "v1",
    startTime: 0,
    duration: 4,
    inPoint: 2,
    outPoint: 6,
    effects: [
      { id: "e1", type: "brightness", params: { level: 1.2 }, enabled: true },
    ],
    audioEffects: [],
    transform: {
      position: { x: 10, y: -4 },
      scale: { x: 1.5, y: 1.5 },
      rotation: 12,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 0.9,
    },
    volume: 0.8,
    keyframes: [],
    speed: 2,
    reversed: true,
    stabilization: {
      enabled: true,
      strength: 0.5,
      cropMode: "auto",
      analyzed: true,
      analysisVersion: 3,
      profile: { transforms: [] } as never,
    },
    ...overrides,
  } as Clip;
}

function makeProject(overrides: {
  clips?: Clip[];
  mediaItems?: Partial<Project["mediaLibrary"]["items"][number]>[];
} = {}): Project {
  const clips = overrides.clips ?? [makeClip()];
  const mediaItems = (overrides.mediaItems ?? [{}]).map((patch, index) => ({
    id: `m${index + 1}`,
    name: "take-01.mp4",
    displayName: "Take 01",
    type: "video" as const,
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 30,
      width: 1920,
      height: 1080,
      frameRate: 30,
      codec: "h264",
      sampleRate: 48000,
      channels: 2,
      fileSize: 1024,
    },
    thumbnailUrl: null,
    waveformData: null,
    ...patch,
  }));
  return {
    id: "p1",
    name: "Test",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: { duration: 4, tracks: [makeTrack("v1", "video", clips)] },
    mediaLibrary: { items: mediaItems },
  } as unknown as Project;
}

describe("captureWorkAssetFromClip", () => {
  it("snapshots trimmed, sped, effected clip parameters and derives the source range", () => {
    const project = makeProject();
    const result = captureWorkAssetFromClip(project, "c1", {
      assetId: "wa-1",
      name: "Hero trim",
      now: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.asset;
    expect(asset.schemaVersion).toBe(1);
    expect(asset.kind).toBe("single");
    expect(asset.id).toBe("wa-1");
    expect(asset.name).toBe("Hero trim");
    expect(asset.sourceMediaId).toBe("m1");
    expect(asset.sourceRange).toEqual({ inSec: 2, outSec: 6 });
    expect(asset.createdAt).toBe(1000);
    expect(asset.updatedAt).toBe(1000);
    expect(asset.clipSnapshot).toMatchObject({
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      speed: 2,
      reversed: true,
      volume: 0.8,
    });
    expect(asset.clipSnapshot?.effects).toEqual([
      { id: "e1", type: "brightness", params: { level: 1.2 }, enabled: true },
    ]);
    expect(asset.clipSnapshot?.transform).toMatchObject({
      rotation: 12,
      opacity: 0.9,
    });
  });

  it("declares stripped analysis artifacts and instance-local metadata instead of dropping them silently", () => {
    const project = makeProject({
      clips: [makeClip({ metadata: { some: "provenance" } as never })],
    });
    const result = captureWorkAssetFromClip(project, "c1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = result.asset.unsupportedParams.map((p) => p.field);
    expect(fields).toEqual([
      "stabilization.analyzed",
      "stabilization.analysisVersion",
      "stabilization.profile",
      "metadata",
    ]);
    for (const entry of result.asset.unsupportedParams) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    // The kept stabilization tuning survives without its artifacts.
    expect(result.asset.clipSnapshot?.stabilization).toEqual({
      enabled: true,
      strength: 0.5,
      cropMode: "auto",
    });
  });

  it("reports no unsupported params for a plain clip", () => {
    const project = makeProject({
      clips: [
        makeClip({
          speed: undefined,
          reversed: undefined,
          stabilization: undefined,
        }),
      ],
    });
    const result = captureWorkAssetFromClip(project, "c1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.unsupportedParams).toEqual([]);
    expect(result.asset.clipSnapshot?.stabilization).toBeUndefined();
  });

  it("derives the default name from the media display name and range", () => {
    const result = captureWorkAssetFromClip(makeProject(), "c1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.name).toBe("Take 01 (2s-6s)");
  });

  it("rejects unknown clips, virtual overlays, missing media, and placeholders without producing an entry", () => {
    expect(captureWorkAssetFromClip(makeProject(), "nope")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const virtual = makeProject({
      clips: [makeClip({ mediaId: "sticker-abc" })],
    });
    expect(captureWorkAssetFromClip(virtual, "c1")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED",
    });
    const missingMedia = makeProject({ mediaItems: [] });
    expect(captureWorkAssetFromClip(missingMedia, "c1")).toMatchObject({
      ok: false,
      code: "MEDIA_NOT_FOUND",
    });
    const placeholder = makeProject({
      mediaItems: [{ isPlaceholder: true }],
    });
    expect(captureWorkAssetFromClip(placeholder, "c1")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED",
    });
  });

  it("rejects degenerate ranges and empty names", () => {
    const inverted = makeProject({
      clips: [makeClip({ inPoint: 6, outPoint: 2 })],
    });
    expect(captureWorkAssetFromClip(inverted, "c1")).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(
      captureWorkAssetFromClip(makeProject(), "c1", { name: "   " }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("clamps over-long names to the persisted 200-character cap", () => {
    const result = captureWorkAssetFromClip(makeProject(), "c1", {
      name: "x".repeat(250),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.name).toHaveLength(200);
  });

  it("returns a snapshot decoupled from the live clip", () => {
    const clip = makeClip();
    const project = makeProject({ clips: [clip] });
    const result = captureWorkAssetFromClip(project, "c1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (result.asset.clipSnapshot!.effects[0].params as { level?: number }).level =
      99;
    expect(clip.effects[0].params.level).toBe(1.2);
  });

  it("feeds the core validator and executor without modification", async () => {
    const project = makeProject();
    const captured = captureWorkAssetFromClip(project, "c1", {
      captureRequestId: "req-1",
      createdBy: "agent",
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const asset = captured.asset;
    expect(asset.captureRequestId).toBe("req-1");
    expect(asset.createdBy).toBe("agent");

    const validator = new ActionValidator();
    const errors = validator.validate(
      {
        type: "workAsset/create",
        id: "a1",
        timestamp: 0,
        params: { asset },
      },
      project,
    );
    expect(errors.valid).toBe(true);
    expect(errors.errors).toEqual([]);

    const executor = new ActionExecutor();
    const result = await executor.execute(
      {
        type: "workAsset/create",
        id: "a1",
        timestamp: 0,
        params: { asset },
      },
      project,
    );
    expect(result.success).toBe(true);
    expect(project.workAssets).toHaveLength(1);
    expect(project.workAssets![0].name).toBe("Take 01 (2s-6s)");
  });
});
