/**
 * clip.setChromaKey — quick green-screen keying as an edit.apply op.
 *
 * Covered behavior:
 *  - the op lands the same persisted `clip.chromaKey` settings the GUI
 *    green-screen panel writes through the core clip/setChromaKey action;
 *    omitted tuning fields keep the clip's prior values and fall back to the
 *    shared engine defaults (green key, tolerance 0.3, softness 0.1,
 *    spill 0.5) — this is a fixed color-distance keyer, not AI matting,
 *  - parameter boundaries ([0,1] ranges, required enabled, closed field set)
 *    are rejected with INVALID_PARAMS and the revision does not move,
 *  - unknown clips fail NOT_FOUND,
 *  - retries with the same idempotencyKey replay instead of re-applying
 *    (the shared edit.apply requestId ledger — no new idempotency code),
 *  - the op translates to exactly one core clip/setChromaKey action whose
 *    inverse (owned by core) restores the prior settings, so GUI undo and
 *    agent-issued edits share one history semantic,
 *  - timeline.query exposes the chromaKey state so agents can verify the
 *    edit like any other clip field,
 *  - capabilities.get reports the capability with honest fixed-algorithm
 *    wording (never "AI").
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import type { EditOp } from "./types";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, projectJson, removeTempDir } from "./test-helpers";
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "@openreel/core/video/chroma-key-engine";
import type { Action } from "@openreel/core/types/actions";
import type { ChromaKeySettings } from "@openreel/core/types/timeline";

describe("clip.setChromaKey (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("chroma-key");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Chroma" });
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

  it("enables the keyer with the shared engine defaults (fixed green key)", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true }],
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    const expected: ChromaKeySettings = {
      enabled: true,
      keyColor: { ...DEFAULT_CHROMA_KEY_SETTINGS.keyColor },
      tolerance: DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
      edgeSoftness: DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
      spillSuppression: DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
    };
    expect(clip.chromaKey).toEqual(expected);
  });

  it("merges partial updates onto prior settings and disable keeps them", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [{
        op: "clip.setChromaKey",
        clipId: "c1",
        enabled: true,
        tolerance: 0.35,
        edgeSoftness: 0.2,
      }],
    });

    // Re-key to blue: prior tolerance/softness survive, defaults fill spill.
    await facade["edit.apply"]({
      ops: [{
        op: "clip.setChromaKey",
        clipId: "c1",
        enabled: true,
        keyColor: { r: 0, g: 0, b: 1 },
        spillSuppression: 0.6,
      }],
    });
    let clip = await clipById("c1");
    expect(clip.chromaKey).toEqual({
      enabled: true,
      keyColor: { r: 0, g: 0, b: 1 },
      tolerance: 0.35,
      edgeSoftness: 0.2,
      spillSuppression: 0.6,
    });

    // Disabling keeps the tuning values, matching the GUI toggle.
    await facade["edit.apply"]({
      ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: false }],
    });
    clip = await clipById("c1");
    expect(clip.chromaKey).toEqual({
      enabled: false,
      keyColor: { r: 0, g: 0, b: 1 },
      tolerance: 0.35,
      edgeSoftness: 0.2,
      spillSuppression: 0.6,
    });
  });

  it("fails NOT_FOUND for an unknown clip", async () => {
    const r = await facade["edit.apply"]({
      ops: [{ op: "clip.setChromaKey", clipId: "clip-missing", enabled: true }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects out-of-range tuning without moving the revision", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    // Deliberately malformed payloads — typed as unknown because they fail
    // the boundary (and TypeScript) before anything is applied.
    const badOps: readonly unknown[] = [
      { op: "clip.setChromaKey", clipId: "c1", tolerance: 0.5 }, // enabled missing
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, tolerance: 1.5 },
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, tolerance: -0.1 },
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, keyColor: { r: 2, g: 0, b: 0 } },
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, keyColor: { r: 0, g: 1 } },
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, preset: "green" }, // unknown field
      { op: "clip.setChromaKey", clipId: "c1", enabled: "yes" },
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
      ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true }],
      idempotencyKey: "chroma-on",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await facade["edit.apply"]({
      ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true }],
      idempotencyKey: "chroma-on",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
  });

  it("timeline.query exposes the chromaKey state when requested", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [{ op: "clip.setChromaKey", clipId: "c1", enabled: true, tolerance: 0.35 }],
    });

    const query = await facade["timeline.query"]({
      entityTypes: ["clip"],
      fields: ["type", "chromaKey"],
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.items).toHaveLength(1);
    expect(query.value.items[0]!.data.chromaKey).toMatchObject({
      enabled: true,
      tolerance: 0.35,
      keyColor: { r: 0, g: 1, b: 0 },
    });
  });

  it("translates to the same core clip/setChromaKey action the GUI emits", () => {
    const project = createEmptyProject("Translation");
    // Seed a minimal video clip directly (translation runs pre-execution).
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
      { op: "clip.setChromaKey", clipId: "c1", enabled: true, tolerance: 0.35 },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("clip/setChromaKey");
    expect(actions[0]!.params).toEqual({
      clipId: "c1",
      chromaKey: {
        enabled: true,
        keyColor: { ...DEFAULT_CHROMA_KEY_SETTINGS.keyColor },
        tolerance: 0.35,
        edgeSoftness: DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
        spillSuppression: DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
      },
    });
  });

  it("translation fails NOT_FOUND for an unknown clip before any action is made", () => {
    const project = createEmptyProject("Translation");
    expect(() =>
      opToCoreActions(
        { op: "clip.setChromaKey", clipId: "nope", enabled: true },
        project,
      ),
    ).toThrowError(/not found/);
  });
});

describe("clip.setChromaKey undo (core action history)", () => {
  function seedProjectWithClip() {
    const project = createEmptyProject("UndoChroma");
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

  const mk = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params,
  });

  function clipOf(project: ReturnType<typeof createEmptyProject>) {
    return project.timeline.tracks[0]!.clips[0]!;
  }

  it("the core inverse restores the prior (keyer-off) settings", async () => {
    const project = seedProjectWithClip();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      mk("clip/setChromaKey", {
        clipId: "c1",
        chromaKey: {
          enabled: true,
          keyColor: { r: 0, g: 1, b: 0 },
          tolerance: 0.3,
          edgeSoftness: 0.1,
          spillSuppression: 0.5,
        },
      }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(clipOf(project).chromaKey?.enabled).toBe(true);

    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/setChromaKey");
    await executor.execute(inverse!, project);
    expect(clipOf(project).chromaKey).toBeUndefined();
  });

  it("the core inverse restores prior tuning when a keyer was already on", async () => {
    const project = seedProjectWithClip();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    // First turn the keyer on with blue at tolerance 0.2.
    await executor.execute(
      mk("clip/setChromaKey", {
        clipId: "c1",
        chromaKey: {
          enabled: true,
          keyColor: { r: 0, g: 0, b: 1 },
          tolerance: 0.2,
          edgeSoftness: 0.1,
          spillSuppression: 0.5,
        },
      }),
      project,
    );
    // Then re-key to green at 0.35 (a second op on the same clip).
    await executor.execute(
      mk("clip/setChromaKey", {
        clipId: "c1",
        chromaKey: {
          enabled: true,
          keyColor: { r: 0, g: 1, b: 0 },
          tolerance: 0.35,
          edgeSoftness: 0.1,
          spillSuppression: 0.5,
        },
      }),
      project,
    );
    expect(clipOf(project).chromaKey?.tolerance).toBe(0.35);

    const inverse = history.undo();
    await executor.execute(inverse!, project);
    expect(clipOf(project).chromaKey).toMatchObject({
      enabled: true,
      keyColor: { r: 0, g: 0, b: 1 },
      tolerance: 0.2,
    });
  });
});

describe("clip.setChromaKey capability declaration", () => {
  it("reports the fixed-algorithm keyer honestly (no AI wording)", async () => {
    const mediaRoot = await makeTempDir("chroma-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const chroma = res.value.professionalEditing.chromaKey;
      expect(chroma.available).toBe(true);
      expect(chroma.details).toMatchObject({
        op: "clip.setChromaKey",
        coreAction: "clip/setChromaKey",
        defaultKeyColor: { r: 0, g: 1, b: 0 },
        defaults: {
          tolerance: DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
          edgeSoftness: DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
          spillSuppression: DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
        },
      });
      const algorithm = String(chroma.details?.algorithm);
      // Honest wording: the keyer is disclosed as a fixed local algorithm
      // and never presented AS model inference (fixed presets, the chroma
      // key and shaders must not pass as AI).
      expect(algorithm).toContain("not AI matting");
      expect(JSON.stringify(chroma)).not.toMatch(
        /ai-powered|ai keying|ai chroma key|"ai"\s*:|powered by ai/i,
      );
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
