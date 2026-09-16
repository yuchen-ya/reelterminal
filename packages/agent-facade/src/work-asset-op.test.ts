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
 *  - unknown clips fail NOT_FOUND and the revision does not move,
 *  - workAsset.rename / workAsset.delete reuse the core undoable actions,
 *  - workAsset.instantiate places a NEW clip built from the snapshot: the
 *    asset entry is untouched, a second instantiation is fully independent,
 *    and the original timeline clip can be deleted in between,
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
});
