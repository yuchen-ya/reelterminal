/**
 * clip.applyReframe — Auto Reframe landing as an atomic edit.apply op.
 *
 * Covered behavior:
 *  - the op translates into the SAME action batch the GUI reframe panel
 *    emits — [project/updateSettings?, keyframe/setAll] — through the SAME
 *    core conversion (reframeKeyframesToTransformKeyframes), so the persisted
 *    transform keyframes are what preview/export evaluate,
 *  - the resize action is included only when the output size differs, while
 *    the whole op always commits as ONE revision (atomic; no half state),
 *  - keyframe times are source-analysis seconds and the shared conversion
 *    folds them onto the clip-local keyframe clock by clip.speed — the agent
 *    never folds speed itself,
 *  - bounds: times beyond the clip's source span, unknown clips, and missing
 *    media metadata are rejected without moving the revision,
 *  - retries with the same idempotencyKey replay instead of re-applying,
 *  - capabilities.get reports smartReframe with honest heuristic (not-ML)
 *    wording.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import type { EditOp } from "./types";
import { writeTinyMp4, TINY_MP4_EXPECTED } from "./media/fixtures/tiny-mp4";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, removeTempDir } from "./test-helpers";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";

// The fixture source is 320x180; a 9:16 center crop of it.
const SOURCE = { width: TINY_MP4_EXPECTED.width, height: TINY_MP4_EXPECTED.height };
const OUTPUT = { width: 1080, height: 1920 };
const CROP_WIDTH = (SOURCE.height * OUTPUT.width) / OUTPUT.height; // 101.25

function cropAt(time: number, cropX: number) {
  return {
    time,
    cropX,
    cropY: 0,
    cropWidth: CROP_WIDTH,
    cropHeight: SOURCE.height,
  };
}

describe("clip.applyReframe (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("reframe");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Reframe" });
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

  async function projectState() {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    return state.value;
  }

  it("applies the resize and reframed transform keyframes as one revision", async () => {
    await seedClip();
    const before = await projectState();

    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [cropAt(0, (SOURCE.width - CROP_WIDTH) / 2), cropAt(4, SOURCE.width - CROP_WIDTH)],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Atomic: the whole op is exactly one revision bump.
    expect(result.value.revision).toBe(before.revision + 1);

    const after = await projectState();
    expect(after.project.settings.width).toBe(OUTPUT.width);
    expect(after.project.settings.height).toBe(OUTPUT.height);
    const clip = after.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1")!;
    expect(clip.keyframes.length).toBe(8); // 2 crops × 4 properties
    const scaleX = clip.keyframes.filter((k) => k.property === "scale.x");
    // 16:9 → 9:16 contain-fit zoom: (1080/101.25) / (fitScale 1080/320).
    expect(scaleX[0]!.value).toBeCloseTo(3.1605, 4);
    // Times folded to the clip-local clock (speed 1 → unchanged, ≤ duration).
    for (const keyframe of clip.keyframes) {
      expect(keyframe.time).toBeLessThanOrEqual(clip.duration);
    }
  });

  it("omits the resize action when the project already matches the output size", async () => {
    await seedClip();
    const state = await projectState();
    const draft = {
      ...state.project,
      settings: { ...state.project.settings, width: OUTPUT.width, height: OUTPUT.height },
    } as Project;

    const actions = opToCoreActions(
      {
        op: "clip.applyReframe",
        clipId: "c1",
        keyframes: [cropAt(0, (SOURCE.width - CROP_WIDTH) / 2)],
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
      },
      draft,
    );
    expect(actions.map((action) => action.type)).toEqual(["keyframe/setAll"]);
  });

  it("folds keyframe times by clip speed inside the translation", async () => {
    await seedClip();
    const state = await projectState();
    const clip = state.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1")!;
    const spedUp = { ...clip, speed: 2 } as typeof clip;

    const draft = {
      ...state.project,
      timeline: {
        ...state.project.timeline,
        tracks: [
          {
            ...state.project.timeline.tracks[0]!,
            clips: [spedUp],
          },
        ],
      },
    } as Project;

    const actions = opToCoreActions(
      {
        op: "clip.applyReframe",
        clipId: "c1",
        keyframes: [cropAt(1, (SOURCE.width - CROP_WIDTH) / 2), cropAt(2, SOURCE.width - CROP_WIDTH)],
        outputWidth: OUTPUT.width,
        outputHeight: OUTPUT.height,
      },
      draft,
    );
    const setAll = actions.find((action) => action.type === "keyframe/setAll")!;
    const times = (setAll.params as {
      keyframes: { property: string; time: number }[];
    }).keyframes
      .filter((keyframe) => keyframe.property === "position.x")
      .map((keyframe) => keyframe.time);
    expect(times).toEqual([0.5, 1]);
  });

  it("rejects keyframe times beyond the clip source span without moving the revision", async () => {
    await seedClip();
    const before = await projectState();

    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [cropAt(5.5, (SOURCE.width - CROP_WIDTH) / 2)],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }

    const after = await projectState();
    expect(after.revision).toBe(before.revision);
    expect(after.project.settings.width).toBe(before.project.settings.width);
  });

  it("rejects plans whose crop ratio drifts off the output canvas ratio", async () => {
    await seedClip();
    const before = await projectState();

    // 160/180 ≈ 0.889 vs the 0.5625 output ratio — ~58% drift.
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [{ time: 0, cropX: 0, cropY: 0, cropWidth: 160, cropHeight: SOURCE.height }],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
      expect(result.error.message).toContain("must match the output canvas aspect ratio");
      expect(result.error.message).toContain("adjust hand-written plans");
    }

    // Rejected before any action is built: revision, settings, keyframes
    // all unchanged.
    const after = await projectState();
    expect(after.revision).toBe(before.revision);
    expect(after.project.settings.width).toBe(before.project.settings.width);
    const clip = after.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === "c1")!;
    expect(clip.keyframes).toHaveLength(0);
  });

  it("accepts crops inside the ±2% ratio tolerance and rejects just outside", async () => {
    await seedClip();
    const cropWidthFor = (drift: number) =>
      SOURCE.height * (OUTPUT.width / OUTPUT.height) * (1 + drift);

    const inside = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [{
            time: 0,
            cropX: 0,
            cropY: 0,
            cropWidth: cropWidthFor(0.0199),
            cropHeight: SOURCE.height,
          }],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(inside.ok).toBe(true);

    // 2.01% drift — a hair past the tolerance band → INVALID_PARAMS.
    const outside = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [{
            time: 0,
            cropX: 0,
            cropY: 0,
            cropWidth: cropWidthFor(0.0201),
            cropHeight: SOURCE.height,
          }],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("fails NOT_FOUND for an unknown clip", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.applyReframe",
          clipId: "clip-missing",
          keyframes: [cropAt(0, 0)],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("replays the same idempotencyKey instead of re-applying", async () => {
    await seedClip();
    const op: Extract<EditOp, { op: "clip.applyReframe" }> = {
      op: "clip.applyReframe",
      clipId: "c1",
      keyframes: [cropAt(0, (SOURCE.width - CROP_WIDTH) / 2)],
      outputWidth: OUTPUT.width,
      outputHeight: OUTPUT.height,
    };
    const first = await facade["edit.apply"]({
      ops: [op],
      idempotencyKey: "reframe-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await facade["edit.apply"]({
      ops: [op],
      idempotencyKey: "reframe-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
  });
});

describe("clip.applyReframe translation", () => {
  function seedDraft(): Project {
    const project = createEmptyProject("Translation");
    (project.mediaLibrary.items as unknown[]).push({
      id: "m1",
      name: "a.mp4",
      type: "video",
      metadata: {
        duration: 6,
        width: SOURCE.width,
        height: SOURCE.height,
        frameRate: 30,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 4,
      },
    });
    (project.timeline.tracks as unknown[]).push({
      id: "t1",
      type: "video",
      name: "V1",
      clips: [
        {
          id: "c1",
          mediaId: "m1",
          trackId: "t1",
          startTime: 0,
          duration: 5,
          inPoint: 0,
          outPoint: 5,
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
        },
      ],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
    return project;
  }

  const op: Extract<EditOp, { op: "clip.applyReframe" }> = {
    op: "clip.applyReframe",
    clipId: "c1",
    keyframes: [cropAt(0, (SOURCE.width - CROP_WIDTH) / 2)],
    outputWidth: OUTPUT.width,
    outputHeight: OUTPUT.height,
  };

  it("emits [project/updateSettings, keyframe/setAll] — the GUI batch, translated", () => {
    const actions = opToCoreActions(op, seedDraft());
    expect(actions.map((action) => action.type)).toEqual([
      "project/updateSettings",
      "keyframe/setAll",
    ]);
    expect(actions[0]!.params).toEqual({ width: OUTPUT.width, height: OUTPUT.height });
    const setAll = actions[1]!.params as { clipId: string; keyframes: unknown[] };
    expect(setAll.clipId).toBe("c1");
    expect(setAll.keyframes).toHaveLength(4);
  });

  it("translation rejects ratio-mismatched plans before any action is built", () => {
    // 160/180 drifts far off the 0.5625 output ratio.
    expect(() =>
      opToCoreActions(
        {
          op: "clip.applyReframe",
          clipId: "c1",
          keyframes: [{ time: 0, cropX: 0, cropY: 0, cropWidth: 160, cropHeight: SOURCE.height }],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
        },
        seedDraft(),
      ),
    ).toThrowError(/must match the output canvas aspect ratio/);
  });

  it("the emitted actions execute and undo as one group through core", async () => {
    const { ActionExecutor } = await import("@reelterminal/core/actions/action-executor");
    const { ActionHistory } = await import("@reelterminal/core/actions/action-history");
    const project = seedDraft();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    const actions: Action[] = opToCoreActions(op, project);

    // The GUI batch pushes its entries as one group (executeActionBatch →
    // pushGroup); mirror that so one undo reverts the whole op.
    history.beginGroup("Auto Reframe", "human");
    for (const action of actions) {
      const result = await executor.execute(action, project, "human");
      expect(result.success).toBe(true);
    }
    history.endGroup();
    expect(project.settings.width).toBe(OUTPUT.width);
    const clip = project.timeline.tracks[0]!.clips[0]!;
    expect(clip.keyframes.length).toBe(4);

    // One undoGroup step reverts both the resize and the keyframes.
    expect((await executor.undo(project)).success).toBe(true);
    expect(project.settings.width).toBe(1920);
    expect(project.timeline.tracks[0]!.clips[0]!.keyframes).toHaveLength(0);
  });
});

describe("smartReframe capability declaration", () => {
  it("reports the heuristic reframe honestly (no AI wording)", async () => {
    const mediaRoot = await makeTempDir("reframe-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const reframe = res.value.professionalEditing.smartReframe;
      expect(reframe.available).toBe(true);
      expect(reframe.details).toMatchObject({
        op: "clip.applyReframe",
        changesProjectDimensions: true,
        maxKeyframes: 100,
      });
      const algorithm = String(reframe.details?.algorithm);
      expect(algorithm).toContain("not ML");
      expect(JSON.stringify(reframe)).not.toMatch(
        /ai-powered|ai reframe|"ai"\s*:|powered by ai/i,
      );
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
