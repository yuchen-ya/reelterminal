import { describe, it, expect, beforeEach } from "vitest";
import {
  useEditorContextStore,
  getLiveEditorContext,
  markAgentReferences,
  resetAgentReferences,
} from "./editor-context-store";
import type { AgentReferenceTarget } from "./agent-references-store";
import { useTimelineStore } from "./timeline-store";
import { useUIStore } from "./ui-store";
import { getProjectRevision } from "./project-store";

const revision = (): number => useEditorContextStore.getState().contextRevision;

describe("editor-context-store", () => {
  beforeEach(() => {
    useTimelineStore.getState().seekTo(0);
    useUIStore.getState().clearSelection();
    useEditorContextStore.getState().clearCanvasPoint();
    useEditorContextStore.getState().clearTimeRange();
    resetAgentReferences();
  });

  it("bumps contextRevision when the playhead moves", () => {
    const before = revision();
    useTimelineStore.getState().seekTo(2.5);
    expect(revision()).toBe(before + 1);
  });

  it("does not bump when the playhead is set to its current value", () => {
    useTimelineStore.getState().seekTo(1.25);
    const before = revision();
    useTimelineStore.getState().seekTo(1.25);
    expect(revision()).toBe(before);
  });

  it("does not bump for ordinary playback clock ticks", () => {
    const before = revision();
    useTimelineStore.getState().setPlayheadPosition(0.25);
    useTimelineStore.getState().setPlayheadPosition(0.5);
    expect(revision()).toBe(before);
  });

  it("bumps contextRevision when the selection changes", () => {
    const before = revision();
    useUIStore.getState().select({ type: "clip", id: "clip-1" });
    expect(revision()).toBe(before + 1);
  });

  it("bumps contextRevision when the canvas point changes", () => {
    const before = revision();
    useEditorContextStore.getState().setCanvasPoint({ x: 0.5, y: 0.25 });
    expect(revision()).toBe(before + 1);
    useEditorContextStore.getState().clearCanvasPoint();
    expect(revision()).toBe(before + 2);
  });

  it("does not bump for a redundant canvas-point set/clear", () => {
    useEditorContextStore.getState().setCanvasPoint({ x: 0.5, y: 0.5 });
    const before = revision();
    useEditorContextStore.getState().setCanvasPoint({ x: 0.5, y: 0.5 });
    expect(revision()).toBe(before);
    useEditorContextStore.getState().clearCanvasPoint();
    useEditorContextStore.getState().clearCanvasPoint();
    expect(revision()).toBe(before + 1);
  });

  it("bumps contextRevision when the time range changes", () => {
    const before = revision();
    useEditorContextStore
      .getState()
      .setTimeRange({ startSeconds: 1, endSeconds: 4 });
    expect(revision()).toBe(before + 1);
    useEditorContextStore.getState().clearTimeRange();
    expect(revision()).toBe(before + 2);
  });

  it("getLiveEditorContext maps playhead, selection, point and range", () => {
    useTimelineStore.getState().seekTo(3.2);
    useUIStore.getState().selectMultiple([
      { type: "clip", id: "clip-a" },
      { type: "text-clip", id: "text-a" },
      { type: "shape-clip", id: "shape-a" },
      { type: "track", id: "track-a" },
      { type: "marker", id: "marker-a" },
    ]);
    useEditorContextStore.getState().setCanvasPoint({ x: 0.1, y: 0.9 });
    useEditorContextStore
      .getState()
      .setTimeRange({ startSeconds: 2, endSeconds: 5 });

    const ctx = getLiveEditorContext();
    expect(ctx.playheadSeconds).toBeCloseTo(3.2);
    expect(ctx.selectedClipIds).toEqual(["clip-a", "shape-a"]);
    expect(ctx.selectedTextIds).toEqual(["text-a"]);
    expect(ctx.canvasPoint).toEqual({ x: 0.1, y: 0.9 });
    expect(ctx.timeRange).toEqual({ startSeconds: 2, endSeconds: 5 });
    expect(ctx.contextRevision).toBe(revision());
  });

  it("getLiveEditorContext reports empty selection honestly", () => {
    const ctx = getLiveEditorContext();
    expect(ctx.selectedClipIds).toEqual([]);
    expect(ctx.selectedTextIds).toEqual([]);
    expect(ctx.canvasPoint).toBeNull();
    expect(ctx.timeRange).toBeNull();
    expect(ctx.references).toEqual({});
  });

  it("projects stable agent references into the live context", () => {
    const targets: AgentReferenceTarget[] = [
      {
        kind: "video",
        entityId: "late",
        label: "Late",
        timing: { startSeconds: 4, endSeconds: 6 },
        trackOrder: 0,
      },
      {
        kind: "audio",
        entityId: "early",
        label: "Early",
        timing: { startSeconds: 1, endSeconds: 3 },
        trackOrder: 1,
      },
    ];
    const marked = markAgentReferences(targets);
    expect(marked.map((reference) => reference.number)).toEqual([1, 2]);
    expect(getLiveEditorContext().references).toMatchObject({
      "1": { ref: "A1", entityId: "early", kind: "audio", revisionAtMark: getProjectRevision() },
      "2": { ref: "A2", entityId: "late", kind: "video", revisionAtMark: getProjectRevision() },
    });
  });
});
