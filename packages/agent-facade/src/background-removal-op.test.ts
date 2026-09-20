/**
 * clip.setBackgroundRemoval — the person-segmentation matte as an edit.apply
 * op.
 *
 * Covered behavior:
 *  - the op lands the same persisted `clip.backgroundRemoval` settings the
 *    GUI Background Removal panel writes through the core
 *    clip/setBackgroundRemoval action; omitted tuning fields keep the clip's
 *    prior values and fall back to the shared engine defaults (blur mode,
 *    blur 15px, edge 3px, threshold 0.7),
 *  - parameter boundaries (required enabled, closed field set, slider
 *    ranges, hex color) are rejected with INVALID_PARAMS and the revision
 *    does not move,
 *  - unknown clips fail NOT_FOUND,
 *  - the op translates to exactly one core clip/setBackgroundRemoval action
 *    whose inverse (owned by core) restores the prior settings, so GUI undo
 *    and agent-issued edits share one history semantic,
 *  - capabilities.get reports the capability with honest runtime disclosure:
 *    MediaPipe inference is GUI/desktop-Chromium-only, headless renders keep
 *    the original background, and the model-load fallback is a disclosed
 *    non-AI mask.
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
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundRemovalSettings,
} from "@reelterminal/core/ai/background-removal-engine";
import type { Action } from "@reelterminal/core/types/actions";

describe("clip.setBackgroundRemoval (edit.apply op)", () => {
  let mediaRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("background-removal");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot] });
    await facade["project.create"]({ name: "Matte" });
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

  it("enables the matte with the shared engine defaults", async () => {
    await seedClip();
    const result = await facade["edit.apply"]({
      ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true }],
    });
    expect(result.ok).toBe(true);

    const clip = await clipById("c1");
    const expected: BackgroundRemovalSettings = {
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
    };
    expect(clip.backgroundRemoval).toEqual(expected);
  });

  it("merges partial updates onto prior settings and disable keeps them", async () => {
    await seedClip();
    await facade["edit.apply"]({
      ops: [{
        op: "clip.setBackgroundRemoval",
        clipId: "c1",
        enabled: true,
        mode: "color",
        backgroundColor: "#0000ff",
        threshold: 0.6,
      }],
    });

    // Re-tune: prior color/threshold survive, defaults fill the rest.
    await facade["edit.apply"]({
      ops: [{
        op: "clip.setBackgroundRemoval",
        clipId: "c1",
        enabled: true,
        blurAmount: 30,
      }],
    });
    let clip = await clipById("c1");
    expect(clip.backgroundRemoval).toEqual({
      ...DEFAULT_BACKGROUND_SETTINGS,
      enabled: true,
      mode: "color",
      backgroundColor: "#0000ff",
      threshold: 0.6,
      blurAmount: 30,
    });

    // Disabling keeps the tuning values, matching the GUI toggle.
    await facade["edit.apply"]({
      ops: [{ op: "clip.setBackgroundRemoval", clipId: "c1", enabled: false }],
    });
    clip = await clipById("c1");
    expect(clip.backgroundRemoval).toMatchObject({ enabled: false });
    expect(clip.backgroundRemoval?.backgroundColor).toBe("#0000ff");
  });

  it("fails NOT_FOUND for an unknown clip", async () => {
    const r = await facade["edit.apply"]({
      ops: [
        { op: "clip.setBackgroundRemoval", clipId: "clip-missing", enabled: true },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects out-of-range or malformed payloads without moving the revision", async () => {
    await seedClip();
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeJson = projectJson(before.value.project);

    const badOps: readonly unknown[] = [
      { op: "clip.setBackgroundRemoval", clipId: "c1", mode: "blur" }, // enabled missing
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, mode: "neon" },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, blurAmount: 51 },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, blurAmount: -1 },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, edgeBlur: 11 },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, threshold: 1.5 },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, backgroundColor: "blue" },
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: true, preset: "portrait" }, // unknown field
      { op: "clip.setBackgroundRemoval", clipId: "c1", enabled: "yes" },
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

  it("translates to the same core clip/setBackgroundRemoval action the GUI emits", () => {
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
        op: "clip.setBackgroundRemoval",
        clipId: "c1",
        enabled: true,
        threshold: 0.6,
      },
      project,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("clip/setBackgroundRemoval");
    expect(actions[0]!.params).toEqual({
      clipId: "c1",
      backgroundRemoval: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        enabled: true,
        threshold: 0.6,
      },
    });
  });

  it("translation fails NOT_FOUND for an unknown clip before any action is made", () => {
    const project = createEmptyProject("Translation");
    expect(() =>
      opToCoreActions(
        { op: "clip.setBackgroundRemoval", clipId: "nope", enabled: true },
        project,
      ),
    ).toThrowError(/not found/);
  });
});

describe("clip.setBackgroundRemoval undo (core action history)", () => {
  function seedProjectWithClip() {
    const project = createEmptyProject("UndoMatte");
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

  it("the core inverse restores the prior (matte-off) state", async () => {
    const project = seedProjectWithClip();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      mk("clip/setBackgroundRemoval", {
        clipId: "c1",
        backgroundRemoval: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          enabled: true,
        },
      }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(clipOf(project).backgroundRemoval?.enabled).toBe(true);

    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/setBackgroundRemoval");
    await executor.execute(inverse!, project);
    expect(clipOf(project).backgroundRemoval).toBeUndefined();
  });

  it("the core inverse restores prior tuning when a matte was already on", async () => {
    const project = seedProjectWithClip();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    await executor.execute(
      mk("clip/setBackgroundRemoval", {
        clipId: "c1",
        backgroundRemoval: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          enabled: true,
          mode: "color",
          backgroundColor: "#0000ff",
        },
      }),
      project,
    );
    await executor.execute(
      mk("clip/setBackgroundRemoval", {
        clipId: "c1",
        backgroundRemoval: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          enabled: true,
          threshold: 0.55,
        },
      }),
      project,
    );
    expect(clipOf(project).backgroundRemoval?.threshold).toBe(0.55);

    const inverse = history.undo();
    await executor.execute(inverse!, project);
    expect(clipOf(project).backgroundRemoval).toMatchObject({
      enabled: true,
      mode: "color",
      backgroundColor: "#0000ff",
    });
  });
});

describe("clip.setBackgroundRemoval capability declaration", () => {
  it("discloses the MediaPipe runtime, headless limits and degraded fallback honestly", async () => {
    const mediaRoot = await makeTempDir("matte-caps");
    try {
      const facade = createAgentFacade({ mediaRoots: [mediaRoot] });
      const res = await facade["capabilities.get"]();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const matte = res.value.professionalEditing.backgroundRemoval;
      expect(matte.available).toBe(true);
      expect(matte.details).toMatchObject({
        op: "clip.setBackgroundRemoval",
        coreAction: "clip/setBackgroundRemoval",
      });
      const details = JSON.stringify(matte.details);
      // Render runtime honesty: the model runs in the GUI/desktop-Chromium
      // runtime only; headless renders keep the original background.
      expect(details).toContain("GUI/desktop-Chromium");
      expect(details).toContain("headless");
      // Degradation honesty: the non-AI fallback mask is disclosed and the
      // capability never claims AI matting for the fallback.
      expect(details).toContain("non-AI luminance mask");
      expect(details).toContain("degraded");
    } finally {
      await removeTempDir(mediaRoot);
    }
  });
});
