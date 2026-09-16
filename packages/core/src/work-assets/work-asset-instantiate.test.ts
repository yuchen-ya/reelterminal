import { describe, expect, it } from "vitest";
import { buildWorkAssetInstantiateActions } from "./instantiate";
import { ActionExecutor } from "../actions/action-executor";
import type { Clip, Track } from "../types/timeline";
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
