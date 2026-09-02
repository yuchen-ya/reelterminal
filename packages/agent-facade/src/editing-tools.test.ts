import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("finishing edit tools", () => {
  let mediaRoot: string;
  let facade: AgentFacade;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("editing-tools");
    const inputPath = writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Finishing tools" });
    const imported = await facade["media.import"]({ path: inputPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.error.message);

    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "video", trackId: "v2" },
        { op: "track.add", trackType: "audio", trackId: "a1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          duration: 4,
          inPoint: 0,
          outPoint: 4,
          clipId: "c1",
        },
        {
          op: "clip.add",
          trackId: "a1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          duration: 4,
          inPoint: 0,
          outPoint: 4,
          clipId: "a-clip",
        },
      ],
    });
    expect(seeded.ok).toBe(true);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  it("moves, splits, retimes and fades clips with created-id and replay reporting", async () => {
    const moved = await facade["edit.apply"]({
      ops: [{ op: "clip.move", clipId: "c1", startTime: 2, trackId: "v2" }],
    });
    expect(moved.ok).toBe(true);

    const splitParams = {
      ops: [{ op: "clip.split", clipId: "c1", time: 3.5 }],
      idempotencyKey: "split-once",
    } as const;
    const split = await facade["edit.apply"](splitParams);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.applied[0]?.createdIds).toHaveLength(1);
    const rightClipId = split.value.applied[0]!.createdIds[0]!;

    const replay = await facade["edit.apply"](splitParams);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.applied).toEqual(split.value.applied);

    const finishing = await facade["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: rightClipId, speed: 2 },
        { op: "clip.setReverse", clipId: rightClipId, reversed: true },
        {
          op: "clip.setTransform",
          clipId: "c1",
          transform: {
            position: { x: 80, y: -20 },
            scale: { x: 0.75, y: 0.75 },
            rotation: 15,
            opacity: 0.8,
            fitMode: "cover",
            crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          },
        },
        { op: "clip.setFade", clipId: "a-clip", fadeIn: 0.25, fadeOut: 0.5 },
      ],
    });
    expect(finishing.ok).toBe(true);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const v2 = state.value.project.timeline.tracks.find((track) => track.id === "v2");
    expect(v2?.clips).toHaveLength(2);
    expect(v2?.clips.find((clip) => clip.id === "c1")).toMatchObject({
      startTime: 2,
      duration: 1.5,
      outPoint: 1.5,
      transform: {
        position: { x: 80, y: -20 },
        scale: { x: 0.75, y: 0.75 },
        rotation: 15,
        opacity: 0.8,
        fitMode: "cover",
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      },
    });
    expect(v2?.clips.find((clip) => clip.id === rightClipId)).toMatchObject({
      startTime: 3.5,
      duration: 1.25,
      inPoint: 1.5,
      outPoint: 4,
      speed: 2,
      reversed: true,
    });
    const audio = state.value.project.timeline.tracks
      .find((track) => track.id === "a1")
      ?.clips.find((clip) => clip.id === "a-clip");
    expect(audio?.fade).toEqual({ fadeIn: 0.25, fadeOut: 0.5 });
  });

  it("clears an existing crop and reports the effective compact transform", async () => {
    const cropped = await facade["edit.apply"]({
      ops: [{
        op: "clip.setTransform",
        clipId: "c1",
        transform: { crop: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 } },
      }],
    });
    expect(cropped.ok).toBe(true);
    const cleared = await facade["edit.apply"]({
      ops: [{
        op: "clip.setTransform",
        clipId: "c1",
        transform: { clearCrop: true },
      }],
    });
    expect(cleared.ok).toBe(true);

    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const clip = timeline.value.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1");
    expect(clip?.transform).toMatchObject({
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
      fitMode: "contain",
      crop: null,
    });
  });

  it("keeps trim duration in timeline seconds after a constant-speed change", async () => {
    const result = await facade["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: "c1", speed: 2 },
        { op: "clip.trim", clipId: "c1", inPoint: 1, outPoint: 3 },
      ],
    });
    expect(result.ok).toBe(true);

    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const clip = timeline.value.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1");
    expect(clip).toMatchObject({
      inPoint: 1,
      outPoint: 3,
      duration: 1,
      speed: 2,
    });
  });

  it("duplicates into the next free gap and ripple-deletes with the editor's timing semantics", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "clip.duplicate", clipId: "c1" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.applied[0]?.createdIds).toHaveLength(1);
    const firstId = first.value.applied[0]!.createdIds[0]!;

    const second = await facade["edit.apply"]({
      ops: [{ op: "clip.duplicate", clipId: "c1" }],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = second.value.applied[0]!.createdIds[0]!;

    let timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    let clips = timeline.value.tracks.find((track) => track.id === "v1")?.clips;
    expect(clips?.find((clip) => clip.id === firstId)?.startTime).toBe(4);
    expect(clips?.find((clip) => clip.id === secondId)?.startTime).toBe(8);

    const ripple = await facade["edit.apply"]({
      ops: [{ op: "clip.rippleDelete", clipId: firstId }],
    });
    expect(ripple.ok).toBe(true);

    timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    clips = timeline.value.tracks.find((track) => track.id === "v1")?.clips;
    expect(clips?.some((clip) => clip.id === firstId)).toBe(false);
    expect(clips?.find((clip) => clip.id === secondId)?.startTime).toBe(4);
  });

  it("adds, updates, reads and removes a renderer-compatible clip transition", async () => {
    const duplicated = await facade["edit.apply"]({
      ops: [{ op: "clip.duplicate", clipId: "c1" }],
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const incomingId = duplicated.value.applied[0]!.createdIds[0]!;

    const added = await facade["edit.apply"]({
      ops: [{
        op: "transition.add",
        clipAId: "c1",
        clipBId: incomingId,
        type: "crossfade",
        duration: 0.5,
      }],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.applied[0]?.createdIds).toHaveLength(1);
    const transitionId = added.value.applied[0]!.createdIds[0]!;

    const updated = await facade["edit.apply"]({
      ops: [{
        op: "transition.update",
        transitionId,
        type: "dipToBlack",
        duration: 0.75,
      }],
    });
    expect(updated.ok).toBe(true);

    let timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.value.tracks.find((track) => track.id === "v1")?.transitions)
      .toContainEqual({
        id: transitionId,
        clipAId: "c1",
        clipBId: incomingId,
        edge: null,
        type: "dipToBlack",
        duration: 0.75,
      });

    const removed = await facade["edit.apply"]({
      ops: [{ op: "transition.remove", transitionId }],
    });
    expect(removed.ok).toBe(true);
    timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    expect(timeline.value.tracks.find((track) => track.id === "v1")?.transitions)
      .toEqual([]);
  });

  it("rejects unsafe bounds and missing targets without changing the project", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const cases = [
      ["split boundary", [{ op: "clip.split", clipId: "c1", time: 0 }]],
      ["speed below minimum", [{ op: "clip.setSpeed", clipId: "c1", speed: 0.01 }]],
      ["empty transform", [{ op: "clip.setTransform", clipId: "c1", transform: {} }]],
      ["crop outside source", [{ op: "clip.setTransform", clipId: "c1", transform: { crop: { x: 0.5, y: 0, width: 0.75, height: 1 } } }]],
      ["audio-track transform", [{ op: "clip.setTransform", clipId: "a-clip", transform: { opacity: 0.5 } }]],
      ["fade longer than clip", [{ op: "clip.setFade", clipId: "a-clip", fadeIn: 5 }]],
      ["missing move target", [{ op: "clip.move", clipId: "c1", startTime: 1, trackId: "missing" }]],
    ] as const;
    for (const [label, ops] of cases) {
      const result = await facade["edit.apply"]({ ops });
      expect(result.ok, label).toBe(false);
    }

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
    expect(after.value.project).toEqual(before.value.project);
  });

  it("rolls back an earlier move when a later split in the same batch is invalid", async () => {
    const result = await facade["edit.apply"]({
      ops: [
        { op: "clip.move", clipId: "c1", startTime: 2 },
        { op: "clip.split", clipId: "c1", time: 1 },
      ],
    });
    expect(result.ok).toBe(false);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const clip = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1");
    expect(clip?.startTime).toBe(0);
  });
});
