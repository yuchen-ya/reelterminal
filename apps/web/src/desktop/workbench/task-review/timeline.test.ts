import { describe, expect, it } from "vitest";
import type { TaskReviewSnapshot, TaskSceneSuggestion } from "../../../../../desktop/src/shared/task-review";
import type { UnitRef } from "./timeline";
import {
  activeScene,
  back,
  canBack,
  continueTarget,
  continueScene,
  openAgentScene,
  currentRef,
  initialTimeline,
  openTemporary,
  openUnit,
  setEditing,
} from "./timeline";
import { emptySnapshot } from "./testing";
import {
  currentSources,
  issuesForUnit,
  remainingPlanSteps,
  unitStats,
} from "./queries";

const ref = (unitId: string, purpose = "review"): UnitRef => ({
  unitId,
  sourceVersionId: "source-1",
  purpose,
});

const snapshot = (units: string[], overrides: Partial<TaskReviewSnapshot> = {}): TaskReviewSnapshot => ({
  ...emptySnapshot(),
  sources: [
    {
      id: "source-1",
      entryId: "entry-1",
      relativePath: "lines.txt",
      hash: "h",
      format: "txt",
      text: "t",
      createdAt: 1,
    },
  ],
  sourceFiles: [
    {
      entryId: "entry-1",
      relativePath: "lines.txt",
      size: 1,
      mtimeMs: 1,
      currentVersionId: "source-1",
      status: "available",
    },
  ],
  units: units.map((id, index) => ({
    id,
    sourceVersionId: "source-1",
    ordinal: index + 1,
    text: `line ${index + 1}`,
    startLine: index + 1,
    endLine: index + 1,
  })),
  ...overrides,
});

/** Records a decide action the same way desktop main does. */
const decided = (
  base: TaskReviewSnapshot,
  unitId: string,
  status: "kept" | "rework" | "discarded",
  purpose = "review",
): TaskReviewSnapshot => ({
  ...base,
  decisions: [
    ...base.decisions,
    {
      id: `decision-${unitId}-${purpose}`,
      unitId,
      sourceVersionId: "source-1",
      policyRevision: base.policyRevision,
      purpose,
      status,
      note: "",
      createdAt: 1,
    },
  ],
  decisionActions: [
    ...base.decisionActions,
    { id: `action-${unitId}-${purpose}`, kind: "decide", decisionId: `decision-${unitId}-${purpose}`, createdAt: 1 },
  ],
});

const visit = (unitId: string) => ({
  id: `visit-${unitId}`,
  unitId,
  sourceVersionId: "source-1",
  purpose: "review",
  createdAt: 1,
});

const plan = (base: TaskReviewSnapshot, unitIds: string[]) => ({
  ...base,
  planRevisions: [
    {
      id: "plan-1",
      policyRevision: base.policyRevision,
      createdAt: 1,
      reason: "风险优先",
      steps: unitIds.map((unitId) => ({
        unitId,
        sourceVersionId: "source-1",
        purpose: "review",
        reason: "理由",
      })),
    },
  ],
});

describe("task review timeline", () => {
  it("keeps the source work anchor while a derived frame is open and continues without approving either", () => {
    const base = snapshot([]);
    const task: TaskReviewSnapshot = {
      ...base,
      sources: [{ id: "source-1", entryId: "entry-1", relativePath: "clip.mp4", hash: "h", createdAt: 1, kind: "video", mime: "video/mp4", width: 100, height: 50, durationSec: 10 },
        { id: "source-2", entryId: "entry-2", relativePath: "photo.png", hash: "h2", createdAt: 1, kind: "image", mime: "image/png", width: 100, height: 50, durationSec: 0 }],
      sourceFiles: [...base.sourceFiles, { entryId: "entry-2", relativePath: "photo.png", size: 10, mtimeMs: 1, currentVersionId: "source-2", status: "available" }],
      units: [{ id: "video", sourceVersionId: "source-1", ordinal: 1, kind: "video" },
        { id: "frame", sourceVersionId: "source-1", ordinal: 2, kind: "video-frame", assetId: "actual-frame", pixelRevision: "pixels", width: 100, height: 50, ptsTimeSec: 2.004, timeBase: "1/1000" },
        { id: "next", sourceVersionId: "source-2", ordinal: 1, kind: "image" }],
    };
    const scene = (unitId: string, sourceVersionId: string): TaskSceneSuggestion => ({ id: `manual-${unitId}`, manual: true, kind: "single", targets: [{ unitId, sourceVersionId }], purpose: "review", decisionMode: "per-unit", checkIntent: "人工查看", reason: "本地工具", issueIds: [], criteriaRefs: [], sourceRefs: [], criteriaBasis: [{ taskId: task.taskId, unitId, sourceVersionId, purpose: "review", policyRevision: 0, criteriaVersionIds: [] }] });
    const videoScene = scene("video", "source-1");
    const nextScene = scene("next", "source-2");
    task.planRevisions = [{ id: "manual-plan", policyRevision: 0, createdAt: 1, reason: "人工计划", steps: [], scenes: [videoScene, scene("frame", "source-1"), nextScene] }];
    let state = openAgentScene(initialTimeline([]), videoScene, ref("video"), "manual-plan");
    state = openUnit(state, ref("frame"), "manual-plan", ref("video"));
    state = back(openTemporary(state, "global"));
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("frame") });
    expect(continueScene(task, state)).toEqual({ suggestion: nextScene, ref: { ...ref("next"), sourceVersionId: "source-2" } });
    expect(unitStats(task)).toMatchObject({ total: 3, decided: 0, pending: 3 });
  });
  it("keeps the undecided part of a manually visited future group", () => {
    const scene = (id: string, ids: string[]): TaskSceneSuggestion => ({ id, kind: "lowRiskGroup", targets: ids.map((unitId) => ({ unitId, sourceVersionId: "source-1" })), purpose: "review", decisionMode: "per-unit", checkIntent: "扫阅", reason: "已分析", issueIds: [], criteriaRefs: [], sourceRefs: [], criteriaBasis: [] });
    const working = scene("working", ["a", "b"]);
    const future = scene("future", ["c", "d"]);
    const task = decided({ ...snapshot(["a", "b", "c", "d"]), planRevisions: [{ id: "scenes-plan", policyRevision: 0, createdAt: 1, reason: "场景计划", steps: [], scenes: [working, future] }] }, "c", "kept");
    const state = openAgentScene(initialTimeline([]), working, ref("a"), "scenes-plan");
    expect(continueScene(task, state)).toEqual({ suggestion: future, ref: ref("d") });
    expect(unitStats(task).pending).toBe(3);
    const nextPolicy = { ...task, policyRevision: 1, planRevisions: [...task.planRevisions,
      { id: "new-policy-plan", policyRevision: 1, createdAt: 2, reason: "新口径", steps: [], scenes: [working, future] }] };
    // Even a reused scene ID cannot suppress a fresh-basis review as visited.
    expect(continueScene(nextPolicy, state)).toEqual({ suggestion: working, ref: ref("a") });
  });
  it("starts at the last visited unit after a restart", () => {
    const state = initialTimeline([visit("a"), visit("b")]);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("b") });
  });

  it("starts at folder file management without visit history", () => {
    expect(activeScene(initialTimeline([]))).toEqual({ kind: "directory" });
  });

  it("back from a temporary global scene restores the covered unit B", () => {
    let state = openUnit(initialTimeline([]), ref("a"));
    state = openUnit(state, ref("b"));
    state = openTemporary(state, "global");
    expect(activeScene(state)).toEqual({ kind: "global" });
    expect(canBack(state)).toBe(true);
    state = back(state);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("b") });
  });

  it("back from a unit scene returns to the previous unit and back is not undo", () => {
    let state = openUnit(initialTimeline([]), ref("a"));
    state = openUnit(state, ref("b"));
    state = back(state);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("a") });
    // A pending decision is never fabricated by navigation.
    const withDecision = decided(snapshot(["a", "b"]), "b", "kept");
    expect(withDecision.decisionActions).toHaveLength(1);
  });

  it("continue follows the plan to C even while undecided B stays pending", () => {
    let state = openUnit(initialTimeline([]), ref("a"));
    state = openUnit(state, ref("b"));
    state = setEditing(state, true);
    state = openTemporary(state, "global");
    const base = snapshot(["a", "b", "c"]);
    const planned = plan(base, ["b", "c"]);
    state = back(state);
    expect(activeScene(state)).toEqual({ kind: "edit", ref: ref("b") });
    expect(continueTarget(planned, currentRef(state))).toEqual(ref("c"));
    expect(unitStats(planned).pending).toBe(3);
    state = back(state);
    state = openUnit(state, continueTarget(planned, currentRef(state))!);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("c") });
    expect(currentRef(back(state))).toEqual(ref("b"));
  });

  it("restores nested temporary scenes before the covered edit scene", () => {
    let state = setEditing(openUnit(initialTimeline([]), ref("b")), true);
    state = openTemporary(openTemporary(state, "global"), "directory");
    expect(activeScene(back(state))).toEqual({ kind: "global" });
    state = back(back(state));
    expect(activeScene(state)).toEqual({ kind: "edit", ref: ref("b") });
    state = openUnit(openTemporary(state, "global"), ref("x"));
    expect(activeScene(back(state))).toEqual({ kind: "global" });
    expect(activeScene(back(back(state)))).toEqual({ kind: "edit", ref: ref("b") });
  });

  it("skips completed future steps only at the current policy and honors decision undo", () => {
    const planned = plan(snapshot(["b", "c", "d"]), ["b", "c", "d"]);
    const completed = decided(planned, "c", "kept");
    expect(continueTarget(completed, ref("b"))).toEqual(ref("d"));
    const undone = { ...completed, decisionActions: [...completed.decisionActions,
      { id: "undo-c", kind: "undo" as const, decisionId: "decision-c-review", createdAt: 2 }] };
    expect(continueTarget(undone, ref("b"))).toEqual(ref("c"));
    const currentPolicy = { ...completed, policyRevision: completed.policyRevision + 1 };
    expect(remainingPlanSteps(currentPolicy)).toEqual([]);
    expect(continueTarget(currentPolicy, ref("b"))).toEqual(ref("c"));
    expect(continueTarget(decided(planned, "c", "kept", "other"), ref("b"))).toEqual(ref("c"));
  });

  it("skips a manually completed future step only for the same purpose", () => {
    const base = snapshot(["a", "b", "c"]);
    const planned = plan(base, ["c"]);
    const otherPurpose = decided(planned, "c", "kept", "other");
    expect(continueTarget(otherPurpose)).toEqual(ref("c"));
    const samePurpose = decided(planned, "c", "kept");
    // Nothing else is planned; the fallback skim path offers the first undecided unit.
    expect(continueTarget(samePurpose)).toEqual(ref("a"));
  });

  it("falls back to ordinal skim order when no plan exists", () => {
    expect(continueTarget(snapshot(["a", "b"]))).toEqual(ref("a"));
    expect(continueTarget(decided(snapshot(["a", "b"]), "a", "kept"))).toEqual(ref("b"));
  });

  it("an undone decision puts its unit back on the plan", () => {
    const base = decided(plan(snapshot(["a", "b"]), ["a"]), "a", "kept");
    const undone: TaskReviewSnapshot = {
      ...base,
      decisionActions: [
        ...base.decisionActions,
        { id: "action-undo", kind: "undo", decisionId: "decision-a-review", createdAt: 2 },
      ],
    };
    expect(continueTarget(undone)).toEqual(ref("a"));
  });

  it("stale-policy decisions need a recheck and do not count as decided", () => {
    const decidedSnapshot = decided(snapshot(["a", "b"]), "a", "kept");
    const rechecking = { ...decidedSnapshot, policyRevision: decidedSnapshot.policyRevision + 1 };
    expect(continueTarget(rechecking)).toEqual(ref("a"));
  });

  it("does not present old-policy evidence or plans as current analysis", () => {
    const base = plan(snapshot(["a"]), ["a"]);
    base.issues.push({ id: "old-issue", unitId: "a", sourceVersionId: "source-1", policyRevision: base.policyRevision,
      severity: "high", title: "旧疑点", evidence: "line 1", hypothesis: "旧假设", options: [] });
    const changed = { ...base, policyRevision: base.policyRevision + 1 };
    expect(issuesForUnit(changed, "a")).toEqual([]);
    expect(remainingPlanSteps(changed)).toEqual([]);
    expect(issuesForUnit({ ...base, sourceFiles: [{ ...base.sourceFiles[0]!, status: "missing" as const }] }, "a")).toEqual([]);
  });

  it("superseded, missing and invalid source versions are history, not current progress", () => {
    const base = snapshot(["old-a", "old-b"]);
    const superseded: TaskReviewSnapshot = {
      ...base,
      sources: [
        ...base.sources,
        {
          id: "source-2",
          entryId: "entry-1",
          relativePath: "lines.txt",
          hash: "h2",
          format: "txt",
          text: "t2",
          createdAt: 2,
        },
      ],
      sourceFiles: [
        { ...base.sourceFiles[0], currentVersionId: "source-2" },
      ],
      units: [
        ...base.units,
        {
          id: "new-a",
          sourceVersionId: "source-2",
          ordinal: 1,
          text: "new line",
          startLine: 1,
          endLine: 1,
        },
      ],
    };
    // The undecided old-version units never re-enter progress or the skim path.
    expect(unitStats(superseded)).toMatchObject({ total: 1, pending: 1 });
    expect(continueTarget(superseded)).toEqual({
      unitId: "new-a",
      sourceVersionId: "source-2",
      purpose: "review",
    });
    // A plan step bound to the superseded version cannot be decided again.
    expect(remainingPlanSteps(plan(superseded, ["old-a"]))).toEqual([]);
    // Missing and unreadable files are not current sources for export either.
    const missing: TaskReviewSnapshot = {
      ...superseded,
      sourceFiles: [
        { ...superseded.sourceFiles[0], status: "missing" as const },
      ],
    };
    const invalid: TaskReviewSnapshot = {
      ...superseded,
      sourceFiles: [
        { ...superseded.sourceFiles[0], status: "invalid" as const },
      ],
    };
    expect(currentSources(missing)).toEqual([]);
    expect(currentSources(invalid)).toEqual([]);
    expect(continueTarget(missing)).toBeNull();
  });

  it("edit scene is exclusive and back returns to its unit review", () => {
    let state = openUnit(initialTimeline([]), ref("a"));
    state = setEditing(state, true);
    expect(activeScene(state)).toEqual({ kind: "edit", ref: ref("a") });
    state = back(state);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("a") });
  });

  it("a new plan revision changes only the future, not the open scene", () => {
    let state = openUnit(initialTimeline([]), ref("b"));
    const nextPlan = plan(snapshot(["a", "b", "c"]), ["c"]);
    // The open unit scene is renderer state; a plan refresh cannot move it.
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("b") });
    expect(continueTarget(nextPlan)).toEqual(ref("c"));
    state = openUnit(state, continueTarget(nextPlan)!);
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("c") });
  });

  it("re-opening the current unit only drops the temporary overlay", () => {
    let state = openUnit(initialTimeline([]), ref("a"));
    state = openUnit(state, ref("b"));
    state = openTemporary(state, "directory");
    state = openUnit(state, ref("b"));
    expect(activeScene(state)).toEqual({ kind: "unit", ref: ref("b") });
    // No duplicate visit entry: the covered unit simply reappears.
    expect(state.visited.filter((item) => item.unitId === "b")).toHaveLength(1);
  });
});
