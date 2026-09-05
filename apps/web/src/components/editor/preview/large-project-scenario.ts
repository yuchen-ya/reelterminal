import type { Clip, Track } from "@openreel/core";
import { calculateClipTransform } from "./canvas-transform";
import {
  createPreviewTrackIndex,
  getActiveIndexedClips,
} from "./track-index";

export interface LargePreviewScenario {
  readonly tracks: Track[];
  readonly clipCount: number;
  readonly serializedBytes: number;
}

export interface LargePreviewMeasurement {
  readonly clipCount: number;
  readonly indexBuildMs: number;
  readonly lookupP95Ms: number;
  readonly interactionP95Ms: number;
  readonly frameBudgetMisses: number;
  readonly serializedBytes: number;
}

const percentile = (samples: readonly number[], fraction: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};

export function createLargePreviewScenario(
  trackCount = 24,
  clipsPerTrack = 250,
): LargePreviewScenario {
  const tracks: Track[] = Array.from({ length: trackCount }, (_, trackIndex) => {
    const trackId = `perf-track-${trackIndex}`;
    const clips: Clip[] = Array.from({ length: clipsPerTrack }, (_, clipIndex) => ({
      id: `perf-clip-${trackIndex}-${clipIndex}`,
      mediaId: `perf-media-${clipIndex % 20}`,
      trackId,
      startTime: clipIndex * 2,
      duration: 1.75,
      inPoint: 0,
      outPoint: 1.75,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    }));
    return {
      id: trackId,
      type: trackIndex % 4 === 0 ? "audio" : "video",
      name: `Performance track ${trackIndex}`,
      clips,
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    };
  });
  return {
    tracks,
    clipCount: trackCount * clipsPerTrack,
    serializedBytes: new TextEncoder().encode(JSON.stringify(tracks)).byteLength,
  };
}

/**
 * Measures real CPU time for the preview's large-project lookup and drag math.
 * The budget count is sampled CPU tasks over 16.67ms, not browser frame drops.
 */
export function measureLargePreviewScenario(
  scenario: LargePreviewScenario,
  samples = 240,
): LargePreviewMeasurement {
  const buildStarted = performance.now();
  const index = createPreviewTrackIndex(scenario.tracks);
  const indexBuildMs = performance.now() - buildStarted;
  const lookupSamples: number[] = [];
  const interactionSamples: number[] = [];
  let frameBudgetMisses = 0;

  for (let sample = 0; sample < samples; sample += 1) {
    const lookupStarted = performance.now();
    const track = sample % scenario.tracks.length;
    const clip = sample % Math.max(1, scenario.tracks[track]?.clips.length ?? 1);
    index.clipsById.get(`perf-clip-${track}-${clip}`);
    getActiveIndexedClips(scenario.tracks, (sample % 200) * 2 + 0.5);
    const lookupElapsed = performance.now() - lookupStarted;
    lookupSamples.push(lookupElapsed);

    const interactionStarted = performance.now();
    calculateClipTransform({
      mode: sample % 3 === 0 ? "resize" : "move",
      handle: sample % 3 === 0 ? "se" : null,
      start: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
      deltaX: sample % 80,
      deltaY: sample % 45,
      displayScale: 0.5,
      boundsWidth: 640,
      boundsHeight: 360,
      canvasWidth: 1920,
      canvasHeight: 1080,
      lockAspectRatio: true,
      snappingEnabled: true,
    });
    const interactionElapsed = performance.now() - interactionStarted;
    interactionSamples.push(interactionElapsed);
    if (lookupElapsed + interactionElapsed > 16.67) frameBudgetMisses += 1;
  }

  return {
    clipCount: scenario.clipCount,
    indexBuildMs,
    lookupP95Ms: percentile(lookupSamples, 0.95),
    interactionP95Ms: percentile(interactionSamples, 0.95),
    frameBudgetMisses,
    serializedBytes: scenario.serializedBytes,
  };
}
