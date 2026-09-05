import { describe, expect, it } from "vitest";
import {
  createLargePreviewScenario,
  measureLargePreviewScenario,
} from "./large-project-scenario";
import {
  createPreviewTrackIndex,
  getActiveIndexedClips,
} from "./track-index";

describe("large preview performance scenario", () => {
  it("measures the 6,000-clip lookup and interaction hot paths", () => {
    const scenario = createLargePreviewScenario();
    const measurement = measureLargePreviewScenario(scenario);
    console.info("LARGE_PREVIEW_MEASUREMENT", JSON.stringify(measurement));

    expect(measurement.clipCount).toBe(6_000);
    expect(measurement.serializedBytes).toBeGreaterThan(1_000_000);
    expect(measurement.indexBuildMs).toBeGreaterThanOrEqual(0);
    expect(measurement.lookupP95Ms).toBeGreaterThanOrEqual(0);
    expect(measurement.interactionP95Ms).toBeGreaterThanOrEqual(0);
    expect(measurement.frameBudgetMisses).toBeGreaterThanOrEqual(0);
  });

  it("keeps indexed lookup equivalent to the authoritative track snapshot", () => {
    const scenario = createLargePreviewScenario(8, 40);
    const index = createPreviewTrackIndex(scenario.tracks);
    const target = scenario.tracks[6]!.clips[31]!;
    expect(index.clipsById.size).toBe(scenario.clipCount);
    expect(index.clipsById.get(target.id)).toBe(target);

    const active = getActiveIndexedClips(scenario.tracks, 20.5);
    expect(active).toHaveLength(8);
    expect(active.every((clip) => clip.startTime === 20)).toBe(true);
  });

  it("rebuilds from immutable edit and undo snapshots without stale clips", () => {
    const scenario = createLargePreviewScenario(3, 12);
    const original = scenario.tracks;
    const edited = original.map((track, trackIndex) =>
      trackIndex !== 1
        ? track
        : {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === 5
                ? {
                    ...clip,
                    transform: {
                      ...clip.transform,
                      position: { x: 320, y: -180 },
                    },
                  }
                : clip,
            ),
          },
    );

    const originalIndex = createPreviewTrackIndex(original);
    const editedIndex = createPreviewTrackIndex(edited);
    const undoIndex = createPreviewTrackIndex(original);
    expect(originalIndex.clipsById.get("perf-clip-1-5")?.transform.position).toEqual({
      x: 0,
      y: 0,
    });
    expect(editedIndex.clipsById.get("perf-clip-1-5")?.transform.position).toEqual({
      x: 320,
      y: -180,
    });
    expect(undoIndex.clipsById.get("perf-clip-1-5")).toBe(
      original[1]!.clips[5],
    );
  });
});
