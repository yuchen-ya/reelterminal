import type { Clip, SpeedKeyframe } from "@reelterminal/core/types/timeline";
import { SPEED_MIN, SPEED_MAX, SpeedEngine } from "@reelterminal/core/video/speed-engine";
import type { TimelineRetimeByAnchorsOp } from "./types";

export function retimeSegmentSpeed(sourceSpan: number, timelineSpan: number): number {
  const speed = sourceSpan / timelineSpan;
  // Match the anchor validator's boundary tolerance, on either side of a
  // limit, so harmless roundoff cannot create a vanishingly short ramp.
  if (speed <= SPEED_MIN + 1e-9) return SPEED_MIN;
  if (speed >= SPEED_MAX - 1e-9) return SPEED_MAX;
  return speed;
}

/** Build source-relative curves whose playback integral meets every anchor. */
export function retimeSpeedKeyframes(
  anchors: TimelineRetimeByAnchorsOp["anchors"],
  easing: TimelineRetimeByAnchorsOp["easing"],
): SpeedKeyframe[] {
  // Validation already rejects out-of-range segments. Clamp the accepted
  // boundary roundoff before sending the speeds to Core's strict validator.
  const speeds = anchors.slice(1).map((anchor, i) => retimeSegmentSpeed(
    anchor.sourceSec - anchors[i]!.sourceSec,
    anchor.timelineSec - anchors[i]!.timelineSec,
  ));
  const firstSource = anchors[0]!.sourceSec;
  const keyframes: SpeedKeyframe[] = [];
  const append = (time: number, speed: number, curve: SpeedKeyframe["easing"]) => {
    keyframes.push({
      id: `speed-kf-retime-${keyframes.length + 1}`,
      time,
      speed,
      easing: curve,
    });
  };
  const atLimit = (speed: number) => speed === SPEED_MIN || speed === SPEED_MAX;
  const boundarySpeeds = [speeds[0]!, ...speeds.slice(1).map((right, i) => {
    const left = speeds[i]!;
    return atLimit(left) ? left : atLimit(right) ? right : (left + right) / 2;
  }), speeds.at(-1)!];

  const engine = new SpeedEngine();
  for (let i = 0; i < speeds.length; i++) {
    const from = anchors[i]!;
    const to = anchors[i + 1]!;
    const speed = speeds[i]!;
    const start = from.sourceSec - firstSource;
    const span = to.sourceSec - from.sourceSec;
    const targetDuration = to.timelineSec - from.timelineSec;
    const left = boundarySpeeds[i]!;
    const right = boundarySpeeds[i + 1]!;
    if (
      easing === undefined || easing === "step" || atLimit(speed) ||
      (left === speed && right === speed)
    ) {
      // An interval at a speed limit must be constant: any ramp would miss
      // its duration. Adjacent opposite limits therefore require a step.
      append(start, speed, "hold");
      continue;
    }

    // Ease into/out of a constant plateau. Shared endpoint speeds keep adjacent
    // intervals continuous; solving the plateau preserves the interior anchors.
    // Bound the ramp span so even plateaus at MIN/MAX bracket the target time.
    const inverseEdges = 1 / left + 1 / right;
    const rampSpan = Math.min(
      span / 4,
      (span / SPEED_MIN - targetDuration) / (2 * (2 / SPEED_MIN - inverseEdges)),
      (targetDuration - span / SPEED_MAX) / (2 * (inverseEdges - 2 / SPEED_MAX)),
    );
    const localFrames = (plateau: number): SpeedKeyframe[] => [
      { id: "start", time: 0, speed: left, easing },
      { id: "rise", time: rampSpan, speed: plateau, easing },
      { id: "fall", time: span - rampSpan, speed: plateau, easing },
      { id: "end", time: span, speed: right, easing },
    ];
    const measurementClip: Clip = {
      id: "retime-segment",
      mediaId: "",
      trackId: "",
      startTime: 0,
      inPoint: 0,
      outPoint: span,
      duration: targetDuration,
      effects: [],
      audioEffects: [],
      volume: 1,
      keyframes: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      },
    };
    let low = SPEED_MIN;
    let high = SPEED_MAX;
    for (let iteration = 0; iteration < 48; iteration++) {
      const plateau = (low + high) / 2;
      engine.loadClips([{ ...measurementClip, speedKeyframes: localFrames(plateau) }]);
      if (engine.getEffectiveDuration(measurementClip.id) > targetDuration) {
        low = plateau;
      } else {
        high = plateau;
      }
    }
    const plateau = (low + high) / 2;
    append(start, left, easing);
    append(start + rampSpan, plateau, easing);
    append(start + span - rampSpan, plateau, easing);
  }
  append(anchors.at(-1)!.sourceSec - firstSource, speeds.at(-1)!, "hold");
  return keyframes;
}
