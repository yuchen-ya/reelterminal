import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";
import type { Action } from "@reelterminal/core/types/actions";
import type { Project } from "@reelterminal/core/types/project";
import {
  createAgentFacade,
  createLiveFacade,
  LiveWriterLease,
  type AgentFacade,
  type LiveAgentFacade,
} from "./index";
import { describeCommand } from "./capability-registry";
import { LiveStoreConflictError } from "./live-store";
import type {
  LiveApplyActionsOptions,
  LiveEditorContext,
  LiveMediaImportRequest,
  LiveProjectStore,
} from "./live-store";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { collectEntityIds, diffCreatedIdsByCategory } from "./ops";
import { createEmptyProject } from "./project-factory";
import { makeTempDir, removeTempDir } from "./test-helpers";
import type { MediaImportResult, TimelineRetimeByAnchorsOp } from "./types";

class TestLiveStore implements LiveProjectStore {
  project: Project;
  revision = 0;
  contextRevision = 0;
  readonly batches: Array<{
    readonly actions: readonly Action[];
    readonly opts: LiveApplyActionsOptions;
  }> = [];

  constructor(project: Project) {
    this.project = project;
  }

  async getIdentity() {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      workspaceId: "ws-v15-test",
      workspaceInstanceId: "runtime-v15-test",
      windowId: "win-v15-test",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }

  async listRequirements() {
    return { revision: this.revision, requirements: [], summary: { total: 0, byStatus: { draft: 0, ready: 0, inProgress: 0, done: 0, blocked: 0 } } } as never;
  }

  async getRequirement(): Promise<never> {
    throw new Error("not implemented");
  }

  async getContext(): Promise<LiveEditorContext> {
    return {
      contextRevision: this.contextRevision,
      playheadSeconds: null,
      selectedClipIds: [],
      selectedTextIds: [],
      selectedMediaIds: [],
      timeRange: null,
      canvasPoint: null,
      references: {},
    };
  }

  async getProjectChanges() {
    return {
      fromRevision: 0,
      toRevision: this.revision,
      changes: [],
      nextCursor: null,
      requiresFullRefresh: false,
    };
  }

  async getHistory() {
    return {
      revision: this.revision,
      available: true,
      canUndo: false,
      canRedo: false,
      undoCount: 0,
      redoCount: 0,
      entries: [],
    };
  }

  async historyControl(): Promise<never> {
    throw new Error("not implemented");
  }

  async applyActions(actions: readonly Action[], opts: LiveApplyActionsOptions) {
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError(
        `stale revision: expected ${opts.expectedRevision}, got ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    const draft = structuredClone(this.project);
    const createdIds = {
      tracks: [] as string[],
      clips: [] as string[],
      textClips: [] as string[],
      transitions: [] as string[],
      subtitles: [] as string[],
    };
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const before = collectEntityIds(draft);
      const res = await executor.execute(action, draft);
      if (!res.success) {
        throw new Error(`store apply failed: ${res.error?.message ?? "unknown"}`);
      }
      const diff = diffCreatedIdsByCategory(before, collectEntityIds(draft));
      createdIds.tracks.push(...diff.tracks);
      createdIds.clips.push(...diff.clips);
      createdIds.textClips.push(...diff.textClips);
      createdIds.transitions.push(...diff.transitions);
      createdIds.subtitles.push(...diff.subtitles);
    }
    this.project = draft;
    this.revision += 1;
    this.batches.push({ actions, opts });
    return { revision: this.revision, createdIds };
  }

  async importMedia(_req: LiveMediaImportRequest): Promise<never> {
    throw new Error("not implemented");
  }

  async getMediaImportReplay(): Promise<MediaImportResult | null> {
    return null;
  }

  async requestSave() {
    return { revision: this.revision };
  }

  async editorControl(): Promise<never> {
    throw new Error("not implemented");
  }

  async probeProjectAccess() {
    return { ok: true as const };
  }
}

function makeSeededProject(mediaDuration = 60): Project {
  const project = createEmptyProject("v1.5 Phase 1 Test");
  return {
    ...project,
    settings: { ...project.settings, frameRate: 30 },
    mediaLibrary: {
      items: [
        {
          id: "m-long",
          name: "source-60s.mp4",
          type: "video",
          fileHandle: null,
          blob: null,
          thumbnailUrl: null,
          waveformData: null,
          originalUrl: "file:///source-60s.mp4",
          metadata: {
            duration: mediaDuration,
            width: 1920,
            height: 1080,
            frameRate: 30,
            codec: "h264",
            sampleRate: 48000,
            channels: 2,
            fileSize: 1024 * 1024,
          },
        },
      ],
    },
    timeline: {
      ...project.timeline,
      tracks: [
        {
          id: "v1",
          type: "video",
          name: "Video 1",
          clips: [],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  };
}

describe("v1.5 Phase 1 editing upgrades", () => {
  let tmpDir: string;
  let facade: AgentFacade;
  let headlessMediaId: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir("v15-phase1");
    const mp4Path = writeTinyMp4(tmpDir);
    facade = createAgentFacade({ mediaRoots: [tmpDir] });
    const created = await facade["project.create"]({ name: "Headless Phase 1" });
    if (!created.ok) throw new Error(created.error.message);
    const imported = await facade["media.import"]({
      path: mp4Path,
    });
    if (!imported.ok) throw new Error(imported.error.message);
    headlessMediaId = imported.value.mediaId;
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it("defers overlap checks within a batch and enforces zero final overlaps in headless and live modes", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });

    // Intermediate overlap resolved later in the same batch succeeds in validate & apply.
    const validSwapBatch = {
      ops: [
        {
          op: "clip.add" as const,
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 0,
          inPoint: 0,
          outPoint: 4,
          clipId: "c1",
        },
        {
          op: "clip.add" as const,
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 2,
          inPoint: 0,
          outPoint: 3,
          clipId: "c2",
        },
        { op: "clip.move" as const, clipId: "c2", startTime: 4 },
      ],
    };

    const beforeValidation = await facade["project.get_state"]();
    const validatedOk = await facade["edit.validate"](validSwapBatch);
    expect(validatedOk.ok).toBe(true);
    if (!validatedOk.ok) return;
    expect(validatedOk.value.valid).toBe(true);
    expect(validatedOk.value.conflicts).toHaveLength(0);
    expect(await facade["project.get_state"]()).toEqual(beforeValidation);

    const appliedOk = await facade["edit.apply"](validSwapBatch);
    expect(appliedOk.ok).toBe(true);
    const afterSwap = await facade["project.get_state"]();
    expect(afterSwap.ok).toBe(true);
    if (!afterSwap.ok || !beforeValidation.ok) return;
    expect(afterSwap.value.revision).toBe(beforeValidation.value.revision + 1);
    expect(afterSwap.value.project.timeline.tracks[0]!.clips).toMatchObject([
      { id: "c1", startTime: 0, duration: 4 },
      { id: "c2", startTime: 4, duration: 3 },
    ]);

    // Final overlap left unresolved at batch end fails in both edit.validate and edit.apply.
    const overlappingBatch = {
      ops: [
        { op: "track.add" as const, trackType: "audio" as const, trackId: "must-not-persist" },
        { op: "clip.move" as const, clipId: "c2", startTime: 3 },
      ],
    };
    const validatedBad = await facade["edit.validate"](overlappingBatch);
    expect(validatedBad.ok).toBe(true);
    if (!validatedBad.ok) return;
    expect(validatedBad.value.valid).toBe(false);
    expect(validatedBad.value.conflicts[0]).toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({ reason: "CLIP_OVERLAP", trackId: "v1" }),
    });
    expect(await facade["project.get_state"]()).toEqual(afterSwap);

    const appliedBad = await facade["edit.apply"](overlappingBatch);
    expect(appliedBad.ok).toBe(false);
    if (appliedBad.ok) return;
    expect(appliedBad.error.code).toBe("CONFLICT");
    expect(appliedBad.error.details).toMatchObject({ reason: "CLIP_OVERLAP", trackId: "v1" });
    expect(await facade["project.get_state"]()).toEqual(afterSwap);

    // Live mode: intermediate overlap resolves, final overlap rejects before calling store.applyActions.
    const store = new TestLiveStore(makeSeededProject());
    const live: LiveAgentFacade = createLiveFacade({
      store,
      lease: new LiveWriterLease(),
      sessionId: "v15-live",
      access: "write",
      artifactRoot: tmpDir,
      mediaRoots: [tmpDir],
    });

    const liveBefore = structuredClone(store.project);
    const liveSwap = await live["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 0, inPoint: 0, outPoint: 5 },
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 2, inPoint: 5, outPoint: 9 },
      ],
    });
    expect(liveSwap.ok).toBe(false);
    if (liveSwap.ok) return;
    expect(liveSwap.error.code).toBe("CONFLICT");
    expect(liveSwap.error.details).toMatchObject({ reason: "CLIP_OVERLAP" });
    expect(store.batches).toHaveLength(0);
    expect(store.project).toEqual(liveBefore);
    expect(store.revision).toBe(0);

    const liveValid = await live["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 0, inPoint: 0, outPoint: 5 },
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 5, inPoint: 5, outPoint: 10 },
      ],
    });
    expect(liveValid.ok).toBe(true);
    if (!liveValid.ok) return;
    const beforeConflict = structuredClone(store.project);
    const revisionBeforeConflict = store.revision;
    const clipBId = liveValid.value.applied[1]!.createdIds[0]!;
    // A rejected final overlap rolls back all earlier operations in the batch.
    const liveConflict = await live["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "must-not-persist" },
        { op: "clip.move", clipId: clipBId, startTime: 4 },
      ],
    });
    expect(liveConflict.ok).toBe(false);
    if (liveConflict.ok) return;
    expect(liveConflict.error.code).toBe("CONFLICT");
    expect(liveConflict.error.details).toMatchObject({ reason: "CLIP_OVERLAP" });
    expect(store.batches).toHaveLength(1);
    expect(store.project).toEqual(beforeConflict);
    expect(store.revision).toBe(revisionBeforeConflict);

    // Resolving clipB's move by shrinking clipA via clip.setSpeed in same batch succeeds!
    const clipAId = liveValid.value.applied[0]!.createdIds[0]!;
    const resolvingBatch = {
      ops: [
        { op: "clip.move" as const, clipId: clipBId, startTime: 2.5 },
        { op: "clip.setSpeed" as const, clipId: clipAId, speed: 2 },
      ],
    };
    const liveValidation = await live["edit.validate"](resolvingBatch);
    expect(liveValidation).toMatchObject({ ok: true, value: { valid: true, conflicts: [] } });
    expect(store.project).toEqual(beforeConflict);
    expect(store.revision).toBe(revisionBeforeConflict);
    expect(store.batches).toHaveLength(1);
    const liveResolve = await live["edit.apply"](resolvingBatch);
    expect(liveResolve.ok).toBe(true);
    expect(store.revision).toBe(revisionBeforeConflict + 1);
    expect(store.batches).toHaveLength(2);
    expect(store.project.timeline.tracks[0]!.clips[0]!.duration).toBeCloseTo(2.5, 6);
    expect(store.project.timeline.tracks[0]!.clips[1]!.startTime).toBeCloseTo(2.5, 6);

    // Expanding clipA first via clip.setSpeed (0.5x => 10s, temporarily overlapping clipB at 2.5s)
    // and then moving clipB to 10s in the same batch succeeds without stagger!
    const liveExpandFirst = await live["edit.apply"]({
      ops: [
        { op: "clip.setSpeed", clipId: clipAId, speed: 0.5 },
        { op: "clip.move", clipId: clipBId, startTime: 10 },
      ],
    });
    expect(liveExpandFirst.ok).toBe(true);
    expect(store.project.timeline.tracks[0]!.clips[0]!.duration).toBeCloseTo(10, 6);
    expect(store.project.timeline.tracks[0]!.clips[1]!.startTime).toBeCloseTo(10, 6);
  });

  it("supports clip.add speed and raises batch limit to 500 ops", async () => {
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });

    const added = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 0,
          inPoint: 0,
          outPoint: 6,
          speed: 2,
          clipId: "fast-clip",
        },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 3,
          inPoint: 1,
          outPoint: 3,
          speed: 0.5,
          clipId: "slow-clip",
        },
      ],
    });
    expect(added.ok).toBe(true);
    const q = await facade["project.get_state"]();
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const clips = q.value.project.timeline.tracks.find((t) => t.id === "v1")!.clips;
    expect(clips[0]).toMatchObject({ id: "fast-clip", duration: 3, speed: 2, startTime: 0 });
    expect(clips[1]).toMatchObject({ id: "slow-clip", duration: 4, speed: 0.5, startTime: 3 });

    const outOfRangeSpeed = await facade["edit.apply"]({
      ops: [
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 10,
          speed: 25,
        },
      ],
    });
    expect(outOfRangeSpeed.ok).toBe(false);
    if (outOfRangeSpeed.ok) return;
    expect(outOfRangeSpeed.error.code).toBe("INVALID_PARAMS");

    // The inclusive 500-op boundary succeeds; the adjacent 501-op boundary fails.
    const largeOps = Array.from({ length: 500 }, (_, i) => ({
      op: "clip.add" as const,
      trackId: "v1",
      mediaId: headlessMediaId,
      startTime: 20 + i * 0.5,
      inPoint: 0,
      outPoint: 1,
      speed: 2,
    }));
    const largeBatch = await facade["edit.apply"]({ ops: largeOps });
    expect(largeBatch.ok).toBe(true);
    if (!largeBatch.ok) return;
    expect(largeBatch.value.applied).toHaveLength(500);
    const beforeOverLimit = await facade["project.get_state"]();
    expect(beforeOverLimit).toMatchObject({ ok: true });
    if (!beforeOverLimit.ok) return;
    expect(beforeOverLimit.value.project.timeline.tracks[0]!.clips).toHaveLength(502);

    // > 500 ops is rejected at boundary
    const tooLargeOps = Array.from({ length: 501 }, (_, i) => ({
      op: "clip.add" as const,
      trackId: "v1",
      mediaId: headlessMediaId,
      startTime: i,
      duration: 0.5,
    }));
    const overLimit = await facade["edit.apply"]({ ops: tooLargeOps });
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) return;
    expect(overLimit.error.code).toBe("INVALID_PARAMS");
    expect(await facade["project.get_state"]()).toEqual(beforeOverLimit);
  });

  it("supports timeline.retimeByAnchors with 39-anchor sync in splitSegments and speedCurve across headless & live", async () => {
    // Build 39 anchors (38 contiguous segments) over 60s source with varying speeds
    const anchors39 = Array.from({ length: 39 }, (_, i) => {
      const sourceSec = i * 1.5; // 0 .. 57s
      // Alternate faster (1.5s source in 1.0s timeline => 1.5x) and slower (1.5s source in 2.0s timeline => 0.75x)
      const pairs = Math.floor(i / 2);
      const rem = i % 2;
      const timelineSec = pairs * 3.0 + rem * 1.0;
      return { sourceSec, timelineSec };
    });

    // Live 39-anchor splitSegments + trailing clip.add in same batch to verify createdIds partitioning
    const store = new TestLiveStore(makeSeededProject(60));
    const live = createLiveFacade({
      store,
      lease: new LiveWriterLease(),
      sessionId: "retime-live",
      access: "write",
      artifactRoot: tmpDir,
      mediaRoots: [tmpDir],
    });

    const liveSplit = await live["edit.apply"]({
      ops: [
        {
          op: "timeline.retimeByAnchors",
          mediaId: "m-long",
          trackId: "v1",
          anchors: anchors39,
          mode: "splitSegments",
        },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: "m-long",
          startTime: 60,
          inPoint: 57,
          outPoint: 60,
        },
      ],
    });
    expect(liveSplit.ok).toBe(true);
    if (!liveSplit.ok) return;
    expect(liveSplit.value.applied[0]!.op).toBe("timeline.retimeByAnchors");
    expect(liveSplit.value.applied[0]!.createdIds).toHaveLength(38);
    expect(liveSplit.value.applied[1]!.createdIds).toHaveLength(1);
    const trackClips = store.project.timeline.tracks[0]!.clips;
    expect(trackClips).toHaveLength(39);
    expect(trackClips[0]).toMatchObject({ startTime: 0, duration: 1, inPoint: 0, outPoint: 1.5, speed: 1.5 });
    expect(trackClips[1]).toMatchObject({ startTime: 1, duration: 2, inPoint: 1.5, outPoint: 3, speed: 0.75 });
    expect(liveSplit.value.applied[0]!.createdIds).toEqual(trackClips.slice(0, 38).map((clip) => clip.id));
    for (let i = 0; i < 38; i++) {
      const clip = trackClips[i]!;
      const from = anchors39[i]!;
      const to = anchors39[i + 1]!;
      expect(clip.startTime).toBe(from.timelineSec);
      expect(clip.startTime + clip.duration).toBe(to.timelineSec);
      expect(clip.inPoint).toBe(from.sourceSec);
      expect(clip.outPoint).toBe(to.sourceSec);
      const mapped = await live["timeline.mapSourceTimes"]({
        clipId: clip.id,
        timelineTimes: [(from.timelineSec + to.timelineSec) / 2],
      });
      expect(mapped.ok).toBe(true);
      if (!mapped.ok) return;
      expect(mapped.value.mappings[0]!.sourceTime).toBeCloseTo((from.sourceSec + to.sourceSec) / 2, 4);
    }
    expect(trackClips[38]!.id).toBe(liveSplit.value.applied[1]!.createdIds[0]);

    // Live speedCurve mode on a new track via mediaId, then re-retimed in place via clipId
    await live["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v2" }],
    });
    const anchors4 = [
      { sourceSec: 0, timelineSec: 0 },
      { sourceSec: 4, timelineSec: 2 },
      { sourceSec: 6, timelineSec: 6 },
      { sourceSec: 12, timelineSec: 9 },
    ];
    const curveCreated = await live["edit.apply"]({
      ops: [
        {
          op: "timeline.retimeByAnchors",
          mediaId: "m-long",
          trackId: "v2",
          anchors: anchors4,
          mode: "speedCurve",
        },
      ],
    });
    expect(curveCreated.ok).toBe(true);
    if (!curveCreated.ok) return;
    expect(curveCreated.value.applied[0]!.createdIds).toHaveLength(1);
    const curveClipId = curveCreated.value.applied[0]!.createdIds[0]!;
    const v2Clip = store.project.timeline.tracks.find((t) => t.id === "v2")!.clips[0]!;
    expect(v2Clip.id).toBe(curveClipId);
    expect(v2Clip.inPoint).toBe(0);
    expect(v2Clip.outPoint).toBe(12);
    expect(v2Clip.duration).toBeCloseTo(9, 4);
    expect(v2Clip.speedKeyframes?.length).toBe(4);
    expect(v2Clip.speedKeyframes?.[0]?.time).toBeCloseTo(0, 5);
    expect(v2Clip.speedKeyframes?.[1]?.time).toBeCloseTo(4, 5);
    expect(v2Clip.speedKeyframes?.[2]?.time).toBeCloseTo(6, 5);
    expect(v2Clip.speedKeyframes?.[3]?.time).toBeCloseTo(12, 5);
    const mappedAnchors = await live["timeline.mapSourceTimes"]({
      clipId: curveClipId,
      timelineTimes: anchors4.map((anchor) => anchor.timelineSec),
    });
    expect(mappedAnchors.ok).toBe(true);
    if (!mappedAnchors.ok) return;
    mappedAnchors.value.mappings.forEach((mapping, i) => {
      expect(mapping.sourceTime).toBeCloseTo(anchors4[i]!.sourceSec, 3);
    });

    // Re-retime existing speed-ramped clip in place via clipId
    const curveUpdated = await live["edit.apply"]({
      ops: [
        {
          op: "timeline.retimeByAnchors",
          clipId: curveClipId,
          anchors: [
            { sourceSec: 2, timelineSec: 1 },
            { sourceSec: 8, timelineSec: 4 },
            { sourceSec: 10, timelineSec: 8 },
          ],
          mode: "speedCurve",
        },
      ],
    });
    expect(curveUpdated.ok).toBe(true);
    if (!curveUpdated.ok) return;
    expect(curveUpdated.value.applied[0]!.createdIds).toEqual([]);
    const v2ClipAfter = store.project.timeline.tracks.find((t) => t.id === "v2")!.clips[0]!;
    expect(v2ClipAfter.startTime).toBe(1);
    expect(v2ClipAfter.inPoint).toBe(2);
    expect(v2ClipAfter.outPoint).toBe(10);
    expect(v2ClipAfter.duration).toBeCloseTo(7, 4);

    // Headless clipId replacement in splitSegments mode preserves clip attributes & replaces original clip
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: headlessMediaId,
          startTime: 0,
          inPoint: 0,
          outPoint: 6,
          clipId: "orig-c1",
        },
        { op: "clip.setVolume", clipId: "orig-c1", volume: 0.35 },
        { op: "clip.setTransform", clipId: "orig-c1", transform: { opacity: 0.6, rotation: 15 } },
      ],
    });
    const headlessReplaced = await facade["edit.apply"]({
      ops: [
        {
          op: "timeline.retimeByAnchors",
          clipId: "orig-c1",
          anchors: [
            { sourceSec: 0, timelineSec: 0 },
            { sourceSec: 3, timelineSec: 1.5 },
            { sourceSec: 6, timelineSec: 7.5 },
          ],
        },
      ],
    });
    expect(headlessReplaced.ok).toBe(true);
    if (!headlessReplaced.ok) return;
    expect(headlessReplaced.value.applied[0]!.createdIds).toHaveLength(2);
    const hQuery = await facade["project.get_state"]();
    expect(hQuery.ok).toBe(true);
    if (!hQuery.ok) return;
    const hClips = hQuery.value.project.timeline.tracks.find((t) => t.id === "v1")!.clips;
    expect(hClips.some((c) => c.id === "orig-c1")).toBe(false);
    expect(hClips).toHaveLength(2);
    expect(hClips[0]).toMatchObject({ startTime: 0, duration: 1.5, speed: 2 });
    expect(hClips[1]).toMatchObject({ startTime: 1.5, duration: 6, speed: 0.5 });
    for (const clip of hClips) {
      expect(clip).toMatchObject({ volume: 0.35, transform: { opacity: 0.6, rotation: 15 } });
    }

    // Capability registry & describeCommand include timeline.retimeByAnchors
    const described = describeCommand("edit.apply", { ops: ["timeline.retimeByAnchors"] });
    expect(JSON.stringify(described.inputSchema)).toContain("timeline.retimeByAnchors");
  });

  it.each([
    { mode: "splitSegments", easing: undefined },
    { mode: "speedCurve", easing: undefined },
    { mode: "speedCurve", easing: "linear" },
    { mode: "speedCurve", easing: "smooth" },
  ] as const)("aligns nonzero anchors at inclusive speed boundaries in $mode / $easing", async ({ mode, easing }) => {
    const anchors = [
      { sourceSec: 2, timelineSec: 10 },
      { sourceSec: 3, timelineSec: 20 }, // 0.1x
      { sourceSec: 6, timelineSec: 20.15 }, // 20x, ending at the media boundary
    ];
    const params = {
      ops: [
        { op: "track.add" as const, trackType: "video" as const, trackId: "v1" },
        { op: "timeline.retimeByAnchors" as const, mediaId: headlessMediaId, trackId: "v1", anchors, mode, easing },
      ],
      idempotencyKey: `retime-boundaries-${mode}`,
    };
    const before = await facade["project.get_state"]();
    const result = await facade["edit.apply"](params);
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok || !before.ok) return;
    expect(result.value.revision).toBe(before.value.revision + 1);
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const clips = state.value.project.timeline.tracks[0]!.clips;
    expect(result.value.applied[1]!.createdIds).toEqual(clips.map((clip) => clip.id));
    expect(clips).toHaveLength(mode === "splitSegments" ? 2 : 1);
    expect(clips[0]!.startTime).toBe(10);
    expect(clips.at(-1)!.startTime + clips.at(-1)!.duration).toBeCloseTo(20.15, 4);
    for (const [timelineTime, sourceTime] of [[10, 2], [15, 2.5], [20, 3], [20.075, 4.5]] as const) {
      const clip = clips.find((candidate) => timelineTime >= candidate.startTime && timelineTime <= candidate.startTime + candidate.duration)!;
      const mapped = await facade["timeline.mapSourceTimes"]({ clipId: clip.id, timelineTimes: [timelineTime] });
      expect(mapped.ok).toBe(true);
      if (!mapped.ok) return;
      expect(mapped.value.mappings[0]!.sourceTime).toBeCloseTo(sourceTime, 3);
    }
    const replay = await facade["edit.apply"](params);
    expect(replay).toMatchObject({ ok: true, value: { replayed: true, revision: result.value.revision, applied: result.value.applied } });
    expect(await facade["project.get_state"]()).toEqual(state);
  });

  it.each(["linear", "smooth"] as const)("keeps the requested retime end time with %s easing", async (easing) => {
    const result = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "timeline.retimeByAnchors", mediaId: headlessMediaId, trackId: "v1", mode: "speedCurve", easing,
          anchors: [{ sourceSec: 0, timelineSec: 2 }, { sourceSec: 2, timelineSec: 3 }, { sourceSec: 6, timelineSec: 11 }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const clip = state.value.project.timeline.tracks[0]!.clips[0]!;
    expect(clip.startTime + clip.duration).toBeCloseTo(11, 3);
    const mapped = await facade["timeline.mapSourceTimes"]({ clipId: clip.id, timelineTimes: [2, 2.5, 3, 11] });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error(mapped.error.message);
    for (const [index, source] of [[0, 0], [2, 2], [3, 6]] as const) {
      expect(mapped.value.mappings[index]!.sourceTime).toBeCloseTo(source, 3);
    }
    // Easing must remain a curve instead of quietly falling back to step.
    expect(Math.abs(mapped.value.mappings[1]!.sourceTime - 1)).toBeGreaterThan(0.01);

    const anchors = [
      { sourceSec: 1, timelineSec: 4 }, { sourceSec: 2, timelineSec: 6 },
      { sourceSec: 4, timelineSec: 7 }, { sourceSec: 6, timelineSec: 10 },
    ];
    const updated = await facade["edit.apply"]({ ops: [{ op: "timeline.retimeByAnchors", clipId: clip.id, mode: "speedCurve", easing, anchors }] });
    expect(updated).toMatchObject({ ok: true, value: { applied: [{ createdIds: [] }] } });
    const after = await facade["project.get_state"]();
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.project.timeline.tracks[0]!.clips).toHaveLength(1);
    const updatedClip = after.value.project.timeline.tracks[0]!.clips[0]!;
    expect(updatedClip.startTime + updatedClip.duration).toBeCloseTo(10, 3);
    const remapped = await facade["timeline.mapSourceTimes"]({ clipId: clip.id, timelineTimes: anchors.map(anchor => anchor.timelineSec) });
    if (!remapped.ok) throw new Error(remapped.error.message);
    remapped.value.mappings.forEach((mapping, index) => expect(mapping.sourceTime).toBeCloseTo(anchors[index]!.sourceSec, 3));
  });

  it.each(["linear", "smooth"] as const)("accepts lower-limit roundoff inside a %s retime curve", async (easing) => {
    const anchors = [
      { sourceSec: 0, timelineSec: 0 },
      { sourceSec: 0.1 * 3, timelineSec: 3 }, // JS quotient is 0.10000000000000002
      { sourceSec: 6, timelineSec: 6 },
    ];
    const result = await facade["edit.apply"]({ ops: [
      { op: "track.add", trackType: "video", trackId: "v1" },
      { op: "timeline.retimeByAnchors", mediaId: headlessMediaId, trackId: "v1", mode: "speedCurve", easing, anchors },
    ] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error.message);
    const clipId = result.value.applied[1]!.createdIds[0]!;
    const mapped = await facade["timeline.mapSourceTimes"]({ clipId, timelineTimes: [0, 1.5, 3, 6] });
    if (!mapped.ok) throw new Error(mapped.error.message);
    mapped.value.mappings.forEach((mapping, index) => {
      expect(mapping.sourceTime).toBeCloseTo([0, 0.15, 0.3, 6][index]!, 4);
    });
  });

  it("rejects invalid retime anchors and targets without publishing earlier batch edits", async () => {
    const base: TimelineRetimeByAnchorsOp = {
      op: "timeline.retimeByAnchors", mediaId: headlessMediaId, trackId: "v1",
      anchors: [{ sourceSec: 0, timelineSec: 10 }, { sourceSec: 2, timelineSec: 12 }],
    };
    const invalid: Array<{ label: string; op: TimelineRetimeByAnchorsOp; details?: object }> = [
      { label: "both source selectors", op: { ...base, clipId: "missing" } },
      { label: "missing source selector", op: { ...base, mediaId: undefined } },
      { label: "too few anchors", op: { ...base, anchors: base.anchors.slice(0, 1) } },
      { label: "equal source anchors", op: { ...base, anchors: [{ sourceSec: 1, timelineSec: 10 }, { sourceSec: 1, timelineSec: 12 }] } },
      { label: "equal timeline anchors", op: { ...base, anchors: [{ sourceSec: 0, timelineSec: 10 }, { sourceSec: 2, timelineSec: 10 }] } },
      { label: "past source end", op: { ...base, anchors: [{ sourceSec: 0, timelineSec: 10 }, { sourceSec: 8, timelineSec: 18 }] }, details: { sourceSec: 8 } },
      { label: "too fast", op: { ...base, anchors: [{ sourceSec: 0, timelineSec: 10 }, { sourceSec: 5, timelineSec: 10.1 }] }, details: { segmentIndex: 0, speed: expect.closeTo(50, 5) } },
      { label: "too slow", op: { ...base, anchors: [{ sourceSec: 0, timelineSec: 10 }, { sourceSec: 1, timelineSec: 21 }] }, details: { segmentIndex: 0, speed: expect.closeTo(1 / 11, 5) } },
    ];
    const before = await facade["project.get_state"]();
    for (const { label, op, details } of invalid) {
      const result = await facade["edit.apply"]({ ops: [{ op: "track.add", trackType: "video", trackId: "v1" }, op] });
      expect(result, label).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", ...(details ? { details } : {}) } });
      expect(await facade["project.get_state"](), label).toEqual(before);
    }
  });

  it("enforces transition.add handlePolicy strict diagnostics and autoBorrow trim + ripple", async () => {
    // Headless test with 6s tiny-6s.mp4 (30fps default project settings)
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: headlessMediaId, startTime: 0, inPoint: 0, outPoint: 6, clipId: "cA" },
        { op: "clip.add", trackId: "v1", mediaId: headlessMediaId, startTime: 6, inPoint: 0, outPoint: 4, clipId: "cB" },
        { op: "clip.add", trackId: "v1", mediaId: headlessMediaId, startTime: 10, inPoint: 2, outPoint: 6, clipId: "cC" },
      ],
    });

    const beforeStrict = await facade["project.get_state"]();
    // strict rejects missing handles with structured frame & second counts
    const strictFail = await facade["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: "cA",
          clipBId: "cB",
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "strict",
        },
      ],
    });
    expect(strictFail.ok).toBe(false);
    if (strictFail.ok) return;
    expect(strictFail.error.code).toBe("INVALID_PARAMS");
    expect(strictFail.error.details).toMatchObject({
      reason: "INSUFFICIENT_TRANSITION_HANDLES",
      requiredHandleEachSec: 0.5,
      missingLeftSec: 0.5,
      missingRightSec: 0.5,
      missingLeftFrames: 15,
      missingRightFrames: 15,
    });
    expect(strictFail.error.details!.leftTailHandleSec as number).toBeLessThan(0.01);
    expect(strictFail.error.details!.rightHeadHandleSec).toBe(0);
    expect(await facade["project.get_state"]()).toEqual(beforeStrict);

    // autoBorrow trims cA.outPoint (-0.5s), trims cB.inPoint (+0.5s), ripple-moves cB (-0.5s) and cC (-1.0s), then adds transition!
    const borrowed = await facade["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: "cA",
          clipBId: "cB",
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "autoBorrow",
        },
      ],
    });
    expect(borrowed.ok).toBe(true);
    if (!borrowed.ok) return;
    expect(borrowed.value.applied[0]!.createdIds).toHaveLength(1);

    const q = await facade["project.get_state"]();
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const v1 = q.value.project.timeline.tracks.find((t) => t.id === "v1")!;
    const [cA, cB, cC] = v1.clips;
    expect(cA!.id).toBe("cA");
    expect(cA!.startTime).toBe(0);
    expect(cA!.duration).toBeCloseTo(5.5, 2);
    expect(cB!.id).toBe("cB");
    expect(cB!.startTime).toBeCloseTo(5.5, 2);
    expect(cB!.inPoint).toBeCloseTo(0.5, 2);
    expect(cB!.duration).toBeCloseTo(3.5, 2);
    expect(cC!.id).toBe("cC");
    expect(cC!.startTime).toBeCloseTo(9.0, 2);
    expect(v1.transitions).toHaveLength(1);
    expect(v1.transitions[0]).toMatchObject({ clipAId: "cA", clipBId: "cB", duration: 1.0 });
    expect(v1.transitions[0]!.id).toBe(borrowed.value.applied[0]!.createdIds[0]);

    // strict succeeds on cB -> cC (cB has ~2s tail, cC has 2s head!)
    const strictOk = await facade["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: "cB",
          clipBId: "cC",
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "strict",
        },
      ],
    });
    expect(strictOk.ok).toBe(true);
    const afterStrict = await facade["project.get_state"]();
    expect(afterStrict.ok).toBe(true);
    if (!afterStrict.ok) return;
    const afterStrictTrack = afterStrict.value.project.timeline.tracks.find((t) => t.id === "v1")!;
    expect(afterStrictTrack.clips).toEqual(v1.clips);
    expect(afterStrictTrack.transitions).toHaveLength(2);
    expect(afterStrictTrack.transitions?.[1]).toMatchObject({ clipAId: "cB", clipBId: "cC", duration: 1 });

    // Live mode autoBorrow + speed-scaled handles check (2x clipA speed halves tail handle!)
    const store = new TestLiveStore(makeSeededProject(10));
    const live = createLiveFacade({
      store,
      lease: new LiveWriterLease(),
      sessionId: "transition-live",
      access: "write",
      artifactRoot: tmpDir,
      mediaRoots: [tmpDir],
    });
    const seededLive = await live["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 0, inPoint: 0, outPoint: 9, speed: 2 }, // tail = (10-9)/2 = 0.5s
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 4.5, inPoint: 0.25, outPoint: 6.25, speed: 1 }, // head = 0.25s
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 10.5, inPoint: 0, outPoint: 4 },
      ],
    });
    expect(seededLive.ok).toBe(true);
    if (!seededLive.ok) return;
    const liveClipA = seededLive.value.applied[0]!.createdIds[0]!;
    const liveClipB = seededLive.value.applied[1]!.createdIds[0]!;
    const liveClipC = seededLive.value.applied[2]!.createdIds[0]!;
    const beforeLiveStrict = structuredClone(store.project);
    const revisionBeforeLiveStrict = store.revision;

    // Duration 1.0s requires 0.5s each; clipA has 0.5s tail, clipB only has 0.25s head => missingRightSec = 0.25s (8 frames at 30fps)
    const liveStrictFail = await live["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: liveClipA,
          clipBId: liveClipB,
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "strict",
        },
      ],
    });
    expect(liveStrictFail.ok).toBe(false);
    if (liveStrictFail.ok) return;
    expect(liveStrictFail.error.details).toMatchObject({
      reason: "INSUFFICIENT_TRANSITION_HANDLES",
      requiredHandleEachSec: 0.5,
      leftTailHandleSec: 0.5,
      rightHeadHandleSec: 0.25,
      missingLeftSec: 0,
      missingRightSec: 0.25,
      missingLeftFrames: 0,
      missingRightFrames: 8,
    });
    expect(store.project).toEqual(beforeLiveStrict);
    expect(store.revision).toBe(revisionBeforeLiveStrict);
    expect(store.batches).toHaveLength(1);

    const liveBorrowed = await live["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: liveClipA,
          clipBId: liveClipB,
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "autoBorrow",
        },
      ],
    });
    expect(liveBorrowed.ok).toBe(true);
    expect(store.revision).toBe(revisionBeforeLiveStrict + 1);
    expect(store.batches).toHaveLength(2);
    const liveClips = store.project.timeline.tracks[0]!.clips;
    expect(liveClips.find((c) => c.id === liveClipA)!.duration).toBeCloseTo(4.5, 6);
    expect(liveClips.find((c) => c.id === liveClipB)).toMatchObject({ startTime: 4.5, inPoint: 0.5, duration: 5.75 });
    expect(liveClips.find((c) => c.id === liveClipC)!.startTime).toBeCloseTo(10.25, 6);
    expect(store.project.timeline.tracks[0]!.transitions).toMatchObject([
      { clipAId: liveClipA, clipBId: liveClipB, duration: 1 },
    ]);

    // autoBorrow rejects when borrowing handles leaves a clip shorter than requiredHandleEachSec
    await live["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 20, inPoint: 0, outPoint: 0.8 },
        { op: "clip.add", trackId: "v1", mediaId: "m-long", startTime: 20.8, inPoint: 0, outPoint: 0.8 },
      ],
    });
    const shortClips = store.project.timeline.tracks[0]!.clips.slice(-2);
    const beforeShortBorrow = structuredClone(store.project);
    const revisionBeforeShortBorrow = store.revision;
    const batchesBeforeShortBorrow = store.batches.length;
    const tooShortBorrow = await live["edit.apply"]({
      ops: [
        {
          op: "transition.add",
          clipAId: shortClips[0]!.id,
          clipBId: shortClips[1]!.id,
          type: "crossfade",
          duration: 1.0,
          handlePolicy: "autoBorrow",
        },
      ],
    });
    expect(tooShortBorrow.ok).toBe(false);
    if (tooShortBorrow.ok) return;
    expect(tooShortBorrow.error.code).toBe("INVALID_PARAMS");
    expect(tooShortBorrow.error.details).toMatchObject({
      reason: "INSUFFICIENT_TRANSITION_HANDLES",
    });
    expect(store.project).toEqual(beforeShortBorrow);
    expect(store.revision).toBe(revisionBeforeShortBorrow);
    expect(store.batches).toHaveLength(batchesBeforeShortBorrow);
  });

  it.each([undefined, "clamp"] as const)("preserves clip timing under the backward-compatible %s handle policy", async (handlePolicy) => {
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: headlessMediaId, startTime: 0, inPoint: 0, outPoint: 6, clipId: "a" },
        { op: "clip.add", trackId: "v1", mediaId: headlessMediaId, startTime: 6, inPoint: 0, outPoint: 4, clipId: "b" },
      ],
    });
    expect(seeded.ok).toBe(true);
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const added = await facade["edit.apply"]({
      ops: [{ op: "transition.add", clipAId: "a", clipBId: "b", type: "crossfade", duration: 1, ...(handlePolicy ? { handlePolicy } : {}) }],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.revision).toBe(before.value.revision + 1);
    expect(after.value.project.timeline.tracks[0]!.clips).toEqual(before.value.project.timeline.tracks[0]!.clips);
    expect(after.value.project.timeline.tracks[0]!.transitions).toEqual([
      expect.objectContaining({ id: added.value.applied[0]!.createdIds[0], clipAId: "a", clipBId: "b", duration: 1 }),
    ]);
  });
});
