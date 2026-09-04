import { describe, expect, it, beforeEach } from "vitest";

import {
  getTransitionBridge,
  disposeTransitionBridge,
  initializeTransitionBridge,
  syncTransitionBridgeFromProject,
} from "../../../bridges/transition-bridge";
import { getTransitionAtTime } from "./canvas-renderers";
import type { Transition } from "@openreel/core";

const facadeTransition = {
  id: "transition-facade-1",
  clipAId: "a",
  clipBId: "b",
  edge: null,
  type: "crossfade",
  duration: 0.8,
  params: {},
} as unknown as Transition;

const makeTracks = (transitions?: Transition[]) => [
  {
    id: "v1",
    type: "video",
    transitions,
    clips: [
      { id: "a", startTime: 0, duration: 4, mediaId: "m1", inPoint: 0 },
      { id: "b", startTime: 4, duration: 3, mediaId: "m2", inPoint: 0 },
    ],
  },
];

/**
 * Regression: transitions authored through the Agent facade arrive with
 * `edge: null`. Worse, the TransitionBridge side map stayed empty whenever
 * the project loaded before the bridge initialized (or after a dispose /
 * re-init remount), so the preview rendered hard cuts while the exported
 * file had crossfades. Detection must read project data first.
 */
describe("getTransitionAtTime (facade-shaped transitions)", () => {
  beforeEach(() => {
    disposeTransitionBridge();
    initializeTransitionBridge(320, 180);
  });

  it("finds the transition from track data even when the bridge map is empty", () => {
    expect(getTransitionBridge().getTransitionsForTrack("v1")).toHaveLength(0);
    const info = getTransitionAtTime(3.9, makeTracks([facadeTransition]));
    expect(info).not.toBeNull();
    expect(info!.transitionId).toBe("transition-facade-1");
    expect(info!.transition).toBe(facadeTransition);
    expect(info!.progress).toBeCloseTo(0.375, 5);
    expect(info!.clipA.id).toBe("a");
    expect(info!.clipB?.id).toBe("b");
  });

  it("still finds transitions via the bridge map when track data has none", () => {
    getTransitionBridge().setTransitionsForTrack("v1", [facadeTransition]);
    const info = getTransitionAtTime(3.9, makeTracks());
    expect(info).not.toBeNull();
    expect(info!.transitionId).toBe("transition-facade-1");
    expect(info!.progress).toBeCloseTo(0.375, 5);
  });

  it("returns null outside the window", () => {
    const tracks = makeTracks([facadeTransition]);
    expect(getTransitionAtTime(3.5, tracks)).toBeNull();
    expect(getTransitionAtTime(4.5, tracks)).toBeNull();
  });

  it("treats an empty track transition list as authoritative", () => {
    getTransitionBridge().setTransitionsForTrack("v1", [facadeTransition]);
    expect(getTransitionAtTime(3.9, makeTracks([]))).toBeNull();
  });
});

describe("syncTransitionBridgeFromProject", () => {
  beforeEach(() => {
    disposeTransitionBridge();
  });

  it("populates the bridge map after init (load-before-init race)", () => {
    initializeTransitionBridge(320, 180);
    syncTransitionBridgeFromProject({
      timeline: {
        tracks: [{ id: "v1", transitions: [facadeTransition] }],
      },
    });
    expect(getTransitionBridge().getTransitionsForTrack("v1")).toHaveLength(1);
    expect(getTransitionAtTime(3.9, makeTracks())).not.toBeNull();
  });

  it("is a no-op when the bridge is not initialized", () => {
    expect(() =>
      syncTransitionBridgeFromProject({
        timeline: {
          tracks: [{ id: "v1", transitions: [facadeTransition] }],
        },
      }),
    ).not.toThrow();
    expect(getTransitionBridge().getTransitionsForTrack("v1")).toHaveLength(0);
  });
});
