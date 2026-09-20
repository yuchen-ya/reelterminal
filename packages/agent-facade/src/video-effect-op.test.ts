/**
 * clip.addVideoEffect — the clip video-effect stack's add entry.
 *
 * Covered behavior:
 *  - the GUI "Auto-Color" preset is exactly three ops in one batch with the
 *    SAME fixed parameters the GUI handler sends (saturation 1.15,
 *    contrast 1.1, brightness 5) — a constant preset, no image analysis,
 *  - the op lands on clip.effects through the same core `effect/add` action
 *    the GUI inspector's effect panel dispatches (undoable, persisted),
 *  - effectType is closed to the GUI effect stack; params keys/ranges are
 *    per-effectType (mirroring the GUI sliders) and rejected — never
 *    clamped — outside them, shader params resolve against the core shader
 *    library's own definitions,
 *  - a deterministic effectId passes through to the persisted effect,
 *  - unknown clips fail NOT_FOUND, invalid params fail INVALID_PARAMS
 *    without moving the revision,
 *  - the core inverse removes the appended effect (one action, one undo),
 *  - capabilities disclose the fixed-preset nature of Auto-Color honestly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import type { EditOp } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, removeTempDir } from "./test-helpers";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";

/** The exact fixed Auto-Color preset parameters the GUI sends. */
const AUTO_COLOR_PRESET = [
  { effectType: "saturation", value: 1.15 },
  { effectType: "contrast", value: 1.1 },
  { effectType: "brightness", value: 5 },
] as const;

describe("clip.addVideoEffect (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("video-effect");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Effects" });
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

  it("applies the Auto-Color fixed preset as three effects in one batch", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: AUTO_COLOR_PRESET.map(({ effectType, value }) => ({
        op: "clip.addVideoEffect",
        clipId: "c1",
        effectType,
        params: { value },
      })),
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    expect(clip.effects.map((effect) => effect.type)).toEqual([
      "saturation",
      "contrast",
      "brightness",
    ]);
    expect(clip.effects.map((effect) => effect.params.value)).toEqual([
      1.15,
      1.1,
      5,
    ]);
    // Stack entries are enabled and persisted like any GUI-added effect.
    for (const effect of clip.effects) {
      expect(effect.enabled).toBe(true);
    }
  });

  it("a deterministic effectId lands on the persisted effect", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{
        op: "clip.addVideoEffect",
        clipId: "c1",
        effectType: "vignette",
        params: { amount: 40, midpoint: 0.5, feather: 0.3 },
        effectId: "fx-vignette-1",
      }],
    });
    expect(result.ok).toBe(true);
    const clip = await clipById("c1");
    const vignette = clip.effects.find((effect) => effect.id === "fx-vignette-1");
    expect(vignette).toBeTruthy();
    expect(vignette!.type).toBe("vignette");
    expect(vignette!.params).toEqual({ amount: 40, midpoint: 0.5, feather: 0.3 });
  });

  it("closes effectType to the GUI effect stack and params to the per-type contracts", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const badOps: readonly unknown[] = [
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "denoise" }, // not in the GUI stack
      { op: "clip.addVideoEffect", clipId: "c1" }, // effectType missing
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "saturation", params: { value: 5 } }, // out of [0, 2]
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "brightness", params: { value: Number.NaN } }, // not finite
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "grayscale", params: { radius: 3 } }, // wrong key for type
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "blur", params: { radius: -1 } }, // out of range
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "glow", params: { radius: 10, color: "lavender" } }, // hex only
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "shader", params: { shaderId: "vhs", bogus: 1 } }, // unknown shader param
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "shader", params: { levels: 5 } }, // shaderId missing
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "shader", params: { shaderId: "made-up-shader" } }, // not builtin
      { op: "clip.addVideoEffect", clipId: "c1", effectType: "blur", params: "radius" }, // params must be an object
    ];
    for (const bad of badOps) {
      const r = await facade["edit.apply"]({
        ops: [bad as unknown as EditOp],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_PARAMS");
      }
    }

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision);
  });

  it("resolves shader params against the core shader definition (vhs)", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{
        op: "clip.addVideoEffect",
        clipId: "c1",
        effectType: "shader",
        params: { shaderId: "vhs", intensity: 0.75, scanlines: 0.4, jitter: 0.45 },
      }],
    });
    expect(result.ok).toBe(true);
    const clip = await clipById("c1");
    expect(clip.effects).toHaveLength(1);
    expect(clip.effects[0]!.type).toBe("shader");
    expect(clip.effects[0]!.params).toEqual({
      shaderId: "vhs",
      intensity: 0.75,
      scanlines: 0.4,
      jitter: 0.45,
    });
  });

  it("fails NOT_FOUND for an unknown clip (timeline clips only)", async () => {
    const r = await facade["edit.apply"]({
      ops: [{ op: "clip.addVideoEffect", clipId: "clip-missing", effectType: "blur" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("translates to the same core effect/add action the GUI panel emits", () => {
    const project = createEmptyProject("Translation");
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

    const actions = opToCoreActions(
      {
        op: "clip.addVideoEffect",
        clipId: "c1",
        effectType: "saturation",
        params: { value: 1.15 },
        effectId: "fx-1",
      },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("effect/add");
    expect(actions[0]!.params).toEqual({
      clipId: "c1",
      effectType: "saturation",
      params: { value: 1.15 },
      effectId: "fx-1",
    });
  });

  it("translation fails NOT_FOUND for an unknown clip before any action is made", () => {
    const project = createEmptyProject("Translation");
    expect(() =>
      opToCoreActions(
        { op: "clip.addVideoEffect", clipId: "nope", effectType: "blur" },
        project,
      ),
    ).toThrowError(/not found/);
  });
});

describe("clip.addVideoEffect undo (core action history)", () => {
  it("the core inverse removes the appended effect", async () => {
    const project = createEmptyProject("UndoEffect");
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
        effects: [],
        audioEffects: [],
      }],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      {
        type: "effect/add",
        id: "effect-add-1",
        timestamp: Date.now(),
        params: { clipId: "c1", effectType: "contrast", params: { value: 1.1 }, effectId: "fx-contrast" },
      },
      project,
    );
    expect(applied.success).toBe(true);
    const clip = project.timeline.tracks[0]!.clips[0]!;
    expect(clip.effects.map((effect) => effect.type)).toEqual(["contrast"]);

    const inverse = history.undo();
    expect(inverse).toBeTruthy();
    await executor.execute(inverse!, project);
    expect(project.timeline.tracks[0]!.clips[0]!.effects).toHaveLength(0);
  });
});

describe("clip.addVideoEffect capability declaration", () => {
  it("discloses the Auto-Color fixed preset honestly (no analysis, no AI)", async () => {
    const mediaRoot = await makeTempDir("video-effect-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const videoEffects = res.value.professionalEditing.videoEffects;
      expect(videoEffects.available).toBe(true);
      expect(videoEffects.details).toMatchObject({
        op: "clip.addVideoEffect",
        coreAction: "effect/add",
      });
      const autoColor = JSON.stringify(videoEffects.details?.autoColor);
      // The preset's exact fixed parameters are disclosed...
      for (const value of ["1.15", "1.1", "value:5"]) {
        expect(autoColor.toLowerCase()).toContain(value);
      }
      // ...and so is the absence of analysis.
      expect(autoColor).toContain("NOT image analysis");
      expect(JSON.stringify(videoEffects)).not.toMatch(
        /ai-powered|"ai"\s*:|powered by ai|intelligent|machine learning/i,
      );
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
