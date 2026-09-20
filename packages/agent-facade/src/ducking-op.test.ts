/**
 * clip.setDucking — audio ducking as an edit.apply op.
 *
 * Covered behavior:
 *  - the op persists the SAME two fields the GUI ducking panel writes through
 *    the core audio/setDucking action: clip.automation.volume (the points the
 *    realtime preview AND export evaluation consume) plus the
 *    metadata.audioDucking panel-readback snapshot,
 *  - keyframes come from envelope detection: pre-computed points are passed
 *    through, presenceRanges are synthesized by the shared core AudioDucker
 *    kernel (facade -> core dependency), and an empty synthesis is rejected,
 *  - the closed schema rejects unknown fields and out-of-range tuning; the
 *    batch stays atomic (nothing lands, revision does not move),
 *  - retries with the same idempotencyKey replay (shared edit.apply ledger),
 *  - the core inverse restores BOTH fields, so GUI undo and agent edits share
 *    one history semantic,
 *  - capabilities.get reports audioDucking as available with honest wording
 *    (deterministic envelope detection, not AI; one preview/export chain).
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import type { EditOp } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";

const TUNING = {
  threshold: -30,
  reduction: 0.6,
  attack: 0.1,
  release: 0.3,
  holdTime: 0.2,
};

describe("clip.setDucking (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("ducking");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Ducking" });
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
  });

  async function seedClip(clipId = "c1"): Promise<void> {
    const imported = await facade["media.import"]({
      path: `${mediaRoot}/tiny-6s.mp4`,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: imported.value.mediaId,
          startTime: 0,
          duration: 5,
          clipId,
        },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error("seed failed");
  }

  async function clipById(id: string) {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    const clip = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === id);
    expect(clip).toBeTruthy();
    return clip!;
  }

  it("persists pre-computed points and the panel readback snapshot", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        points: [
          { time: 0, value: 1 },
          { time: 1, value: 0.4 },
          { time: 2, value: 1 },
        ],
      }],
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    expect(clip.automation?.volume).toEqual([
      { time: 0, value: 1 },
      { time: 1, value: 0.4 },
      { time: 2, value: 1 },
    ]);
    expect(clip.metadata?.audioDucking).toEqual({
      enabled: true,
      sourceTrackId: null,
      ...TUNING,
    });
  });

  it("synthesizes keyframes from presenceRanges with the shared AudioDucker kernel", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        presenceRanges: [{ start: 1, end: 2 }],
      }],
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    const points = clip.automation?.volume ?? [];
    // 4 keyframes per merged presence window: normal→duck→hold→release.
    expect(points).toHaveLength(4);
    expect(points[0]!.time).toBeCloseTo(0.9, 5);
    expect(points[0]!.value).toBeCloseTo(1, 5);
    expect(points[1]!.time).toBeCloseTo(1, 5);
    expect(points[1]!.value).toBeCloseTo(1 * (1 - 0.6), 5);
    expect(points[2]!.time).toBeCloseTo(2, 5);
    expect(points[3]!.time).toBeCloseTo(2.3, 5);
    expect(clip.metadata?.audioDucking).toMatchObject({ enabled: true });
  });

  it("rejects an empty synthesis (no speech crossed the threshold)", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error("state failed");
    const beforeJson = projectJson(before.value.project);

    const r = await facade["edit.apply"]({
      ops: [{
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        presenceRanges: [],
      }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PARAMS");

    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error("state failed");
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
  });

  it("fails NOT_FOUND for an unknown clip", async () => {
    const r = await facade["edit.apply"]({
      ops: [{
        op: "clip.setDucking",
        clipId: "clip-missing",
        ...TUNING,
        presenceRanges: [{ start: 0, end: 1 }],
      }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed ops without moving the revision (closed schema + keyframe source)", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error("state failed");
    const beforeJson = projectJson(before.value.project);

    const badOps: readonly unknown[] = [
      // unknown field
      { op: "clip.setDucking", clipId: "c1", ...TUNING, sourceTrackId: "t9", points: [{ time: 0, value: 1 }] },
      // tuning out of range
      { op: "clip.setDucking", clipId: "c1", ...TUNING, threshold: -61, points: [{ time: 0, value: 1 }] },
      { op: "clip.setDucking", clipId: "c1", ...TUNING, reduction: 1.5, points: [{ time: 0, value: 1 }] },
      // point out of range
      { op: "clip.setDucking", clipId: "c1", ...TUNING, points: [{ time: 0, value: 9 }] },
      { op: "clip.setDucking", clipId: "c1", ...TUNING, points: [{ time: -1, value: 1 }] },
      // no keyframe source
      { op: "clip.setDucking", clipId: "c1", ...TUNING },
      // both sources
      {
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        points: [{ time: 0, value: 1 }],
        presenceRanges: [{ start: 0, end: 1 }],
      },
      // range end <= start
      { op: "clip.setDucking", clipId: "c1", ...TUNING, presenceRanges: [{ start: 2, end: 2 }] },
    ];
    for (const bad of badOps) {
      const r = await facade["edit.apply"]({ ops: [bad as unknown as EditOp] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PARAMS");
    }

    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error("state failed");
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
  });

  it("keeps a batch atomic: a valid ducking op does not survive an invalid sibling", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    if (!before.ok) throw new Error("state failed");
    const beforeJson = projectJson(before.value.project);

    const r = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setDucking",
          clipId: "c1",
          ...TUNING,
          presenceRanges: [{ start: 0.5, end: 1.5 }],
        },
        // Invalid sibling: unknown clip fails NOT_FOUND mid-batch.
        { op: "clip.move", clipId: "clip-missing", startTime: 1 },
      ],
    });
    expect(r.ok).toBe(false);

    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error("state failed");
    expect(after.value.revision).toBe(before.value.revision);
    expect(projectJson(after.value.project)).toBe(beforeJson);
    const clip = await clipById("c1");
    expect(clip.automation?.volume ?? []).toHaveLength(0);
  });

  it("replays the same idempotencyKey instead of re-applying", async () => {
    await seedClip();
    const op = {
      op: "clip.setDucking" as const,
      clipId: "c1",
      ...TUNING,
      presenceRanges: [{ start: 1, end: 2 }],
    };
    const first = await facade["edit.apply"]({
      ops: [op],
      idempotencyKey: "duck-on",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await facade["edit.apply"]({
      ops: [op],
      idempotencyKey: "duck-on",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
  });
});

describe("clip.setDucking translation + undo (core semantics)", () => {
  function seedProjectWithClip() {
    const project = createEmptyProject("UndoDucking");
    (project.timeline.tracks as unknown[]).push({
      id: "t1",
      type: "video",
      name: "V1",
      clips: [{
        id: "c1",
        mediaId: "m1",
        trackId: "t1",
        startTime: 0,
        duration: 5,
        inPoint: 0,
        outPoint: 5,
      }],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
    return project;
  }

  function clipOf(project: ReturnType<typeof createEmptyProject>) {
    return project.timeline.tracks[0]!.clips[0]!;
  }

  it("translates to exactly one audio/setDucking action targeting the clip", () => {
    const project = seedProjectWithClip();
    const actions = opToCoreActions(
      {
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        points: [{ time: 0, value: 1 }],
      },
      project,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("audio/setDucking");
    expect(actions[0]!.params).toMatchObject({
      clipId: "c1",
      settings: { enabled: true, sourceTrackId: null, ...TUNING },
      points: [{ time: 0, value: 1 }],
    });
  });

  it("the core inverse restores BOTH the volume points and the readback snapshot", async () => {
    const project = seedProjectWithClip();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const [action] = opToCoreActions(
      {
        op: "clip.setDucking",
        clipId: "c1",
        ...TUNING,
        presenceRanges: [{ start: 1, end: 2 }],
      },
      project,
    );
    const applied = await executor.execute(action!, project);
    expect(applied.success).toBe(true);
    expect(clipOf(project).automation?.volume?.length).toBeGreaterThan(0);
    expect(clipOf(project).metadata?.audioDucking).toMatchObject({
      enabled: true,
    });

    const inverse = history.undo();
    expect(inverse?.type).toBe("audio/clearDucking");
    await executor.execute(inverse!, project);
    expect(clipOf(project).automation).toBeUndefined();
    expect(clipOf(project).metadata?.audioDucking).toBeUndefined();
  });
});

describe("clip.setDucking capability declaration", () => {
  it("reports audioDucking as available with honest envelope-detection wording", async () => {
    const mediaRoot = await makeTempDir("ducking-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const ducking = res.value.professionalEditing.audioDucking;
      expect(ducking.available).toBe(true);
      expect(ducking.details).toMatchObject({
        op: "clip.setDucking",
        coreAction: "audio/setDucking",
      });
      const algorithm = String(ducking.details?.algorithm);
      expect(algorithm).toContain("envelope detection");
      expect(algorithm).toContain("not AI");
      const evaluation = String(ducking.details?.evaluation);
      expect(evaluation).toContain("export");
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
