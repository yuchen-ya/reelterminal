import { describe, expect, it } from "vitest";
import { buildWorkAssetInstantiateActions } from "./instantiate";
import { captureWorkAssetFromClips } from "./capture";
import { ActionExecutor } from "../actions/action-executor";
import { ActionValidator } from "../actions/action-validator";
import type { Clip, Track } from "../types/timeline";
import type { Project, WorkAsset, WorkAssetMember } from "../types";

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
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...overrides,
  } as Clip;
}

function makeAsset(overrides: Partial<WorkAsset> = {}): WorkAsset {
  return {
    schemaVersion: 1,
    id: "wa-1",
    kind: "single",
    name: "Hero trim",
    sourceMediaId: "m1",
    sourceRange: { inSec: 2, outSec: 6 },
    clipSnapshot: {
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
      stabilization: { enabled: true, strength: 0.5, cropMode: "auto" },
    },
    unsupportedParams: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeProject(overrides: {
  assets?: WorkAsset[];
  tracks?: Track[];
  mediaItems?: Partial<Project["mediaLibrary"]["items"][number]>[];
} = {}): Project {
  const mediaItems = (overrides.mediaItems ?? [{}]).map((patch, index) => ({
    id: `m${index + 1}`,
    name: "take-01.mp4",
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
    timeline: {
      duration: 4,
      tracks: overrides.tracks ?? [makeTrack("v1", "video", [makeClip()])],
    },
    mediaLibrary: { items: mediaItems },
    ...(overrides.assets ? { workAssets: overrides.assets } : {}),
  } as unknown as Project;
}

function actionParams(action: { params: Record<string, unknown> }) {
  return action.params as {
    trackType?: string;
    trackId: string;
    clipId?: string;
    startTime: number;
    sourceClip: Clip;
  };
}

describe("buildWorkAssetInstantiateActions", () => {
  it("builds a track/add + clip/add batch with a snapshot-restored source clip", () => {
    const project = makeProject({ assets: [makeAsset()] });
    const result = buildWorkAssetInstantiateActions(project, "wa-1", {
      clipId: "inst-1",
      now: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdTrack).toBe(true);
    expect(result.clipId).toBe("inst-1");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].type).toBe("track/add");
    const trackParams = actionParams(result.actions[0]);
    expect(trackParams.trackType).toBe("video");
    const clipParams = actionParams(result.actions[1]);
    expect(clipParams.clipId).toBe("inst-1");
    expect(clipParams.trackId).toBe(result.trackId);
    expect(clipParams.startTime).toBe(4);
    expect(clipParams.sourceClip.mediaId).toBe("m1");
    expect(clipParams.sourceClip).toMatchObject({
      id: "inst-1",
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      speed: 2,
      volume: 0.8,
      startTime: 4,
    });
    expect(clipParams.sourceClip.effects).toEqual([
      { id: "e1", type: "brightness", params: { level: 1.2 }, enabled: true },
    ]);
    expect(clipParams.sourceClip.stabilization).toEqual({
      enabled: true,
      strength: 0.5,
      cropMode: "auto",
    });
    expect(result.actions[1].timestamp).toBe(5000);
  });

  it("executes the batch as fresh clips and leaves the asset entry untouched", async () => {
    const asset = makeAsset();
    const project = makeProject({ assets: [asset] });
    const before = structuredClone(asset);
    const result = buildWorkAssetInstantiateActions(project, "wa-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const executor = new ActionExecutor();
    for (const act of result.actions) {
      const applied = await executor.execute(act, project);
      expect(applied.success).toBe(true);
    }
    expect(project.workAssets).toEqual([before]);
    const [track] = project.timeline.tracks.filter(
      (candidate) => candidate.id === result.trackId,
    );
    expect(track.clips).toHaveLength(1);
    expect(track.clips[0].id).toBe(result.clipId);
    expect(track.clips[0].speed).toBe(2);

    // A second instantiation is fully independent.
    const second = buildWorkAssetInstantiateActions(project, "wa-1");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    for (const act of second.actions) {
      await executor.execute(act, project);
    }
    expect(project.workAssets).toEqual([before]);
    const instantiated = structuredClone(
      project.timeline.tracks.filter(
        (candidate) => candidate.id === result.trackId,
      )[0].clips[0],
    );
    const secondClip = project.timeline.tracks.filter(
      (candidate) => candidate.id === second.trackId,
    )[0].clips[0];
    (secondClip.transform as { rotation: number }).rotation = 77;
    expect(instantiated.transform.rotation).not.toBe(77);
  });

  it("undoes cleanly back to the pre-instantiation timeline", async () => {
    const project = makeProject({ assets: [makeAsset()] });
    const result = buildWorkAssetInstantiateActions(project, "wa-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const executor = new ActionExecutor();
    for (const act of result.actions) {
      await executor.execute(act, project);
    }
    expect(
      project.timeline.tracks.some((t) => t.id === result.trackId),
    ).toBe(true);
    // Undo peels the batch back in reverse order: first the clip, then the
    // freshly created lane.
    expect(await executor.undo(project)).toMatchObject({ success: true });
    const lane = project.timeline.tracks.find((t) => t.id === result.trackId);
    expect(lane?.clips ?? []).toHaveLength(0);
    expect(await executor.undo(project)).toMatchObject({ success: true });
    expect(
      project.timeline.tracks.some((t) => t.id === result.trackId),
    ).toBe(false);
    expect(project.timeline.tracks[0].clips.map((c) => c.id)).toEqual(["c1"]);
  });

  it("reuses an existing compatible track and rejects incompatible or missing ones", () => {
    const project = makeProject({
      assets: [makeAsset()],
      tracks: [makeTrack("v1", "video", []), makeTrack("a1", "audio", [])],
    });
    const reuse = buildWorkAssetInstantiateActions(project, "wa-1", {
      trackId: "v1",
    });
    expect(reuse.ok).toBe(true);
    if (reuse.ok) {
      expect(reuse.createdTrack).toBe(false);
      expect(reuse.actions.map((a) => a.type)).toEqual(["clip/add"]);
    }
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { trackId: "a1" }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { trackId: "nope" }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("rejects unknown assets, non-single kinds, and missing source media", () => {
    expect(
      buildWorkAssetInstantiateActions(makeProject(), "nope"),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      buildWorkAssetInstantiateActions(makeProject({ assets: [makeAsset({ kind: "multi", clipSnapshot: undefined })] }), "wa-1"),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      buildWorkAssetInstantiateActions(makeProject({ assets: [makeAsset({ sourceMediaId: "deleted" })], mediaItems: [] }), "wa-1"),
    ).toMatchObject({ ok: false, code: "MEDIA_NOT_FOUND" });
  });

  it("rejects malformed snapshots before any action is built", () => {
    const base = makeAsset();
    const broken: Array<[string, Partial<WorkAsset>]> = [
      ["effects not an array", { clipSnapshot: { ...base.clipSnapshot!, effects: "nope" as never } }],
      ["inverted range", { clipSnapshot: { ...base.clipSnapshot!, inPoint: 6, outPoint: 2 } }],
      ["zero speed", { clipSnapshot: { ...base.clipSnapshot!, speed: 0 } }],
      ["missing transform", { clipSnapshot: { ...base.clipSnapshot!, transform: undefined as never } }],
      ["broken stabilization", { clipSnapshot: { ...base.clipSnapshot!, stabilization: { enabled: "yes", strength: 0.5, cropMode: "auto" } as never } }],
    ];
    for (const [label, patch] of broken) {
      const project = makeProject({ assets: [makeAsset(patch)] });
      expect(
        buildWorkAssetInstantiateActions(project, "wa-1"),
        label,
      ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
  });

  it("rejects colliding clip ids and invalid start times", () => {
    const project = makeProject({ assets: [makeAsset()] });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { clipId: "c1" }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { startTime: -1 }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", {
        startTime: Number.NaN,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

describe("buildWorkAssetInstantiateActions kind multi", () => {
  const makeMember = (overrides: Partial<WorkAssetMember> = {}): WorkAssetMember => ({
    memberId: "mA",
    mediaId: "m1",
    sourceRange: { inSec: 2, outSec: 6 },
    relativeStart: 0,
    lane: { trackType: "video", laneOffset: 0 },
    snapshot: {
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 1, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    },
    ...overrides,
  });

  /** 2V+1A layout: video anchor @0, audio @1, second video @1.5. */
  const makeMultiAsset = (overrides: Partial<WorkAsset> = {}): WorkAsset =>
    makeAsset({
      kind: "multi",
      name: "Composite",
      clipSnapshot: undefined,
      sourceRange: { inSec: 2, outSec: 6 },
      members: [
        makeMember(),
        makeMember({
          memberId: "mB",
          mediaId: "m2",
          sourceRange: { inSec: 0, outSec: 3 },
          relativeStart: 1.5,
          lane: { trackType: "video", laneOffset: 1 },
        }),
        makeMember({
          memberId: "mC",
          mediaId: "m3",
          sourceRange: { inSec: 4, outSec: 9 },
          relativeStart: 1,
          lane: { trackType: "audio", laneOffset: 0 },
        }),
      ],
      unsupportedParams: [],
      ...overrides,
    });

  const multiProject = (asset: WorkAsset, tracks?: Track[]): Project =>
    makeProject({
      assets: [asset],
      tracks: tracks ?? [makeTrack("v1", "video", [makeClip()])],
      mediaItems: [{}, {}, { type: "audio" as const }],
    });

  it("expands onto fresh lanes (video asc → audio) with one clip per member", () => {
    const project = multiProject(makeMultiAsset());
    const result = buildWorkAssetInstantiateActions(project, "wa-1", {
      now: 7000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.createdTrackCount).toBe(3);
    expect(result.createdTrack).toBe(true);
    expect(result.actions).toHaveLength(6);
    expect(result.actions.map((a) => a.type)).toEqual([
      "track/add",
      "track/add",
      "track/add",
      "clip/add",
      "clip/add",
      "clip/add",
    ]);
    expect(result.actions.every((a) => a.timestamp === 7000)).toBe(true);

    // Lane emission order: video lane 0, video lane 1, then audio lane 0.
    const trackTypes = result.actions.slice(0, 3).map(
      (a) => actionParams(a).trackType,
    );
    expect(trackTypes).toEqual(["video", "video", "audio"]);

    // Members land in relativeStart order at anchorTime + relativeStart
    // (timeline end = 4): anchor @4, audio @5, second video @5.5.
    const clipStartTimes = result.actions.slice(3).map(
      (a) => actionParams(a).startTime,
    );
    expect(clipStartTimes).toEqual([4, 5, 5.5]);
    const clipMediaIds = result.actions.slice(3).map(
      (a) => actionParams(a).sourceClip.mediaId,
    );
    expect(clipMediaIds).toEqual(["m1", "m3", "m2"]);

    // Result identities: anchor lane = (anchor type, laneOffset 0).
    const laneTrackIds = result.actions
      .slice(0, 3)
      .map((a) => actionParams(a).trackId);
    expect(result.trackId).toBe(laneTrackIds[0]);
    expect(result.trackIds).toEqual(laneTrackIds);
    expect(result.clipIds).toHaveLength(3);
    expect(result.clipId).toBe(result.clipIds[0]);
  });

  it("preserves relative member timing from capture through instantiation", async () => {
    // Capture a staggered 2V+1A layout from a source timeline…
    const source = makeProject({
      tracks: [
        makeTrack("v1", "video", [
          makeClip({ id: "cv1", mediaId: "m1", trackId: "v1", startTime: 0 }),
        ]),
        makeTrack("v2", "video", [
          makeClip({
            id: "cv2",
            mediaId: "m2",
            trackId: "v2",
            startTime: 2.5,
            inPoint: 0,
            outPoint: 3,
            duration: 3,
          }),
        ]),
        makeTrack("a1", "audio", [
          makeClip({
            id: "ca1",
            mediaId: "m3",
            trackId: "a1",
            startTime: 1,
            inPoint: 4,
            outPoint: 9,
            duration: 5,
          }),
        ]),
      ],
      mediaItems: [{}, {}, { type: "audio" as const }],
    });
    const captured = captureWorkAssetFromClips(source, ["cv1", "ca1", "cv2"], {
      assetId: "wa-1",
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const relative = captured.asset.members!.map((m) => m.relativeStart);
    expect(relative).toEqual([0, 1, 2.5]);

    // …persist it (fresh project — workAsset/create rejects duplicate ids)…
    const project = makeProject({
      mediaItems: [{}, {}, { type: "audio" as const }],
    });
    const validation = new ActionValidator().validate(
      { type: "workAsset/create", id: "a1", timestamp: 0, params: { asset: captured.asset } },
      project,
    );
    expect(validation.valid).toBe(true);
    const executor = new ActionExecutor();
    for (const act of [
      { type: "workAsset/create" as const, id: "a1", timestamp: 0, params: { asset: captured.asset } },
    ]) {
      expect((await executor.execute(act, project)).success).toBe(true);
    }

    // …and instantiate at startTime 10: the member spacing survives verbatim.
    const result = buildWorkAssetInstantiateActions(project, "wa-1", {
      startTime: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const act of result.actions) {
      expect((await executor.execute(act, project)).success).toBe(true);
    }
    const instantiated = result.clipIds
      .map((clipId) =>
        project.timeline.tracks
          .flatMap((track) => track.clips)
          .find((clip) => clip.id === clipId),
      )
      .map((clip) => clip!.startTime)
      .sort((a, b) => a - b);
    expect(instantiated).toEqual([10, 11, 12.5]);
  });

  it("binds options.trackId to the anchor lane and opens fresh lanes for the rest", () => {
    const project = multiProject(makeMultiAsset(), [
      makeTrack("v1", "video", []),
      makeTrack("a1", "audio", []),
    ]);
    const bound = buildWorkAssetInstantiateActions(project, "wa-1", {
      trackId: "v1",
    });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      // Anchor lane (video,0) reuses v1; video lane 1 + audio lane 0 are new.
      expect(bound.trackId).toBe("v1");
      expect(bound.trackIds).toContain("v1");
      expect(bound.createdTrackCount).toBe(2);
      expect(bound.actions.filter((a) => a.type === "track/add")).toHaveLength(2);
    }
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { trackId: "a1" }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { trackId: "nope" }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("rejects missing member media all-or-nothing with the full missing list", () => {
    const project = makeProject({
      assets: [makeMultiAsset()],
      tracks: [makeTrack("v1", "video", [makeClip()])],
      mediaItems: [{}, { type: "video" as const }], // m3 (member mC) is gone
    });
    const result = buildWorkAssetInstantiateActions(project, "wa-1");
    expect(result).toMatchObject({ ok: false, code: "MEDIA_NOT_FOUND" });
    if (!result.ok) {
      expect(result.details?.missingMembers).toEqual([
        { memberIndex: 2, mediaId: "m3" },
      ]);
      expect((result as { actions?: unknown }).actions).toBeUndefined();
    }
  });

  it("rejects malformed members before any action is built", () => {
    const cases: Array<[string, WorkAsset]> = [
      ["empty members", makeMultiAsset({ members: [] })],
      ["missing members", makeMultiAsset({ members: undefined })],
      [
        "duplicate memberId",
        makeMultiAsset({ members: [makeMember(), makeMember()] }),
      ],
      [
        "text lane",
        makeMultiAsset({
          members: [
            makeMember({
              lane: { trackType: "text" as never, laneOffset: 0 },
            }),
          ],
        }),
      ],
      [
        "fractional lane offset",
        makeMultiAsset({
          members: [makeMember({ lane: { trackType: "video", laneOffset: 0.5 } })],
        }),
      ],
      [
        "negative relativeStart",
        makeMultiAsset({ members: [makeMember({ relativeStart: -1 })] }),
      ],
      [
        "member snapshot malformed",
        makeMultiAsset({
          members: [
            makeMember({
              snapshot: { ...makeMember().snapshot, speed: 0 },
            }),
          ],
        }),
      ],
      [
        "single snapshot on multi asset",
        makeMultiAsset({ clipSnapshot: makeAsset().clipSnapshot }),
      ],
    ];
    for (const [label, asset] of cases) {
      const result = buildWorkAssetInstantiateActions(multiProject(asset), "wa-1");
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.code, label).toBe("INVALID_PARAMS");
        expect(
          (result as { actions?: unknown }).actions,
          label,
        ).toBeUndefined();
      }
    }
  });

  it("rejects colliding clip ids and invalid start times before building", () => {
    const project = multiProject(makeMultiAsset());
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { clipId: "c1" }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", { startTime: -1 }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(
      buildWorkAssetInstantiateActions(project, "wa-1", {
        startTime: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("produces independent instances and never touches the asset entry", async () => {
    const asset = makeMultiAsset();
    const project = multiProject(asset);
    const before = structuredClone(asset);
    const executor = new ActionExecutor();

    const first = buildWorkAssetInstantiateActions(project, "wa-1", {
      startTime: 10,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (const act of first.actions) {
      expect((await executor.execute(act, project)).success).toBe(true);
    }

    const second = buildWorkAssetInstantiateActions(project, "wa-1", {
      startTime: 30,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    for (const act of second.actions) {
      await executor.execute(act, project);
    }
    expect(project.workAssets).toEqual([before]);

    const secondClip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === second.clipIds[0])!;
    (secondClip.transform as { position: { x: number } }).position.x = 99;
    const firstClip = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === first.clipIds[0])!;
    expect(firstClip.transform.position.x).not.toBe(99);
    expect(firstClip.startTime).toBe(10);
  });

  it("undoes the whole multi batch: clips first, then the fresh lanes", async () => {
    const project = multiProject(makeMultiAsset());
    const trackCountBefore = project.timeline.tracks.length;
    const executor = new ActionExecutor();
    const result = buildWorkAssetInstantiateActions(project, "wa-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const act of result.actions) {
      expect((await executor.execute(act, project)).success).toBe(true);
    }
    expect(project.timeline.tracks).toHaveLength(trackCountBefore + 3);

    // 3 undos peel the three clip/adds back off…
    for (let index = 0; index < 3; index++) {
      expect(await executor.undo(project)).toMatchObject({ success: true });
    }
    expect(
      project.timeline.tracks.flatMap((track) => track.clips).map((c) => c.id),
    ).toEqual(["c1"]);
    // …and 3 more remove the freshly created lanes.
    for (let index = 0; index < result.createdTrackCount; index++) {
      expect(await executor.undo(project)).toMatchObject({ success: true });
    }
    expect(project.timeline.tracks).toHaveLength(trackCountBefore);
    expect(
      project.timeline.tracks.flatMap((track) => track.clips).map((c) => c.id),
    ).toEqual(["c1"]);
    expect(project.workAssets).toHaveLength(1);
  });

  it("keeps member freezeFrames resolvable after capture → persist → instantiate", async () => {
    const freezeFrames = [
      { id: "ff-1", clipId: "cv1", sourceTime: 3, startTime: 1, duration: 0.5 },
    ];
    const source = makeProject({
      tracks: [
        makeTrack("v1", "video", [
          makeClip({
            id: "cv1",
            mediaId: "m1",
            trackId: "v1",
            startTime: 0,
            freezeFrames: [...freezeFrames],
          }),
        ]),
        makeTrack("v2", "video", [
          makeClip({
            id: "cv2",
            mediaId: "m2",
            trackId: "v2",
            startTime: 1,
            inPoint: 0,
            outPoint: 3,
            duration: 3,
          }),
        ]),
      ],
      mediaItems: [{}, {}],
    });

    const captured = captureWorkAssetFromClips(source, ["cv1", "cv2"], {
      assetId: "wa-1",
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.asset.members![0].snapshot.freezeFrames).toEqual(freezeFrames);

    const project = makeProject({
      mediaItems: [{}, {}],
    });
    const executor = new ActionExecutor();
    const created = await executor.execute(
      {
        type: "workAsset/create",
        id: "a1",
        timestamp: 0,
        params: { asset: captured.asset },
      },
      project,
    );
    expect(created.success).toBe(true);

    const result = buildWorkAssetInstantiateActions(project, "wa-1", {
      startTime: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const act of result.actions) {
      expect((await executor.execute(act, project)).success).toBe(true);
    }
    const instantiated = project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === result.clipIds[0])!;
    // The frozen frame rides the cloned clip data; its clipId points at the
    // SNAPSHOT provenance and resolution goes through the instance's own
    // registry (assumption A5 is held up by this data surviving verbatim).
    expect(instantiated.freezeFrames).toEqual(freezeFrames);
  });
});
