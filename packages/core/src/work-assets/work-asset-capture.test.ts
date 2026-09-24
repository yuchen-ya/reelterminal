import { describe, expect, it } from "vitest";
import {
  captureWorkAssetFromClip,
  captureWorkAssetFromClips,
  captureWorkAssetFromMedia,
} from "./capture";
import { buildWorkAssetInstantiateActions } from "./instantiate";
import { ActionExecutor } from "../actions/action-executor";
import { ActionValidator } from "../actions/action-validator";
import type { Clip, Track, Transition } from "../types/timeline";
import type { Project, WorkAsset } from "../types";

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

/**
 * Multi-clip fixtures: two video tracks + one audio track, one media item per
 * clip. Clips are plain (no speed/stabilization) unless a test opts in, so
 * per-test expectations stay readable.
 */
function makePlainClip(overrides: Partial<Clip> = {}): Clip {
  return makeClip({
    speed: undefined,
    reversed: undefined,
    stabilization: undefined,
    ...overrides,
  } as Partial<Clip>);
}

function makeMultiProject(
  tracks: Track[],
  mediaItems: Array<Partial<Project["mediaLibrary"]["items"][number]>> = [
    {},
    {},
    { type: "audio", name: "song.mp3" },
  ],
): Project {
  const items = mediaItems.map((patch, index) => ({
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
    timeline: { duration: 12, tracks },
    mediaLibrary: { items },
  } as unknown as Project;
}

describe("captureWorkAssetFromClips", () => {
  function twoVideoOneAudio(): {
    project: Project;
    clipV1: Clip;
    clipV2: Clip;
    clipA1: Clip;
  } {
    const clipV1 = makePlainClip({
      id: "cv1",
      mediaId: "m1",
      trackId: "v1",
      startTime: 0,
    });
    const clipA1 = makePlainClip({
      id: "ca1",
      mediaId: "m3",
      trackId: "a1",
      startTime: 1,
      inPoint: 4,
      outPoint: 9,
      duration: 5,
    });
    const clipV2 = makePlainClip({
      id: "cv2",
      mediaId: "m2",
      trackId: "v2",
      startTime: 2.5,
      inPoint: 0,
      outPoint: 3,
      duration: 3,
    });
    const project = makeMultiProject([
      makeTrack("v1", "video", [clipV1]),
      makeTrack("v2", "video", [clipV2]),
      makeTrack("a1", "audio", [clipA1]),
    ]);
    return { project, clipV1, clipV2, clipA1 };
  }

  it("captures a 2V+1A cross-track set with relative layout, lanes, and an anchor", () => {
    const { project } = twoVideoOneAudio();
    const result = captureWorkAssetFromClips(
      project,
      ["cv1", "ca1", "cv2"],
      { assetId: "wa-multi", now: 2000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.asset;
    expect(asset.kind).toBe("multi");
    expect(asset.id).toBe("wa-multi");
    expect(asset.clipSnapshot).toBeUndefined();
    expect(asset.createdAt).toBe(2000);

    // Members are in deterministic startTime order.
    expect(asset.members).toHaveLength(3);
    const [first, second, third] = asset.members!;
    expect(first.mediaId).toBe("m1");
    expect(second.mediaId).toBe("m3");
    expect(third.mediaId).toBe("m2");
    expect(first.relativeStart).toBe(0);
    expect(second.relativeStart).toBe(1);
    expect(third.relativeStart).toBe(2.5);

    // Lanes are relative per type; the anchor's video lane is offset 0.
    expect(first.lane).toEqual({ trackType: "video", laneOffset: 0 });
    expect(second.lane).toEqual({ trackType: "audio", laneOffset: 0 });
    expect(third.lane).toEqual({ trackType: "video", laneOffset: 1 });

    // Anchor member mirrors into the top-level fields (T0 time anchor).
    expect(asset.sourceMediaId).toBe("m1");
    expect(asset.sourceRange).toEqual({ inSec: 2, outSec: 6 });

    // Member snapshots reuse the single-clip structure.
    expect(first.snapshot).toMatchObject({ duration: 4, inPoint: 2, outPoint: 6 });
    expect(second.snapshot).toMatchObject({ duration: 5, inPoint: 4, outPoint: 9 });

    // Member ids are unique and minted with the m- prefix.
    const memberIds = new Set(asset.members!.map((member) => member.memberId));
    expect(memberIds.size).toBe(3);
    for (const id of memberIds) expect(id.startsWith("m-")).toBe(true);
  });

  it("derives the default name from the anchor media with a member count", () => {
    const { project } = twoVideoOneAudio();
    const result = captureWorkAssetFromClips(project, ["cv1", "ca1", "cv2"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.name).toBe("Take 01 composite ×3");
  });

  it("archives inner transitions by member reference and strips edge/outside transitions", () => {
    const clipV1 = makePlainClip({ id: "cv1", mediaId: "m1", trackId: "v1", startTime: 0 });
    const clipV2 = makePlainClip({ id: "cv2", mediaId: "m2", trackId: "v2", startTime: 1 });
    const innerTransition: Transition = {
      id: "t-inner",
      clipAId: "cv1",
      clipBId: "cv2",
      type: "crossfade",
      duration: 0.5,
      params: { easing: "linear" },
    };
    // Same-type tracks (both video) so the inner transition is track-plausible.
    const project = makeMultiProject(
      [
        makeTrack("v1", "video", [clipV1]),
        makeTrack("v2", "video", [clipV2, makePlainClip({ id: "cout", mediaId: "m2", startTime: 9 })]),
      ],
      [{}, {}],
    );
    // Mutate transitions in through the test fixture (tracks are test data).
    const tracks = project.timeline.tracks as unknown as Array<{
      transitions: Transition[];
    }>;
    tracks[1].transitions = [
      innerTransition,
      {
        id: "t-edge",
        clipAId: "cv2",
        edge: "out",
        type: "wipe",
        duration: 0.3,
        params: {},
      },
      {
        id: "t-outside",
        clipAId: "cv2",
        clipBId: "cout",
        type: "wipe",
        duration: 0.4,
        params: {},
      },
    ];

    const result = captureWorkAssetFromClips(project, ["cv1", "cv2"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.asset;

    expect(asset.transitions).toHaveLength(1);
    const [stored] = asset.transitions!;
    // Members are in startTime order: cv1 (0) then cv2 (1).
    expect(stored.fromMemberId).toBe(asset.members![0].memberId);
    expect(stored.toMemberId).toBe(asset.members![1].memberId);
    expect(stored.type).toBe("crossfade");
    expect(stored.duration).toBe(0.5);
    expect(stored.params).toEqual({ easing: "linear" });

    const stripped = asset.unsupportedParams.filter((entry) =>
      entry.field.startsWith("transitions["),
    );
    expect(stripped.map((entry) => entry.field)).toEqual([
      "transitions[cv2→edge:out]",
      "transitions[cv2→cout]",
    ]);
    expect(stripped[0].reason).toContain("single-sided");
    expect(stripped[1].reason).toContain("outside the capture set");
  });

  it("accounts track linkage once and re-namespaces stripped params per member", () => {
    const clipA = makeClip({
      id: "ca",
      mediaId: "m1",
      trackId: "v1",
      startTime: 0,
      metadata: { provenance: "x" } as never,
    });
    const clipB = makePlainClip({
      id: "cb",
      mediaId: "m2",
      trackId: "v2",
      startTime: 1,
    });
    const project = makeMultiProject(
      [
        { ...makeTrack("v1", "video", [clipA]), groupId: "group-1" },
        { ...makeTrack("v2", "video", [clipB]), groupId: "group-1" },
      ],
      [{}, {}],
    );
    const result = captureWorkAssetFromClips(project, ["ca", "cb"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.asset;
    expect(asset.unsupportedParams).toEqual([
      { field: "members[0].stabilization.analyzed", reason: expect.any(String) },
      { field: "members[0].stabilization.analysisVersion", reason: expect.any(String) },
      { field: "members[0].stabilization.profile", reason: expect.any(String) },
      { field: "members[0].metadata", reason: expect.any(String) },
      {
        field: "trackGroups",
        reason: "track linkage is instance-local and not part of the reusable layout",
      },
    ]);
  });

  it("rejects the whole set when any member fails the prechecks, listing perMember", () => {
    const placeholder = makeMultiProject(
      [
        makeTrack("v1", "video", [makePlainClip({ id: "cv1", startTime: 0 })]),
        makeTrack("v2", "video", [makePlainClip({ id: "cv2", startTime: 1 })]),
      ],
      [{ isPlaceholder: true }, {}],
    );
    expect(captureWorkAssetFromClips(placeholder, ["cv1", "cv2"])).toMatchObject({
      ok: false,
      code: "UNSUPPORTED",
    });

    // A text-track clip is rejected even with a non-virtual media id
    // (belt-and-braces for engine-generated paths).
    const textTrack = makeMultiProject(
      [
        makeTrack("v1", "video", [makePlainClip({ id: "cv1", startTime: 0 })]),
        makeTrack("t1", "text", [
          makePlainClip({ id: "ct1", mediaId: "m2", trackId: "t1", startTime: 1 }),
        ]),
      ],
      [{}, {}],
    );
    const textResult = captureWorkAssetFromClips(textTrack, ["cv1", "ct1"]);
    expect(textResult).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    if (!textResult.ok) {
      expect(textResult.message).toContain("text");
    }

    // Degenerate range on one member.
    const degenerate = makeMultiProject(
      [
        makeTrack("v1", "video", [makePlainClip({ id: "cv1", startTime: 0 })]),
        makeTrack("v2", "video", [
          makePlainClip({ id: "cv2", startTime: 1, inPoint: 5, outPoint: 2, duration: -3 }),
        ]),
      ],
      [{}, {}],
    );
    expect(captureWorkAssetFromClips(degenerate, ["cv1", "cv2"])).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });

    // Missing media on one member.
    const missing = makeMultiProject(
      [
        makeTrack("v1", "video", [makePlainClip({ id: "cv1", startTime: 0 })]),
        makeTrack("v2", "video", [
          makePlainClip({ id: "cv2", mediaId: "m-gone", startTime: 1 }),
        ]),
      ],
      [{}, {}],
    );
    const missingResult = captureWorkAssetFromClips(missing, ["cv1", "cv2"]);
    expect(missingResult).toMatchObject({ ok: false, code: "MEDIA_NOT_FOUND" });

    // Every failure path reports perMember details and produces NO asset.
    if (!missingResult.ok) {
      const details = missingResult.details as { perMember?: unknown[] };
      expect(Array.isArray(details.perMember)).toBe(true);
    }
  });

  it("reports each failing member in perMember details", () => {
    const placeholder = makeMultiProject(
      [
        makeTrack("v1", "video", [makePlainClip({ id: "cv1", startTime: 0 })]),
        makeTrack("v2", "video", [
          makePlainClip({ id: "cv2", mediaId: "m2", startTime: 1 }),
        ]),
      ],
      [{}, { isPlaceholder: true }],
    );
    const result = captureWorkAssetFromClips(placeholder, ["cv1", "cv2"]);
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED" });
    if (!result.ok) {
      const perMember = (result.details as { perMember: Array<Record<string, unknown>> })
        .perMember;
      expect(perMember).toEqual([
        expect.objectContaining({ clipId: "cv2", code: "UNSUPPORTED" }),
      ]);
    }
  });

  it("rejects invalid sets: too small, duplicate ids, unknown ids, oversized", () => {
    const { project } = twoVideoOneAudio();
    expect(captureWorkAssetFromClips(project, ["cv1"])).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(captureWorkAssetFromClips(project, ["cv1", "cv1"])).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    const notFound = captureWorkAssetFromClips(project, ["cv1", "nope", "gone"]);
    expect(notFound).toMatchObject({ ok: false, code: "NOT_FOUND" });
    if (!notFound.ok) {
      expect(notFound.details?.clipIds).toEqual(["nope", "gone"]);
    }
    const oversized = Array.from({ length: 65 }, (_, index) => `c${index}`);
    expect(captureWorkAssetFromClips(project, oversized)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(captureWorkAssetFromClips(project, [], {})).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
  });

  it("feeds the multi asset through validator and executor unchanged", async () => {
    const { project } = twoVideoOneAudio();
    const captured = captureWorkAssetFromClips(project, ["cv1", "ca1", "cv2"], {
      captureRequestId: "req-multi",
      createdBy: "agent",
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const asset: WorkAsset = captured.asset;
    expect(asset.captureRequestId).toBe("req-multi");
    expect(asset.createdBy).toBe("agent");

    const validation = new ActionValidator().validate(
      {
        type: "workAsset/create",
        id: "a1",
        timestamp: 0,
        params: { asset },
      },
      project,
    );
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

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
    expect(project.workAssets![0].kind).toBe("multi");
    expect(project.workAssets![0].members).toHaveLength(3);
  });
});

describe("captureWorkAssetFromMedia", () => {
  it("captures the full media span with the engine's default clip parameters", () => {
    const result = captureWorkAssetFromMedia(makeProject(), "m1", {
      assetId: "wa-m1",
      now: 2000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = result.asset;
    expect(asset.schemaVersion).toBe(1);
    expect(asset.kind).toBe("single");
    expect(asset.id).toBe("wa-m1");
    expect(asset.sourceMediaId).toBe("m1");
    expect(asset.sourceRange).toEqual({ inSec: 0, outSec: 30 });
    expect(asset.name).toBe("Take 01 (0s-30s)");
    expect(asset.unsupportedParams).toEqual([]);
    expect(asset.clipSnapshot).toMatchObject({
      duration: 30,
      inPoint: 0,
      outPoint: 30,
      volume: 1,
    });
    expect(asset.clipSnapshot?.effects).toEqual([]);
    expect(asset.clipSnapshot?.audioEffects).toEqual([]);
    expect(asset.clipSnapshot?.keyframes).toEqual([]);
    expect(asset.clipSnapshot?.transform).toMatchObject({
      rotation: 0,
      opacity: 1,
    });
    expect(asset.createdAt).toBe(2000);
    expect(asset.updatedAt).toBe(2000);
  });

  it("captures an explicit sub-range and honors a caller-supplied name", () => {
    const result = captureWorkAssetFromMedia(makeProject(), "m1", {
      inSec: 4,
      outSec: 9,
      name: "  Punch-in  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.name).toBe("Punch-in");
    expect(result.asset.sourceRange).toEqual({ inSec: 4, outSec: 9 });
    expect(result.asset.clipSnapshot).toMatchObject({
      duration: 5,
      inPoint: 4,
      outPoint: 9,
    });
  });

  it("falls back to the 5s still-image span when the media reports no duration", () => {
    const project = makeProject({
      mediaItems: [
        {
          type: "image",
          metadata: {
            duration: 0,
            width: 100,
            height: 80,
            frameRate: 0,
            codec: "png",
            sampleRate: 0,
            channels: 0,
            fileSize: 10,
          },
        },
      ],
    });
    const result = captureWorkAssetFromMedia(project, "m1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.asset.sourceRange).toEqual({ inSec: 0, outSec: 5 });
    expect(result.asset.clipSnapshot?.duration).toBe(5);
  });

  it("rejects unknown media, placeholders, degenerate or out-of-bounds ranges, and empty names", () => {
    expect(captureWorkAssetFromMedia(makeProject(), "nope")).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const placeholder = makeProject({
      mediaItems: [{ isPlaceholder: true }],
    });
    expect(captureWorkAssetFromMedia(placeholder, "m1")).toMatchObject({
      ok: false,
      code: "UNSUPPORTED",
    });
    expect(
      captureWorkAssetFromMedia(makeProject(), "m1", { inSec: 5, outSec: 5 }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      captureWorkAssetFromMedia(makeProject(), "m1", { inSec: -1, outSec: 5 }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      captureWorkAssetFromMedia(makeProject(), "m1", { outSec: 31 }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      captureWorkAssetFromMedia(makeProject(), "m1", { name: "   " }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("round-trips through instantiate as a well-formed clip", () => {
    const captured = captureWorkAssetFromMedia(makeProject(), "m1", {
      assetId: "wa-x",
      inSec: 2,
      outSec: 6,
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const project = {
      ...makeProject(),
      workAssets: [captured.asset],
    } as unknown as Project;
    const built = buildWorkAssetInstantiateActions(project, "wa-x", {
      trackId: "v1",
      clipId: "clip-x",
      startTime: 10,
      now: 5,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.trackId).toBe("v1");
    expect(built.createdTrack).toBe(false);
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0].type).toBe("clip/add");
    const sourceClip = (
      built.actions[0].params as { sourceClip: Clip }
    ).sourceClip;
    expect(sourceClip).toMatchObject({
      id: "clip-x",
      mediaId: "m1",
      trackId: "v1",
      startTime: 10,
      duration: 4,
      inPoint: 2,
      outPoint: 6,
    });
  });
});
