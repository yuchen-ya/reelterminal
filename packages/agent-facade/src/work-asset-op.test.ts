/**
 * workAsset.* — project work assets through the edit.apply op set.
 *
 * Covered behavior:
 *  - workAsset.capture lands the same persisted WorkAsset the core
 *    workAsset/create action stores (shared capture pure function, so agent
 *    and GUI captures take the same path; only the recorded provenance
 *    differs): snapshot parameters (speed, fades, effects), source range,
 *    declared unsupportedParams, stable id, "agent" provenance and the
 *    captureRequestId echo,
 *  - the multi-clip form (clipIds) captures a SET of clips as ONE kind
 *    "multi" asset: relative member layout, anchor mirrored into the
 *    top-level identity fields, all-or-nothing prechecks with per-member
 *    details, and the member/lane summary projected through timeline.query,
 *  - unknown clips fail NOT_FOUND and the revision does not move,
 *  - workAsset.rename / workAsset.delete reuse the core undoable actions,
 *  - workAsset.instantiate places a NEW clip built from the snapshot: the
 *    asset entry is untouched, a second instantiation is fully independent,
 *    and the original timeline clip can be deleted in between,
 *  - a multi asset expands the whole member layout: every new lane id first,
 *    then every clip id in member order; relative timing is preserved
 *    verbatim; an explicit trackId binds the anchor lane only; a member with
 *    missing media rejects the WHOLE expansion (all-or-nothing), and a
 *    retried idempotencyKey replays instead of stacking members,
 *  - without trackId a matching lane is created and reported FIRST in
 *    createdIds, then the clip id (headless diff ordering),
 *  - retrying with the same idempotencyKey replays instead of stacking
 *    instances (the shared edit.apply ledger — no new idempotency code),
 *  - timeline.query exposes the workAsset projection (identity + source +
 *    missingSource state, never the raw snapshot payload),
 *  - deleting the source media flips missingSource and instantiation is
 *    rejected with a message that names the deleted media,
 *  - edit.validate dry-runs the new ops through the same closed schemas.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import type { EditOp } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("workAsset ops (edit.apply)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("work-asset-ops");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "WorkAssets" });
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    mediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 0,
          inPoint: 1,
          outPoint: 5,
          clipId: "c1",
        },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error("seed failed");
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  async function assetsList() {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    return state.value.project.workAssets ?? [];
  }

  async function queryWorkAssets() {
    const result = await facade["timeline.query"]({
      entityTypes: ["workAsset"],
      fields: [
        "name",
        "sourceMediaId",
        "sourceRange",
        "speed",
        "unsupportedParams",
        "missingSource",
        "createdAt",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("query failed");
    return result.value.items;
  }

  it("captures a clip into a persisted work asset with declared unsupported parameters", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: "c1", speed: 2 },
        {
          op: "workAsset.capture",
          clipId: "c1",
          name: "Hero trim",
          captureRequestId: "req-1",
        },
      ],
    });

    const assets = await assetsList();
    expect(assets).toHaveLength(1);
    const asset = assets[0];
    expect(asset.id).toMatch(/^wa-/);
    expect(asset.kind).toBe("single");
    expect(asset.name).toBe("Hero trim");
    expect(asset.sourceMediaId).toBe(mediaId);
    expect(asset.sourceRange).toEqual({ inSec: 1, outSec: 5 });
    expect(asset.createdBy).toBe("agent");
    expect(asset.captureRequestId).toBe("req-1");
    expect(asset.clipSnapshot?.speed).toBe(2);
    expect(asset.clipSnapshot?.inPoint).toBe(1);
    expect(asset.clipSnapshot?.outPoint).toBe(5);
    expect(Array.isArray(asset.unsupportedParams)).toBe(true);

    const queried = await queryWorkAssets();
    expect(queried).toHaveLength(1);
    expect(queried[0]).toMatchObject({
      entityType: "workAsset",
      id: asset.id,
      trackId: null,
      startTime: null,
      data: {
        name: "Hero trim",
        sourceMediaId: mediaId,
        sourceRange: { inSec: 1, outSec: 5 },
        speed: 2,
        missingSource: false,
      },
    });
    expect(queried[0].data.clipSnapshot).toBeUndefined();
  });

  it("derives the name from the source media when omitted", async () => {
    const result = await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "c1" }],
    });
    expect(result.ok).toBe(true);
    const assets = await assetsList();
    expect(assets[0].name).toContain("tiny-6s");
  });

  it("rejects capturing an unknown clip without moving the revision", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("state failed");
    const result = await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "nope" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error("state failed");
    expect(after.value.revision).toBe(before.value.revision);
    expect(after.value.project.workAssets ?? []).toHaveLength(0);
  });

  it("renames and deletes assets through the shared core actions", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "c1" }],
    });
    let assets = await assetsList();
    const id = assets[0].id;

    await facade["edit.apply"]({
      ops: [{ op: "workAsset.rename", workAssetId: id, name: "Renamed cut" }],
    });
    assets = await assetsList();
    expect(assets[0].name).toBe("Renamed cut");

    await facade["edit.apply"]({
      ops: [{ op: "workAsset.delete", workAssetId: id }],
    });
    assets = await assetsList();
    expect(assets).toHaveLength(0);
    expect(await queryWorkAssets()).toHaveLength(0);
  });

  it("instantiates fresh clips from the snapshot without touching the asset", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: "c1", speed: 2 },
        { op: "workAsset.capture", clipId: "c1" },
      ],
    });
    const assets = await assetsList();
    const assetBefore = structuredClone(assets[0]);

    const first = await facade["edit.apply"]({
      ops: [{ op: "workAsset.instantiate", workAssetId: assets[0].id }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("instantiate failed");
    const [firstApplied] = first.value.applied;
    expect(firstApplied.createdIds).toHaveLength(2);
    const [newTrackId, firstClipId] = firstApplied.createdIds;

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const lane = state.value.project.timeline.tracks.find(
      (track) => track.id === newTrackId,
    );
    expect(lane).toBeTruthy();
    expect(lane?.type).toBe("video");
    const instance = lane?.clips.find((clip) => clip.id === firstClipId);
    expect(instance).toBeTruthy();
    expect(instance?.mediaId).toBe(mediaId);
    expect(instance?.speed).toBe(2);
    expect(instance?.inPoint).toBe(1);
    expect(instance?.outPoint).toBe(5);
    // Defaults to the end of the timeline.
    expect(instance?.startTime).toBe(2);

    // The asset entry is byte-identical after instantiation.
    expect(await assetsList()).toEqual([assetBefore]);

    // A second instantiation is a fully independent clip (the agent drops the
    // first instance on its own lane via clip.remove, then instantiates again
    // with an explicit placement).
    await facade["edit.apply"]({
      ops: [{ op: "clip.remove", clipId: firstClipId }],
    });
    const second = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.instantiate",
          workAssetId: assets[0].id,
          trackId: "v1",
          startTime: 10,
        },
      ],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second instantiate failed");
    const [secondApplied] = second.value.applied;
    expect(secondApplied.createdIds).toHaveLength(1);
    const secondClipId = secondApplied.createdIds[0];
    const stateAfter = await facade["project.get_state"]();
    if (!stateAfter.ok) throw new Error("state failed");
    const clipOnV1 = stateAfter.value.project.timeline.tracks
      .find((track) => track.id === "v1")
      ?.clips.find((clip) => clip.id === secondClipId);
    expect(clipOnV1?.startTime).toBe(10);
    expect(clipOnV1?.speed).toBe(2);
    expect(await assetsList()).toEqual([assetBefore]);
  });

  it("keeps the asset reusable after the original timeline clip is deleted", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "c1" }],
    });
    await facade["edit.apply"]({
      ops: [{ op: "clip.remove", clipId: "c1" }],
    });
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.instantiate",
          workAssetId: (await assetsList())[0].id,
          startTime: 0,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("instantiate failed");
    const clipId = result.value.applied[0].createdIds[1];
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const instantiatedId = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .some((clip) => clip.id === clipId);
    expect(instantiatedId).toBe(true);
  });

  it("rejects wrong-lane instantiation with CONFLICT", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "workAsset.capture", clipId: "c1" },
        { op: "track.add", trackType: "audio", trackId: "a1" },
      ],
    });
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.instantiate",
          workAssetId: (await assetsList())[0].id,
          trackId: "a1",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  it("reports missingSource after the source media is removed and refuses instantiation", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "c1" }],
    });
    await facade["edit.apply"]({
      ops: [
        { op: "clip.remove", clipId: "c1" },
        { op: "media.remove", mediaId },
      ],
    });
    const queried = await queryWorkAssets();
    expect(queried[0].data.missingSource).toBe(true);

    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.instantiate",
          workAssetId: (await assetsList())[0].id,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("no longer in the project library");
  });

  it("replays the same idempotencyKey instead of stacking instances", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "workAsset.capture", clipId: "c1" }],
    });
    const assetId = (await assetsList())[0].id;
    const params = {
      ops: [
        { op: "workAsset.instantiate", workAssetId: assetId },
      ] as readonly EditOp[],
      idempotencyKey: "inst-once",
    };
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("instantiate failed");
    expect(first.value.replayed).toBe(false);
    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const instanceClips = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.id !== "c1");
    expect(instanceClips).toHaveLength(1);
  });

  it("dry-runs the new ops through edit.validate", async () => {
    const validated = await facade["edit.validate"]({
      ops: [
        { op: "workAsset.capture", clipId: "c1", name: "Planned" },
      ],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("validate failed");
    expect(validated.value.valid).toBe(true);
    // The dry-run must not have persisted anything.
    expect(await assetsList()).toHaveLength(0);
  });

  /* ----------------------- multi-clip capture form ----------------------- */

  /** A second video track + clip so a capture set spans two lanes. */
  async function seedSecondClip(mediaIdForSecond = mediaId) {
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v2" },
        {
          op: "clip.add",
          trackId: "v2",
          mediaId: mediaIdForSecond,
          startTime: 1,
          inPoint: 0,
          outPoint: 2,
          clipId: "c2",
        },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error("seed v2 failed");
  }

  async function captureMulti(
    options: { name?: string; captureRequestId?: string } = {},
  ) {
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.capture",
          clipIds: ["c1", "c2"],
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.captureRequestId !== undefined
            ? { captureRequestId: options.captureRequestId }
            : {}),
        } as EditOp,
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("multi capture failed");
    return (await assetsList())[0];
  }

  it("captures a clip set as ONE multi asset and projects the member layout", async () => {
    await seedSecondClip();
    const asset = await captureMulti({
      name: "Two-up",
      captureRequestId: "req-multi",
    });

    // Capture creates an ASSET, not timeline entities — no createdIds
    // (same convention as single capture).
    expect(asset.kind).toBe("multi");
    expect(asset.name).toBe("Two-up");
    expect(asset.createdBy).toBe("agent");
    expect(asset.captureRequestId).toBe("req-multi");
    expect(asset.clipSnapshot).toBeUndefined();
    expect(asset.members).toHaveLength(2);
    // Members are sorted by startTime: c1 (t0) is the anchor; its identity
    // fields are mirrored to the top level.
    expect(asset.members?.[0]).toMatchObject({
      mediaId,
      relativeStart: 0,
      lane: { trackType: "video", laneOffset: 0 },
    });
    expect(asset.members?.[1]).toMatchObject({
      mediaId,
      relativeStart: 1,
      lane: { trackType: "video", laneOffset: 1 },
    });
    expect(asset.sourceMediaId).toBe(mediaId);
    expect(asset.sourceRange).toEqual({ inSec: 1, outSec: 5 });

    const queried = await facade["timeline.query"]({
      entityTypes: ["workAsset"],
      fields: [
        "type",
        "memberCount",
        "laneSummary",
        "spanSec",
        "missingMemberCount",
        "transitionsCaptured",
        "speed",
        "effectCount",
      ],
    });
    expect(queried.ok).toBe(true);
    if (!queried.ok) throw new Error("query failed");
    expect(queried.value.items[0].data).toEqual({
      type: "multi",
      memberCount: 2,
      laneSummary: { video: 2 },
      // c1 spans 0..4, c2 spans 1..3 relative to T0 — the layout reach is 4s.
      spanSec: 4,
      missingMemberCount: 0,
      transitionsCaptured: 0,
      // Single-clip aggregates would misrepresent a member set — honest nulls.
      speed: null,
      effectCount: null,
    });
  });

  it("rejects a multi capture all-or-nothing with per-member details", async () => {
    // edit.apply cannot seed a degenerate clip (clip.add re-validates the
    // range), so pin the translator mapping directly: a track clip that fails
    // capture's per-member prechecks must reject the WHOLE set with the
    // member named in details.perMember and produce no action.
    const { createEmptyProject } = await import("./project-factory");
    const { opToCoreActions } = await import("./ops");
    const { FacadeError } = await import("./errors");
    const draft = createEmptyProject("Per-member rejection");
    draft.mediaLibrary.items.push({
      id: mediaId,
      name: "tiny-6s.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 6,
        width: 320,
        height: 180,
        frameRate: 10,
        codec: "h264",
        sampleRate: 0,
        channels: 0,
        fileSize: 1,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    const clip = (id: string, startTime: number, inPoint: number, outPoint: number) => ({
      id,
      mediaId,
      trackId: "v1",
      startTime,
      duration: outPoint - inPoint,
      inPoint,
      outPoint,
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
    });
    draft.timeline.tracks.push({
      id: "v1",
      type: "video",
      name: "Video",
      clips: [clip("c1", 0, 1, 5), clip("cbad", 2, 5, 2)],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });

    let thrown: unknown;
    try {
      opToCoreActions(
        { op: "workAsset.capture", clipIds: ["c1", "cbad"] },
        draft,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FacadeError);
    const facadeError = thrown as InstanceType<typeof FacadeError>;
    expect(facadeError.code).toBe("INVALID_PARAMS");
    const perMember = (
      facadeError.details as {
        perMember?: Array<{ clipId: string; code: string }>;
      }
    ).perMember;
    expect(perMember).toHaveLength(1);
    expect(perMember?.[0]).toMatchObject({
      clipId: "cbad",
      code: "INVALID_PARAMS",
    });
  });

  it("rejects a capture set naming a clip the timeline cannot resolve", async () => {
    // Overlay clips (text etc.) live outside track.clips, so the capture set
    // cannot resolve them — the whole set is rejected, nothing is produced.
    const created = await facade["edit.apply"]({
      ops: [{ op: "text.create", text: "overlay", startTime: 0, duration: 2 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("text.create failed");
    const textClipId = created.value.applied[0]?.createdIds.at(-1);
    expect(typeof textClipId).toBe("string");

    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.capture",
          clipIds: ["c1", textClipId as string],
        } as EditOp,
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(
      (result.error.details as { clipIds?: string[] }).clipIds,
    ).toEqual([textClipId]);
    expect(await assetsList()).toHaveLength(0);
  });

  it("rejects ambiguous and malformed multi capture forms", async () => {
    const cases: Array<{ ops: readonly EditOp[]; code: string }> = [
      {
        ops: [
          { op: "workAsset.capture", clipId: "c1", clipIds: ["c2", "c3"] },
        ],
        code: "INVALID_PARAMS",
      },
      { ops: [{ op: "workAsset.capture", clipIds: ["c1"] }], code: "INVALID_PARAMS" },
      {
        ops: [{ op: "workAsset.capture", clipIds: ["c1", "c1"] }],
        code: "INVALID_PARAMS",
      },
      {
        ops: [{ op: "workAsset.capture", clipIds: ["c1", "nope"] }],
        code: "NOT_FOUND",
      },
    ];
    for (const { ops, code } of cases) {
      const result = await facade["edit.apply"]({ ops });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(code);
    }
    expect(await assetsList()).toHaveLength(0);
  });

  /* -------------------- multi-asset instantiation --------------------- */

  it("expands a multi asset onto fresh lanes preserving relative timing", async () => {
    await seedSecondClip();
    const asset = await captureMulti();
    const assetBefore = structuredClone(asset);

    const first = await facade["edit.apply"]({
      ops: [{ op: "workAsset.instantiate", workAssetId: asset.id }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("instantiate failed");
    const [applied] = first.value.applied;
    // Two new lanes first, then two clips in member order.
    expect(applied.createdIds).toHaveLength(4);
    const [laneA, laneB, clipA, clipB] = applied.createdIds;

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const tracks = state.value.project.timeline.tracks;
    const laneATrack = tracks.find((track) => track.id === laneA);
    const laneBTrack = tracks.find((track) => track.id === laneB);
    expect(laneATrack?.type).toBe("video");
    expect(laneBTrack?.type).toBe("video");
    const anchorClip = laneATrack?.clips.find((clip) => clip.id === clipA);
    const secondClip = laneBTrack?.clips.find((clip) => clip.id === clipB);
    // anchorTime defaults to the timeline end (4): T0 lands exactly there and
    // the second member keeps its 1s offset.
    expect(anchorClip?.startTime).toBe(4);
    expect(secondClip?.startTime).toBe(5);
    expect(anchorClip).toMatchObject({ mediaId, inPoint: 1, outPoint: 5 });
    expect(secondClip).toMatchObject({ mediaId, inPoint: 0, outPoint: 2 });

    // The asset entry is byte-identical after instantiation.
    expect((await assetsList())[0]).toEqual(assetBefore);

    // A second instantiation is a fully independent expansion.
    const second = await facade["edit.apply"]({
      ops: [{ op: "workAsset.instantiate", workAssetId: asset.id }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second instantiate failed");
    const secondIds = second.value.applied[0]?.createdIds ?? [];
    expect(secondIds).toHaveLength(4);
    expect(secondIds[2]).not.toBe(clipA);
    expect(secondIds[3]).not.toBe(clipB);
  });

  it("binds an explicit trackId to the anchor lane and anchors T0 at startTime", async () => {
    await seedSecondClip();
    const asset = await captureMulti();

    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "workAsset.instantiate",
          workAssetId: asset.id,
          trackId: "v1",
          startTime: 10,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("instantiate failed");
    const [applied] = result.value.applied;
    // Only the second lane is new; the anchor reuses v1 (no track/add).
    expect(applied.createdIds).toHaveLength(3);
    const [newLaneId, anchorClipId, secondClipId] = applied.createdIds;
    expect(newLaneId).not.toBe("v1");

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const tracks = state.value.project.timeline.tracks;
    const anchorClip = tracks
      .find((track) => track.id === "v1")
      ?.clips.find((clip) => clip.id === anchorClipId);
    const secondClip = tracks
      .find((track) => track.id === newLaneId)
      ?.clips.find((clip) => clip.id === secondClipId);
    expect(anchorClip?.startTime).toBe(10);
    expect(secondClip?.startTime).toBe(11);
    expect(secondClip?.trackId).toBe(newLaneId);
  });

  it("refuses multi instantiation all-or-nothing when a member's media is gone", async () => {
    const secondImport = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(secondImport.ok).toBe(true);
    if (!secondImport.ok) throw new Error("second import failed");
    const mediaB = secondImport.value.mediaId;
    await seedSecondClip(mediaB);
    const asset = await captureMulti();

    // Delete the second member's media (its clip first: media.remove only
    // accepts unreferenced items).
    await facade["edit.apply"]({
      ops: [
        { op: "clip.remove", clipId: "c1" },
        { op: "clip.remove", clipId: "c2" },
        { op: "media.remove", mediaId: mediaB },
      ],
    });

    const result = await facade["edit.apply"]({
      ops: [{ op: "workAsset.instantiate", workAssetId: asset.id }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    const missingMembers = (
      result.error.details as {
        missingMembers?: Array<{ memberIndex: number; mediaId: string }>;
      }
    ).missingMembers;
    expect(missingMembers).toEqual([{ memberIndex: 1, mediaId: mediaB }]);

    // All-or-nothing: not a single member landed on the timeline.
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    expect(
      state.value.project.timeline.tracks.flatMap((track) => track.clips),
    ).toHaveLength(0);
  });

  it("replays a repeated multi instantiation instead of stacking members", async () => {
    await seedSecondClip();
    const asset = await captureMulti();
    const params = {
      ops: [
        { op: "workAsset.instantiate", workAssetId: asset.id },
      ] as readonly EditOp[],
      idempotencyKey: "multi-once",
    };
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("instantiate failed");
    expect(first.value.replayed).toBe(false);
    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);

    // Exactly the two members exist — the replay stacked nothing.
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const instances = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.id !== "c1" && clip.id !== "c2");
    expect(instances).toHaveLength(2);
  });
});
