/**
 * svg.create / svg.update / svg.remove — Agent SVG creation as edit.apply ops.
 *
 * Covered behavior:
 *  - svg.create lands the same project.svgClips content the GUI SVG import
 *    produces (engine-matching defaults for preserveAspectRatio, transform,
 *    colorStyle and entry/exit animations), on the first existing graphics
 *    track — or on a graphics track created in the same atomic batch when
 *    the project has none (the text.create pattern),
 *  - the raw markup crosses the shared core ingest gate (svg-validation) via
 *    the svg/create action handler, so unsafe content fails the whole batch
 *    without moving the revision,
 *  - svg.update shallow-merges onto the prior clip (transform sent whole),
 *    svg.remove deletes; unknown overlay ids fail NOT_FOUND,
 *  - retries with the same idempotencyKey replay instead of re-applying,
 *  - the ops translate to the core svg/create|update|remove actions whose
 *    core-owned inverses restore prior state (one undo semantic for GUI and
 *    agent edits),
 *  - headless edit.apply reports the minted clip id through createdIds,
 *  - timeline.query projects svg clips as "svg" entities so agents can
 *    verify placement without pulling megabytes of markup,
 *  - capabilities.get reports the capability with honest wording.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { opToCoreActions } from "./ops";
import { createEmptyProject } from "./project-factory";
import { projectJson } from "./test-helpers";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><circle cx="60" cy="40" r="30" fill="#22c55e"/></svg>';
const UNSAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>';
const EXTERNAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/pic.png" width="10" height="10"/></svg>';

describe("svg.create/update/remove (edit.apply op)", () => {
  let facade: ReturnType<typeof createAgentFacade>;

  beforeEach(async () => {
    facade = createAgentFacade({});
    await facade["project.create"]({ name: "Svg" });
  });

  async function state() {
    const res = await facade["project.get_state"]();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("state failed");
    return res.value;
  }

  it("creates the overlay with engine-matching defaults and an auto graphics track", async () => {
    const result = await facade["edit.apply"]({
      ops: [
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0.5, duration: 4 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { project } = await state();
    const graphicsTracks = project.timeline.tracks.filter(
      (t) => t.type === "graphics",
    );
    expect(graphicsTracks).toHaveLength(1);
    expect(project.svgClips).toHaveLength(1);

    const clip = project.svgClips![0]!;
    expect(clip.trackId).toBe(graphicsTracks[0]!.id);
    expect(clip.type).toBe("svg");
    expect(clip.svgContent).toBe(SAFE_SVG);
    expect(clip.startTime).toBe(0.5);
    expect(clip.duration).toBe(4);
    expect(clip.viewBox).toEqual({ minX: 0, minY: 0, width: 120, height: 80 });
    expect(clip.preserveAspectRatio).toBe("xMidYMid");
    expect(clip.transform.position).toEqual({ x: 0.5, y: 0.5 });
    expect(clip.transform.anchor).toEqual({ x: 0.5, y: 0.5 });
    expect(clip.colorStyle?.colorMode).toBe("none");
    expect(clip.entryAnimation?.type).toBe("none");
    expect(clip.exitAnimation?.type).toBe("none");

    // Headless createdIds report the minted clip id (svgClips diff bucket).
    // With the auto-created graphics lane this follows the text.create
    // convention: [autoTrackId, overlayId] in that order.
    expect(result.value.applied).toHaveLength(1);
    expect(result.value.applied[0]!.op).toBe("svg.create");
    expect(result.value.applied[0]!.createdIds).toEqual([
      graphicsTracks[0]!.id,
      clip.id,
    ]);
  });

  it("targets the first existing graphics track or an explicit one", async () => {
    const seed = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "graphics", trackId: "g1" }],
    });
    expect(seed.ok).toBe(true);

    await facade["edit.apply"]({
      ops: [{ op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 }],
    });
    const { project } = await state();
    expect(project.svgClips![0]!.trackId).toBe("g1");

    const second = await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "graphics", trackId: "g2" }],
    });
    expect(second.ok).toBe(true);
    await facade["edit.apply"]({
      ops: [
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2, trackId: "g2" },
      ],
    });
    const after = await state();
    expect(after.project.svgClips![1]!.trackId).toBe("g2");
  });

  it("fails NOT_FOUND for an unknown track and INVALID_PARAMS for a non-graphics track", async () => {
    const missing = await facade["edit.apply"]({
      ops: [
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2, trackId: "nope" },
      ],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const wrongType = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2, trackId: "v1" },
      ],
    });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects unsafe or external SVG content without moving the revision", async () => {
    const before = await state();
    const beforeJson = projectJson(before.project);

    for (const svgContent of [UNSAFE_SVG, EXTERNAL_SVG, "not svg at all"]) {
      const r = await facade["edit.apply"]({
        ops: [{ op: "svg.create", svgContent, startTime: 0, duration: 2 }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // The facade schema only pins string constraints; the content policy
        // is the core ingest gate, so the failure surfaces as ACTION_FAILED
        // with the gate's INVALID_PARAMS as the core code.
        expect(r.error.code).toBe("ACTION_FAILED");
        expect(r.error.details).toMatchObject({ coreCode: "INVALID_PARAMS" });
      }
    }

    const after = await state();
    expect(after.revision).toBe(before.revision);
    expect(after.project.svgClips ?? []).toHaveLength(0);
    expect(projectJson(after.project)).toBe(beforeJson);
  });

  it("replays the same idempotencyKey instead of re-applying", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 }],
      idempotencyKey: "svg-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await facade["edit.apply"]({
      ops: [{ op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 }],
      idempotencyKey: "svg-1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);
    const { project } = await state();
    expect(project.svgClips).toHaveLength(1);
  });

  it("svg.update merges onto the prior clip and re-crosses the ingest gate for new content", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 }],
    });
    const clipId = (await state()).project.svgClips![0]!.id;

    const update = await facade["edit.apply"]({
      ops: [
        {
          op: "svg.update",
          overlayId: clipId,
          startTime: 1,
          position: { x: 0.25, y: 0.75 },
        },
      ],
    });
    expect(update.ok).toBe(true);
    const updated = (await state()).project.svgClips![0]!;
    expect(updated.startTime).toBe(1);
    expect(updated.duration).toBe(2);
    expect(updated.transform.position).toEqual({ x: 0.25, y: 0.75 });
    // Merge semantics: untouched transform keys survive.
    expect(updated.transform.scale).toEqual({ x: 1, y: 1 });
    expect(updated.transform.anchor).toEqual({ x: 0.5, y: 0.5 });
    expect(updated.svgContent).toBe(SAFE_SVG);

    const unsafe = await facade["edit.apply"]({
      ops: [{ op: "svg.update", overlayId: clipId, svgContent: UNSAFE_SVG }],
    });
    expect(unsafe.ok).toBe(false);
    expect((await state()).project.svgClips![0]!.svgContent).toBe(SAFE_SVG);
  });

  it("svg.update and svg.remove fail NOT_FOUND for unknown ids", async () => {
    const update = await facade["edit.apply"]({
      ops: [{ op: "svg.update", overlayId: "svg-missing", startTime: 1 }],
    });
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe("NOT_FOUND");

    const remove = await facade["edit.apply"]({
      ops: [{ op: "svg.remove", overlayId: "svg-missing" }],
    });
    expect(remove.ok).toBe(false);
    if (!remove.ok) expect(remove.error.code).toBe("NOT_FOUND");
  });

  it("svg.remove deletes the overlay and reports no created ids", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 }],
    });
    const clipId = (await state()).project.svgClips![0]!.id;
    const result = await facade["edit.apply"]({
      ops: [{ op: "svg.remove", overlayId: clipId }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied[0]!.createdIds).toEqual([]);
    expect((await state()).project.svgClips ?? []).toHaveLength(0);
  });

  it("edit.validate dry-runs svg ops and reports the gate rejection as a conflict", async () => {
    const valid = await facade["edit.validate"]({
      ops: [
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 },
      ],
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    if (valid.value.valid) {
      expect(valid.value.conflicts).toHaveLength(0);
      expect(valid.value.normalizedOps[0]!.op).toBe("svg.create");
      // The affected preview sees svg overlays like every other entity —
      // including the implied graphics lane the op creates (sorted by type).
      expect(valid.value.created).toEqual([
        { entityType: "svg", entityId: expect.any(String) },
        { entityType: "track", entityId: expect.any(String) },
      ]);
      expect(
        valid.value.affected.map((entity) => [entity.entityType, entity.entityId]),
      ).toEqual(
        expect.arrayContaining([["svg", expect.any(String)]]),
      );
    }

    const unsafe = await facade["edit.validate"]({
      ops: [{ op: "svg.create", svgContent: UNSAFE_SVG, startTime: 0, duration: 2 }],
    });
    expect(unsafe.ok).toBe(true);
    if (!unsafe.ok) return;
    expect(unsafe.value.valid).toBe(false);
    expect(unsafe.value.conflicts[0]).toMatchObject({ code: "ACTION_FAILED" });
  });

  it("timeline.query projects svg clips as svg entities", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "graphics", trackId: "g1" },
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 1, duration: 3, trackId: "g1" },
      ],
    });
    const clipId = (await state()).project.svgClips![0]!.id;

    const query = await facade["timeline.query"]({
      entityTypes: ["svg"],
      fields: ["type", "trackId", "startTime", "duration", "viewBox", "colorStyle"],
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.items).toHaveLength(1);
    expect(query.value.items[0]!.entityType).toBe("svg");
    expect(query.value.items[0]!.id).toBe(clipId);
    expect(query.value.items[0]!.data.trackId).toBe("g1");
    expect(query.value.items[0]!.data.startTime).toBe(1);
    expect(query.value.items[0]!.data.viewBox).toEqual({
      minX: 0,
      minY: 0,
      width: 120,
      height: 80,
    });
    expect(query.value.items[0]!.data.colorStyle).toMatchObject({
      colorMode: "none",
    });
    // The raw markup is deliberately not part of the projection.
    expect(query.value.items[0]!.data).not.toHaveProperty("svgContent");

    // A graphics-track filter reaches the entity too (trackType is graphics).
    const byTrack = await facade["timeline.query"]({
      trackIds: ["g1"],
      entityTypes: ["svg"],
    });
    expect(byTrack.ok).toBe(true);
    if (!byTrack.ok) return;
    expect(byTrack.value.items).toHaveLength(1);
  });
});

describe("svg op translation (opToCoreActions)", () => {
  const graphicsTrack = {
    id: "g1",
    type: "graphics" as const,
    name: "Graphics",
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  };

  function projectWithGraphicsTrack(): Project {
    const project = createEmptyProject("SvgTranslation");
    (project.timeline.tracks as unknown[]).push(graphicsTrack);
    return project;
  }

  it("emits exactly one svg/create action when a graphics track exists", () => {
    const project = projectWithGraphicsTrack();
    const actions = opToCoreActions(
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 2, duration: 5, trackId: "g1" },
      project,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("svg/create");
    const clip = (actions[0]!.params as { clip: { trackId: string; startTime: number } })
      .clip;
    expect(clip.trackId).toBe("g1");
    expect(clip.startTime).toBe(2);
  });

  it("auto-creates a graphics track in the same action stream when none exists", () => {
    const project = createEmptyProject("SvgAutoTrack");
    const actions = opToCoreActions(
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 },
      project,
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]!.type).toBe("track/add");
    expect(actions[0]!.params).toMatchObject({ trackType: "graphics" });
    const autoTrackId = actions[0]!.params.trackId;
    expect(actions[1]!.type).toBe("svg/create");
    expect((actions[1]!.params as { clip: { trackId: string } }).clip.trackId).toBe(
      autoTrackId,
    );
  });

  it("extracts the viewBox the way core parseSVG would", () => {
    const project = projectWithGraphicsTrack();
    const run = (svgContent: string) =>
      opToCoreActions(
        { op: "svg.create", svgContent, startTime: 0, duration: 1, trackId: "g1" },
        project,
      )[0]!.params;

    expect(
      (
        run('<svg viewBox="0 0 320 240"><rect/></svg>') as {
          clip: { viewBox: unknown };
        }
      ).clip.viewBox,
    ).toEqual({ minX: 0, minY: 0, width: 320, height: 240 });
    // No viewBox: width/height attributes are the fallback.
    expect(
      (
        run('<svg width="640" height="480"><rect/></svg>') as {
          clip: { viewBox: unknown };
        }
      ).clip.viewBox,
    ).toEqual({ minX: 0, minY: 0, width: 640, height: 480 });
    // Neither: 100x100 default.
    expect(
      (run("<svg><rect/></svg>") as { clip: { viewBox: unknown } }).clip.viewBox,
    ).toEqual({ minX: 0, minY: 0, width: 100, height: 100 });
  });

  it("translation fails before any action for unknown or non-graphics tracks", () => {
    const project = projectWithGraphicsTrack();
    expect(() =>
      opToCoreActions(
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 1, trackId: "nope" },
        project,
      ),
    ).toThrowError(/not found/);
    expect(() =>
      opToCoreActions(
        { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 1, trackId: "v-missing" },
        project,
      ),
    ).toThrowError();
  });
});

describe("svg op undo (core action history)", () => {
  function seedProject() {
    const project = createEmptyProject("SvgUndo");
    (project.timeline.tracks as unknown[]).push({
      id: "g1",
      type: "graphics",
      name: "Graphics",
      clips: [],
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

  function makeClip() {
    return {
      id: "svg-1",
      trackId: "g1",
      startTime: 0,
      duration: 2,
      type: "svg" as const,
      svgContent: SAFE_SVG,
      viewBox: { minX: 0, minY: 0, width: 120, height: 80 },
      preserveAspectRatio: "xMidYMid" as const,
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: [],
    };
  }

  it("svg/create inverts to svg/remove and back", async () => {
    const project = seedProject();
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    // Applies undo/redo actions WITHOUT feeding them back into the history
    // under test (a push would clear its redo stack — that is core semantics,
    // not what this test exercises).
    const sideExecutor = new ActionExecutor(new ActionHistory());

    const applied = await executor.execute(
      mk("svg/create", { clip: makeClip() }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(project.svgClips).toHaveLength(1);

    const inverse = history.undo();
    expect(inverse?.type).toBe("svg/remove");
    await sideExecutor.execute(inverse!, project);
    expect(project.svgClips ?? []).toHaveLength(0);

    const redo = history.redo();
    expect(redo?.type).toBe("svg/create");
    await sideExecutor.execute(redo!, project);
    expect(project.svgClips).toHaveLength(1);
  });

  it("svg/update inverts to the prior full clip snapshot", async () => {
    const project = seedProject();
    (project as { svgClips?: unknown[] }).svgClips = [makeClip()];
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      mk("svg/update", {
        clipId: "svg-1",
        updates: { startTime: 5, duration: 9 },
      }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(project.svgClips![0]).toMatchObject({ startTime: 5, duration: 9 });

    const inverse = history.undo();
    expect(inverse?.type).toBe("svg/update");
    await executor.execute(inverse!, project);
    expect(project.svgClips![0]).toMatchObject({ startTime: 0, duration: 2 });
  });

  it("svg/remove inverts by recreating the removed clip", async () => {
    const project = seedProject();
    (project as { svgClips?: unknown[] }).svgClips = [makeClip()];
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);

    const applied = await executor.execute(
      mk("svg/remove", { clipId: "svg-1" }),
      project,
    );
    expect(applied.success).toBe(true);
    expect(project.svgClips ?? []).toHaveLength(0);

    const inverse = history.undo();
    expect(inverse?.type).toBe("svg/create");
    await executor.execute(inverse!, project);
    expect(project.svgClips![0]).toMatchObject({ id: "svg-1" });
  });
});

describe("svg overlays capability declaration", () => {
  it("reports the op set and shared ingest gate honestly (no AI wording)", async () => {
    const facade = createAgentFacade({});
    const res = await facade["capabilities.get"]();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const svg = res.value.professionalEditing.svgOverlays;
    expect(svg.available).toBe(true);
    expect(svg.details).toMatchObject({
      ops: ["svg.create", "svg.update", "svg.remove"],
      coreActions: ["svg/create", "svg/update", "svg/remove"],
      maxContentBytes: 2 * 1024 * 1024,
    });
    expect(JSON.stringify(svg)).not.toMatch(
      /ai-powered|ai keying|ai-generated|"ai"\s*:|powered by ai/i,
    );
  });
});
