/**
 * Pure createdIds diff helpers behind executeActionBatch: the svgClips
 * bucket must track svg/create actions exactly like the textClips bucket
 * tracks text/create, so the live seam can hand each svg.create op the id
 * of its own entity.
 */
import { describe, expect, it } from "vitest";
import type { Project } from "@openreel/core";
import {
  appendCreatedIdDiff,
  emptyActionBatchCreatedIds,
  projectEntityIds,
} from "./action-batch";

function projectWithOverlays(): Project {
  return {
    id: "p1",
    name: "Diff",
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30 },
    timeline: {
      tracks: [
        {
          id: "v1",
          type: "video",
          name: "V1",
          clips: [
            {
              id: "c1",
              mediaId: "m1",
              trackId: "v1",
              startTime: 0,
              duration: 5,
              inPoint: 0,
              outPoint: 5,
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
      subtitles: [],
    },
    mediaLibrary: { items: [] },
    textClips: [{ id: "text-1", trackId: "t1", startTime: 0, duration: 1, text: "x", style: {}, transform: {}, keyframes: [] }],
    svgClips: [{ id: "svg-1", trackId: "g1", startTime: 0, duration: 1, type: "svg", svgContent: "<svg/>", viewBox: { minX: 0, minY: 0, width: 10, height: 10 }, preserveAspectRatio: "xMidYMid", transform: {}, keyframes: [] }],
    markers: { items: [], nextNumber: 1 },
  } as unknown as Project;
}

describe("action-batch createdIds helpers (svgClips bucket)", () => {
  it("emptyActionBatchCreatedIds carries an empty svgClips bucket", () => {
    const ids = emptyActionBatchCreatedIds();
    expect(ids.svgClips).toEqual([]);
    expect(ids.tracks).toEqual([]);
    expect(ids.textClips).toEqual([]);
  });

  it("projectEntityIds indexes svg clips alongside the other families", () => {
    const ids = projectEntityIds(projectWithOverlays());
    expect(ids.svgClips).toEqual(["svg-1"]);
    expect(ids.textClips).toEqual(["text-1"]);
    expect(ids.clips).toEqual(["c1"]);
    expect(ids.tracks).toEqual(["v1"]);
  });

  it("appendCreatedIdDiff records only newly created svg clip ids", () => {
    const target = emptyActionBatchCreatedIds();
    const before = projectEntityIds(projectWithOverlays());
    const afterProject = projectWithOverlays();
    (afterProject.svgClips as Array<{ id: string }>).push({
      id: "svg-2",
      trackId: "g1",
      startTime: 2,
      duration: 1,
      type: "svg",
      svgContent: "<svg/>",
      viewBox: { minX: 0, minY: 0, width: 10, height: 10 },
      preserveAspectRatio: "xMidYMid",
      transform: {},
      keyframes: [],
    } as never);
    const after = projectEntityIds(afterProject);

    appendCreatedIdDiff(target, before, after);
    expect(target.svgClips).toEqual(["svg-2"]);
    expect(target.textClips).toEqual([]);
    expect(target.clips).toEqual([]);

    // Each call appends its own before/after delta (executeActionBatch calls
    // it once per action with that action's own before snapshot).
    appendCreatedIdDiff(target, before, after);
    expect(target.svgClips).toEqual(["svg-2", "svg-2"]);
  });
});
