/**
 * svg.create over the LIVE store seam — per-op createdIds partitioning.
 *
 * Independent from live-session.test.ts (whose FakeLiveStore predates the
 * svgClips bucket): this slim store implements the Decision 1 contract with
 * the svgClips bucket populated exactly like the canonical GUI store now
 * does, and pins:
 *  - svg.create reports [autoTrackId, overlayId] when it implies a new
 *    graphics lane (the text.create convention),
 *  - svg.create on an explicit graphics track reports just the overlay id,
 *  - a mixed batch hands each overlay op the id of its own entity,
 *  - a seam store WITHOUT the optional svgClips bucket still commits and
 *    honestly reports no ids (agents fall back to timeline.query).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "@openreel/core/actions/action-executor";
import { ActionHistory } from "@openreel/core/actions/action-history";
import type { Action } from "@openreel/core/types/actions";
import type { Project } from "@openreel/core/types/project";

import { createLiveFacade, LiveWriterLease } from "./index";
import { LiveStoreConflictError } from "./live-store";
import type {
  LiveApplyActionsOptions,
  LiveCreatedIds,
  LiveEditorContext,
  LiveEditorControlParams,
  LiveEditorControlResult,
  LiveProjectStore,
} from "./live-store";
import { collectEntityIds, diffCreatedIdsByCategory } from "./ops";
import { createEmptyProject } from "./project-factory";
import type {
  EditOp,
  HistoryControlResult,
  HistoryGetParams,
  HistoryGetResult,
  ProjectChangesParams,
  ProjectChangesResult,
} from "./types";

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

class SlimSvgStore implements LiveProjectStore {
  project: Project;
  revision = 0;
  private readonly context: LiveEditorContext = {
    contextRevision: 1,
    playheadSeconds: null,
    selectedClipIds: [],
    selectedTextIds: [],
    selectedMediaIds: [],
    timeRange: null,
    canvasPoint: null,
    references: {},
  };
  readonly batches: Array<{
    readonly actions: readonly Action[];
    readonly opts: LiveApplyActionsOptions;
  }> = [];
  /** When false, applyActions omits the svgClips bucket (seam-compat case). */
  reportSvgClips = true;

  constructor(project?: Project) {
    this.project = project ?? createEmptyProject("Svg Live");
  }

  async getIdentity() {
    return {
      projectId: this.project.id,
      projectName: this.project.name,
      windowId: "win-1",
    };
  }

  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }

  async getContext(): Promise<LiveEditorContext> {
    return { ...this.context };
  }

  async getProjectChanges(params: ProjectChangesParams): Promise<ProjectChangesResult> {
    return {
      fromRevision: params.sinceRevision,
      toRevision: this.revision,
      changes: [],
      nextCursor: null,
      requiresFullRefresh: params.sinceRevision < this.revision,
    };
  }

  async getHistory(params: HistoryGetParams): Promise<HistoryGetResult> {
    void params;
    return {
      revision: this.revision,
      available: false,
      canUndo: false,
      canRedo: false,
      undoCount: 0,
      redoCount: 0,
      entries: [],
    };
  }

  async historyControl(): Promise<Omit<HistoryControlResult, "action">> {
    throw new Error("not used by svg seam tests");
  }

  async editorControl(params: LiveEditorControlParams): Promise<LiveEditorControlResult> {
    void params;
    throw new Error("not used by svg seam tests");
  }

  async applyActions(
    actions: readonly Action[],
    opts: LiveApplyActionsOptions,
  ): Promise<{ revision: number; createdIds: LiveCreatedIds }> {
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== this.revision) {
      throw new LiveStoreConflictError(
        `store revision conflict: expected ${opts.expectedRevision}, current is ${this.revision}`,
        { currentRevision: this.revision },
      );
    }
    const draft = structuredClone(this.project);
    const ids = {
      tracks: [] as string[],
      clips: [] as string[],
      textClips: [] as string[],
      svgClips: [] as string[],
      transitions: [] as string[],
      subtitles: [] as string[],
    };
    const executor = new ActionExecutor(new ActionHistory());
    for (const action of actions) {
      const before = collectEntityIds(draft);
      const result = await executor.execute(action, draft);
      if (!result.success) {
        throw new Error(`store apply failed: ${result.error?.message ?? "unknown"}`);
      }
      const diff = diffCreatedIdsByCategory(before, collectEntityIds(draft));
      ids.tracks.push(...diff.tracks);
      ids.clips.push(...diff.clips);
      ids.textClips.push(...diff.textClips);
      ids.svgClips.push(...diff.svgClips);
      ids.transitions.push(...diff.transitions);
      ids.subtitles.push(...diff.subtitles);
    }
    this.project = draft;
    this.revision += 1;
    this.batches.push({ actions, opts });
    const createdIds: LiveCreatedIds =
      this.reportSvgClips
        ? ids
        : {
            tracks: ids.tracks,
            clips: ids.clips,
            textClips: ids.textClips,
            transitions: ids.transitions,
            subtitles: ids.subtitles,
          };
    return { revision: this.revision, createdIds };
  }

  async importMedia(): Promise<{ revision: number; mediaId: string }> {
    throw new Error("not used by svg seam tests");
  }

  async requestSave() {
    return { revision: this.revision };
  }
}

describe("live svg.create per-op createdIds (store seam)", () => {
  let artifactRoot: string;
  let store: SlimSvgStore;
  let lease: LiveWriterLease;

  beforeEach(async () => {
    artifactRoot = await mkdtemp(path.join(tmpdir(), "svg-live-"));
    store = new SlimSvgStore();
    lease = new LiveWriterLease();
  });

  afterEach(async () => {
    await rm(artifactRoot, { recursive: true, force: true });
  });

  function liveFacade() {
    return createLiveFacade({
      store,
      lease,
      sessionId: "svg-agent-1",
      workMode: "collaborative",
      access: "write",
      artifactRoot,
    });
  }

  async function apply(ops: readonly EditOp[]) {
    const res = await liveFacade()["edit.apply"]({
      ops: [...ops],
      expectedRevision: store.revision,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    return res.value;
  }

  it("svg.create with an implied graphics lane reports [autoTrackId, overlayId]", async () => {
    const result = await apply([
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 3 },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.op).toBe("svg.create");
    const createdIds = result.applied[0]!.createdIds;
    expect(createdIds).toHaveLength(2);

    // [autoTrackId, overlayId] — the text.create convention, both real ids
    // from the canonical store diff.
    const lane = store.project.timeline.tracks.find((t) => t.type === "graphics");
    expect(lane).toBeTruthy();
    expect(createdIds[0]).toBe(lane!.id);
    expect(store.project.svgClips).toHaveLength(1);
    expect(createdIds[1]).toBe(store.project.svgClips![0]!.id);

    // One atomic batch: the implied lane's track/add rides with svg/create.
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]!.actions.map((action) => action.type)).toEqual([
      "track/add",
      "svg/create",
    ]);
  });

  it("svg.create on an explicit graphics track reports just the overlay id", async () => {
    const result = await apply([
      { op: "track.add", trackType: "graphics", trackId: "g1" },
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 3, trackId: "g1" },
    ]);
    expect(result.applied[0]).toEqual({ op: "track.add", createdIds: ["g1"] });
    expect(result.applied[1]!.op).toBe("svg.create");
    expect(result.applied[1]!.createdIds).toHaveLength(1);
    expect(result.applied[1]!.createdIds[0]).toBe(store.project.svgClips![0]!.id);
  });

  it("a mixed overlay batch hands each op the id of its own entity", async () => {
    const result = await apply([
      { op: "text.create", text: "t", startTime: 0, duration: 2 },
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 2 },
    ]);
    expect(result.applied).toHaveLength(2);
    expect(result.applied[0]!.op).toBe("text.create");
    expect(result.applied[1]!.op).toBe("svg.create");
    // No cross-assignment: the text id is a textClips member, the svg id an
    // svgClips member.
    expect(store.project.textClips![0]!.id).toBe(result.applied[0]!.createdIds.at(-1));
    expect(store.project.svgClips![0]!.id).toBe(result.applied[1]!.createdIds.at(-1));
    expect(store.project.svgClips![0]!.id).not.toBe(
      store.project.textClips![0]!.id,
    );
  });

  it("a seam store without the optional svgClips bucket still commits the clip", async () => {
    store.reportSvgClips = false;
    const result = await apply([
      { op: "svg.create", svgContent: SAFE_SVG, startTime: 0, duration: 3 },
    ]);
    // The batch applied (project carries the clip); the implied lane's id is
    // still reported via the tracks bucket, but the clip id is absent — an
    // honest reflection of what a pre-bucket store reported.
    expect(store.project.svgClips).toHaveLength(1);
    expect(result.applied[0]!.op).toBe("svg.create");
    expect(result.applied[0]!.createdIds).toEqual([
      store.project.timeline.tracks.find((track) => track.type === "graphics")!.id,
    ]);
  });
});
