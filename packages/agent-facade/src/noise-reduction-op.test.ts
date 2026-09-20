/**
 * clip.setNoiseReduction — noise reduction / quick dialog cleanup as an
 * edit.apply op.
 *
 * Covered behavior:
 *  - the op lands the same persisted noiseReduction audio effect the GUI
 *    noise-reduction panel writes through the core audio effect actions;
 *    preset values come from the SHARED core preset module (core
 *    noise-reduction-presets.ts) so GUI and agent cannot drift — this is
 *    deterministic local signal processing (DSP), not AI,
 *  - an existing noiseReduction effect is updated IN PLACE (never stacked)
 *    and re-enabled on apply, matching the GUI panel and the Inspector
 *    quick-cleanup entry; disabling keeps the tuning values,
 *  - a learned spectral profile is preserved across preset switches and its
 *    cross-field shape is validated with the same core predicate the render
 *    chain uses,
 *  - parameter boundaries ([-80,0] dB, [0,1] reduction, preset allowlist,
 *    required enabled, closed field set) are rejected with INVALID_PARAMS
 *    and the revision does not move,
 *  - unknown clips (and disabling a clip that has no such effect) fail
 *    NOT_FOUND,
 *  - retries with the same idempotencyKey replay instead of re-applying
 *    (the shared edit.apply requestId ledger — no new idempotency code),
 *  - the op translates to exactly the core audio/addEffect or
 *    audio/updateEffect(+audio/toggleEffect) actions whose inverses (owned
 *    by core) restore the prior state, so GUI undo and agent-issued edits
 *    share one history semantic,
 *  - timeline.query exposes the noiseReduction state so agents can verify
 *    the edit like any other clip field,
 *  - capabilities.get reports the capability with honest DSP wording
 *    (never "AI").
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
import {
  DEFAULT_NOISE_REDUCTION_SETTINGS,
  getNoiseReductionPreset,
  NOISE_REDUCTION_PRESETS,
} from "@reelterminal/core/audio/noise-reduction-presets";
import type { Action } from "@reelterminal/core/types/actions";
import type { Clip, Effect } from "@reelterminal/core/types/timeline";

const noiseEffectOf = (clip: Clip): Effect | undefined =>
  (clip.audioEffects ?? []).find(
    (candidate) => candidate.type === "noiseReduction",
  );

describe("clip.setNoiseReduction (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("noise-reduction");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Noise" });
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

  async function clipById(id: string): Promise<Clip> {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("state failed");
    const clip = state.value.project.timeline.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === id);
    expect(clip).toBeTruthy();
    return clip!;
  }

  it("applies the shared speech preset (GUI quick-cleanup values)", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setNoiseReduction",
          clipId: "c1",
          enabled: true,
          preset: "speech",
        },
      ],
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    const effect = noiseEffectOf(clip);
    expect(effect).toBeTruthy();
    expect(effect!.enabled).toBe(true);
    // Same symbol the GUI panel imports — the preset values cannot drift.
    expect(effect!.params).toEqual(getNoiseReductionPreset("speech").config);
  });

  it("updates an existing effect in place instead of stacking", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setNoiseReduction",
          clipId: "c1",
          enabled: true,
          preset: "speech",
        },
      ],
    });
    const first = await clipById("c1");
    expect((first.audioEffects ?? []).length).toBe(1);

    // Second apply with explicit params: still ONE effect, params replaced.
    await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setNoiseReduction",
          clipId: "c1",
          enabled: true,
          threshold: -50,
          reduction: 0.75,
        },
      ],
    });
    const second = await clipById("c1");
    const effects = second.audioEffects ?? [];
    expect(effects.length).toBe(1);
    // Omitted fields keep prior (speech preset) values; explicit ones win.
    expect(second.audioEffects?.[0]!.params).toEqual({
      ...getNoiseReductionPreset("speech").config,
      threshold: -50,
      reduction: 0.75,
    });
  });

  it("re-enables a disabled effect on apply (GUI apply semantics)", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "balanced" },
      ],
    });
    await facade["edit.apply"]({
      ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: false }],
    });
    let clip = await clipById("c1");
    expect(clip.audioEffects?.[0]!.enabled).toBe(false);
    // Disabling keeps the tuning values, matching the GUI toggle.
    expect(clip.audioEffects?.[0]!.params).toEqual(
      getNoiseReductionPreset("balanced").config,
    );

    await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "wind" },
      ],
    });
    clip = await clipById("c1");
    expect((clip.audioEffects ?? []).length).toBe(1);
    expect(clip.audioEffects?.[0]!.enabled).toBe(true);
    expect(clip.audioEffects?.[0]!.params).toEqual(
      getNoiseReductionPreset("wind").config,
    );
  });

  it("preserves a learned profile across preset switches", async () => {
    await seedClip();
    const profile = {
      frequencyBins: [100, 200],
      magnitudes: [0.5, 0.4],
      standardDeviations: [0.1, 0.2],
      sampleRate: 48000,
      fftSize: 4,
    };
    await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setNoiseReduction",
          clipId: "c1",
          enabled: true,
          preset: "speech",
          profile,
        },
      ],
    });
    await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "hum" },
      ],
    });
    const clip = await clipById("c1");
    // GUI behavior: switching presets keeps the learned noise profile.
    expect(clip.audioEffects?.[0]!.params).toEqual({
      ...getNoiseReductionPreset("hum").config,
      profile,
    });
  });

  it("fails NOT_FOUND for an unknown clip", async () => {
    const r = await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "clip-missing", enabled: true },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("fails NOT_FOUND when disabling a clip without a noise effect", async () => {
    await seedClip();
    const r = await facade["edit.apply"]({
      ops: [{ op: "clip.setNoiseReduction", clipId: "c1", enabled: false }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects invalid parameters without moving the revision", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    // Deliberately malformed payloads — typed as unknown because they fail
    // the boundary (and TypeScript) before anything is applied.
    const badOps: readonly unknown[] = [
      { op: "clip.setNoiseReduction", clipId: "c1", preset: "speech" }, // enabled missing
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, threshold: -90 },
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, threshold: 5 },
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, reduction: 1.5 },
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, attack: 150 },
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, release: -1 },
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "vocal" }, // unknown preset
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, effectId: "n1" }, // unknown field
      {
        op: "clip.setNoiseReduction",
        clipId: "c1",
        enabled: true,
        profile: { frequencyBins: [100, 200], magnitudes: [0.5], sampleRate: 48000 },
      }, // profile length mismatch
      {
        op: "clip.setNoiseReduction",
        clipId: "c1",
        enabled: true,
        profile: { frequencyBins: [100], magnitudes: [0.5], sampleRate: 48000, fftSize: 1024 },
      }, // fftSize must be 2 × magnitudes.length
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
    expect(projectJson(after.value.project)).toBe(beforeJson);
  });

  it("replays the same idempotencyKey instead of re-applying", async () => {
    await seedClip();
    const first = await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "speech" },
      ],
      idempotencyKey: "cleanup-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await facade["edit.apply"]({
      ops: [
        { op: "clip.setNoiseReduction", clipId: "c1", enabled: true, preset: "speech" },
      ],
      idempotencyKey: "cleanup-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
    const clip = await clipById("c1");
    expect((clip.audioEffects ?? []).length).toBe(1);
  });

  it("timeline.query exposes the noiseReduction state when requested", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setNoiseReduction",
          clipId: "c1",
          enabled: true,
          preset: "speech",
        },
      ],
    });

    const query = await facade["timeline.query"]({
      entityTypes: ["clip"],
      fields: ["type", "noiseReduction"],
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.items).toHaveLength(1);
    expect(query.value.items[0]!.data.noiseReduction).toMatchObject({
      enabled: true,
      ...getNoiseReductionPreset("speech").config,
    });
  });

  it("translates to audio/addEffect on a clip without the effect", () => {
    const project = createEmptyProject("Translation");
    seedRawClip(project);

    const actions = opToCoreActions(
      {
        op: "clip.setNoiseReduction",
        clipId: "c1",
        enabled: true,
        preset: "speech",
      },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("audio/addEffect");
    const effect = (actions[0]!.params as { effect: Effect }).effect;
    expect(effect.type).toBe("noiseReduction");
    expect(effect.enabled).toBe(true);
    expect(effect.params).toEqual(getNoiseReductionPreset("speech").config);
  });

  it("translates to audio/updateEffect + toggle for an existing disabled effect", () => {
    const project = createEmptyProject("Translation");
    seedRawClip(project, [
      {
        id: "n1",
        type: "noiseReduction",
        params: { ...getNoiseReductionPreset("balanced").config },
        enabled: false,
      },
    ]);

    const actions = opToCoreActions(
      {
        op: "clip.setNoiseReduction",
        clipId: "c1",
        enabled: true,
        preset: "speech",
      },
      project,
    );

    expect(actions).toHaveLength(2);
    expect(actions[0]!.type).toBe("audio/updateEffect");
    expect(actions[0]!.params).toEqual({
      clipId: "c1",
      effectId: "n1",
      params: getNoiseReductionPreset("speech").config,
    });
    expect(actions[1]!.type).toBe("audio/toggleEffect");
    expect(actions[1]!.params).toEqual({
      clipId: "c1",
      effectId: "n1",
      enabled: true,
    });
  });

  it("translation omits the toggle when the effect is already enabled", () => {
    const project = createEmptyProject("Translation");
    seedRawClip(project, [
      {
        id: "n1",
        type: "noiseReduction",
        params: { ...DEFAULT_NOISE_REDUCTION_SETTINGS },
        enabled: true,
      },
    ]);

    const actions = opToCoreActions(
      { op: "clip.setNoiseReduction", clipId: "c1", enabled: true },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("audio/updateEffect");
    expect(actions[0]!.params).toEqual({
      clipId: "c1",
      effectId: "n1",
      params: { ...DEFAULT_NOISE_REDUCTION_SETTINGS },
    });
  });

  it("translation fails NOT_FOUND for an unknown clip before any action is made", () => {
    const project = createEmptyProject("Translation");
    expect(() =>
      opToCoreActions(
        { op: "clip.setNoiseReduction", clipId: "nope", enabled: true },
        project,
      ),
    ).toThrowError(/not found/);
  });
});

/** Seed one raw clip (translation runs pre-execution, no media needed). */
function seedRawClip(
  project: ReturnType<typeof createEmptyProject>,
  audioEffects: Effect[] = [],
): void {
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
        audioEffects,
        volume: 1,
        transform: {
          position: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotation: 0,
          anchor: { x: 0.5, y: 0.5 },
          opacity: 1,
        },
        keyframes: [],
      },
    ],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  });
}

describe("clip.setNoiseReduction undo (core action history)", () => {
  function seedProject(): ReturnType<typeof createEmptyProject> {
    const project = createEmptyProject("UndoNoise");
    seedRawClip(project);
    return project;
  }

  const mk = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params,
  });

  function clipOf(project: ReturnType<typeof createEmptyProject>): Clip {
    return project.timeline.tracks[0]!.clips[0] as unknown as Clip;
  }

  it("the addEffect inverse removes the whole effect", async () => {
    const project = seedProject();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      mk("audio/addEffect", {
        clipId: "c1",
        effect: {
          id: "n1",
          type: "noiseReduction",
          params: { ...getNoiseReductionPreset("speech").config },
          enabled: true,
        },
      }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(clipOf(project).audioEffects).toHaveLength(1);

    const inverse = history.undo();
    expect(inverse?.type).toBe("audio/removeEffect");
    await executor.execute(inverse!, project);
    expect(clipOf(project).audioEffects).toHaveLength(0);
  });

  it("the updateEffect+toggle inverses restore prior params and enabled", async () => {
    const project = seedProject();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    await executor.execute(
      mk("audio/addEffect", {
        clipId: "c1",
        effect: {
          id: "n1",
          type: "noiseReduction",
          params: { ...getNoiseReductionPreset("balanced").config },
          enabled: false,
        },
      }),
      project,
    );

    // The op's update path: params snapshot, then re-enable.
    await executor.execute(
      mk("audio/updateEffect", {
        clipId: "c1",
        effectId: "n1",
        params: { ...getNoiseReductionPreset("speech").config },
      }),
      project,
    );
    await executor.execute(
      mk("audio/toggleEffect", { clipId: "c1", effectId: "n1", enabled: true }),
      project,
    );
    expect(clipOf(project).audioEffects?.[0]!.enabled).toBe(true);
    expect(clipOf(project).audioEffects?.[0]!.params).toEqual(
      getNoiseReductionPreset("speech").config,
    );

    // Undo in reverse order: the toggle inverse restores enabled=false, the
    // update inverse restores the prior balanced params — the core-owned
    // inverses invert the op's action batch back to the prior state.
    // (Both inverses are collected before executing: executing any action —
    // including an inverse — pushes a new history entry.)
    const toggleInverse = history.undo();
    expect(toggleInverse?.type).toBe("audio/toggleEffect");
    const updateInverse = history.undo();
    expect(updateInverse?.type).toBe("audio/updateEffect");
    await executor.execute(toggleInverse!, project);
    await executor.execute(updateInverse!, project);

    expect(clipOf(project).audioEffects?.[0]!.enabled).toBe(false);
    expect(clipOf(project).audioEffects?.[0]!.params).toEqual(
      getNoiseReductionPreset("balanced").config,
    );
  });
});

describe("clip.setNoiseReduction capability declaration", () => {
  it("reports the local DSP honestly (no AI wording)", async () => {
    const mediaRoot = await makeTempDir("noise-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const capability = res.value.professionalEditing.noiseReduction;
      expect(capability.available).toBe(true);
      expect(capability.details).toMatchObject({
        op: "clip.setNoiseReduction",
        coreActions: [
          "audio/addEffect",
          "audio/updateEffect",
          "audio/toggleEffect",
        ],
        defaults: {
          threshold: DEFAULT_NOISE_REDUCTION_SETTINGS.threshold,
          reduction: DEFAULT_NOISE_REDUCTION_SETTINGS.reduction,
          attack: DEFAULT_NOISE_REDUCTION_SETTINGS.attack,
          release: DEFAULT_NOISE_REDUCTION_SETTINGS.release,
          focus: DEFAULT_NOISE_REDUCTION_SETTINGS.focus,
        },
        presets: NOISE_REDUCTION_PRESETS.map((preset) => preset.id),
      });
      const algorithm = String(capability.details?.algorithm);
      // Honest wording: disclosed as deterministic local signal processing
      // and never presented AS model inference (fixed presets and DSP must
      // not pass as AI).
      expect(algorithm).toContain("not AI or model inference");
      expect(JSON.stringify(capability)).not.toMatch(
        /ai-powered|ai denoise|ai noise|"ai"\s*:|powered by ai/i,
      );
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
