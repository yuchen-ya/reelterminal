import { describe, it, expect } from "vitest";
import type { Project, ProjectMarkersState } from "@openreel/core";
import type { SelectionItem } from "../ui-store";
import {
  findClipMarkersActiveAt,
  findMarkersForEntity,
  findTimeRangeMarkersAt,
  markersForSelection,
} from "./project-marker-selectors";

const markers: ProjectMarkersState = {
  nextNumber: 8,
  items: [
    {
      id: "m1",
      number: 1,
      target: { kind: "asset", mediaId: "media-1" },
      createdAt: 1,
    },
    {
      id: "m2",
      number: 2,
      target: { kind: "clip", clipId: "clip-1" },
      createdAt: 2,
    },
    {
      id: "m3",
      number: 3,
      target: { kind: "text", textClipId: "text-1" },
      createdAt: 3,
    },
    {
      id: "m4",
      number: 4,
      target: { kind: "timeRange", start: 2, end: 5 },
      createdAt: 4,
    },
    {
      id: "m5",
      number: 5,
      target: { kind: "timeRange", start: 10, end: 10 },
      createdAt: 5,
    },
    {
      id: "m6",
      number: 6,
      target: { kind: "clip", clipId: "shape-1" },
      createdAt: 6,
    },
    {
      id: "m7",
      number: 7,
      target: { kind: "clip", clipId: "clip-2" },
      label: "Fix color",
      createdAt: 7,
    },
  ],
};

const project = {
  timeline: {
    tracks: [
      {
        id: "track-1",
        type: "video",
        clips: [
          { id: "clip-1", startTime: 1, duration: 4 },
          { id: "clip-2", startTime: 8, duration: 4 },
        ],
      },
    ],
  },
  textClips: [{ id: "text-1", startTime: 3, duration: 5 }],
  shapeClips: [{ id: "shape-1", startTime: 4, duration: 2 }],
} as unknown as Project;

const numbers = (list: readonly { number: number }[]): number[] =>
  list.map((marker) => marker.number);

describe("findMarkersForEntity", () => {
  it("matches each entity target kind by id", () => {
    expect(numbers(findMarkersForEntity(markers, { mediaId: "media-1" }))).toEqual([1]);
    expect(numbers(findMarkersForEntity(markers, { clipId: "clip-1" }))).toEqual([2]);
    expect(numbers(findMarkersForEntity(markers, { textClipId: "text-1" }))).toEqual([3]);
  });

  it("does not cross-match ids between target kinds", () => {
    expect(findMarkersForEntity(markers, { clipId: "media-1" })).toEqual([]);
    expect(findMarkersForEntity(markers, { mediaId: "clip-1" })).toEqual([]);
    expect(findMarkersForEntity(markers, { textClipId: "clip-1" })).toEqual([]);
  });

  it("ignores time-range markers for entity queries", () => {
    expect(findMarkersForEntity(markers, {})).toEqual([]);
  });

  it("tolerates an absent markers field", () => {
    expect(findMarkersForEntity(undefined, { mediaId: "media-1" })).toEqual([]);
    expect(findMarkersForEntity(null, { clipId: "clip-1" })).toEqual([]);
  });
});

describe("findTimeRangeMarkersAt", () => {
  const frameRate = 30;
  const halfFrame = 0.5 / frameRate;

  it("contains the playhead across the whole range, endpoints included", () => {
    expect(numbers(findTimeRangeMarkersAt(markers, 2, frameRate))).toEqual([4]);
    expect(numbers(findTimeRangeMarkersAt(markers, 3.5, frameRate))).toEqual([4]);
    expect(numbers(findTimeRangeMarkersAt(markers, 5, frameRate))).toEqual([4]);
    expect(numbers(findTimeRangeMarkersAt(markers, 5.01, frameRate))).toEqual([]);
    expect(numbers(findTimeRangeMarkersAt(markers, 1.99, frameRate))).toEqual([]);
  });

  it("matches point markers within half a frame on either side", () => {
    expect(numbers(findTimeRangeMarkersAt(markers, 10, frameRate))).toEqual([5]);
    expect(numbers(findTimeRangeMarkersAt(markers, 10 + halfFrame, frameRate))).toEqual([5]);
    expect(numbers(findTimeRangeMarkersAt(markers, 10 - halfFrame, frameRate))).toEqual([5]);
  });

  it("excludes point markers just outside the half-frame tolerance", () => {
    const outside = 0.6 / frameRate;
    expect(numbers(findTimeRangeMarkersAt(markers, 10 + outside, frameRate))).toEqual([]);
    expect(numbers(findTimeRangeMarkersAt(markers, 10 - outside, frameRate))).toEqual([]);
  });

  it("falls back to exact matching when the frame rate is not positive", () => {
    expect(numbers(findTimeRangeMarkersAt(markers, 10, 0))).toEqual([5]);
    expect(numbers(findTimeRangeMarkersAt(markers, 10.001, 0))).toEqual([]);
  });
});

describe("findClipMarkersActiveAt", () => {
  it("matches timeline clips while the playhead is inside them", () => {
    expect(numbers(findClipMarkersActiveAt(markers, project, 1))).toEqual([2]);
    expect(numbers(findClipMarkersActiveAt(markers, project, 4.99))).toEqual([2, 3, 6]);
  });

  it("treats clip end as exclusive", () => {
    // clip-1 spans [1, 5): at exactly 5 only the text overlay stays active.
    expect(numbers(findClipMarkersActiveAt(markers, project, 5))).toEqual([3, 6]);
  });

  it("matches text overlays and overlay graphics at their active times", () => {
    expect(numbers(findClipMarkersActiveAt(markers, project, 3))).toEqual([2, 3]);
    expect(numbers(findClipMarkersActiveAt(markers, project, 4.5))).toEqual([2, 3, 6]);
  });

  it("drops markers whose target no longer exists", () => {
    const emptyProject = {
      timeline: { tracks: [] },
      textClips: [],
    } as unknown as Project;
    expect(findClipMarkersActiveAt(markers, emptyProject, 3)).toEqual([]);
  });
});

describe("markersForSelection", () => {
  it("projects every selection kind onto its markers", () => {
    const selection: SelectionItem[] = [
      { type: "media", id: "media-1" },
      { type: "clip", id: "clip-1" },
      { type: "text-clip", id: "text-1" },
      { type: "shape-clip", id: "shape-1" },
    ];
    expect(numbers(markersForSelection(markers, selection))).toEqual([1, 2, 3, 6]);
  });

  it("ignores selection kinds that cannot carry markers", () => {
    const selection: SelectionItem[] = [
      { type: "track", id: "track-1" },
      { type: "marker", id: "ruler-marker-1" },
    ];
    expect(markersForSelection(markers, selection)).toEqual([]);
  });

  it("de-duplicates markers shared by multiple selected items", () => {
    const selection: SelectionItem[] = [
      { type: "clip", id: "clip-1" },
      { type: "clip", id: "clip-1" },
    ];
    expect(numbers(markersForSelection(markers, selection))).toEqual([2]);
  });

  it("keeps the label for display", () => {
    const selection: SelectionItem[] = [{ type: "clip", id: "clip-2" }];
    const result = markersForSelection(markers, selection);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Fix color");
  });
});
