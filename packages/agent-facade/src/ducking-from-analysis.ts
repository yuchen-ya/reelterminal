/**
 * AUD-02: analysis-handle-driven ducking.
 *
 * `clip.setDuckingFromAnalysis` consumes a durable speechActivity analysis
 * record (AUD-01), maps its source-second speech regions through the SPEECH
 * clip's placement/trim/constant speed onto the timeline, intersects them
 * with the ducked clip, and rewrites the op into a plain `clip.setDucking`
 * presenceRanges op BEFORE any mutation starts. The downstream path is the
 * existing one: shared keyframe kernel, `audio/setDucking` core action, one
 * edit.apply batch/undo unit, and the single volume-automation evaluation
 * chain realtime preview and export already share.
 *
 * Honesty gates, all enforced here rather than after partial application:
 * stale records (source changed/missing) are rejected; the record must
 * contain speechActivity facts and must analyze the speech clip's own media;
 * speech clips with reverse playback, speed curves or freeze frames are
 * rejected because their source↔timeline mapping is not linear; and an
 * existing volume envelope on the target is never silently overwritten —
 * `existingEnvelope: "replace"` must authorize it.
 */
import { resolveAudibleAudioTarget } from "@reelterminal/core/audio/clip-audio-resolution";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip } from "@reelterminal/core/types/timeline";

import { loadAnalysisRecord } from "./analysis-records";
import { FacadeError } from "./errors";
import type { ClipSetDuckingFromAnalysisOp, EditOp } from "./types";

/** Degenerate overlaps below this many seconds are dropped, never clamped to zero-length. */
const MIN_PRESENCE_SEC = 1e-6;

/**
 * Pure source→timeline→target mapping. Forward, constant-speed, trimmed
 * speech clips only; every other modifier is an explicit, named rejection.
 * Returns target-clip-relative presence windows (seconds).
 */
export function mapSpeechRegionsToPresenceRanges(
  speechClip: Clip,
  targetClip: Clip,
  regions: readonly { readonly startSec: number; readonly endSec: number }[],
): Array<{ start: number; end: number }> {
  if (speechClip.reversed === true) {
    throw new FacadeError("UNSUPPORTED", `clip.setDuckingFromAnalysis: speech clip "${speechClip.id}" is reversed — reverse source-time mapping is not supported in the first version; render a forward copy or supply explicit presenceRanges to clip.setDucking`);
  }
  if (speechClip.speedKeyframes && speechClip.speedKeyframes.length > 0) {
    throw new FacadeError("UNSUPPORTED", `clip.setDuckingFromAnalysis: speech clip "${speechClip.id}" has a speed curve (${speechClip.speedKeyframes.length} speedKeyframes) — non-linear source-time mapping is not supported in the first version`);
  }
  if (speechClip.freezeFrames && speechClip.freezeFrames.length > 0) {
    throw new FacadeError("UNSUPPORTED", `clip.setDuckingFromAnalysis: speech clip "${speechClip.id}" has ${speechClip.freezeFrames.length} freeze frames — held segments have no linear source-time mapping in the first version`);
  }
  const speed = speechClip.speed ?? 1;
  if (!(Number.isFinite(speed) && speed > 0)) {
    throw new FacadeError("UNSUPPORTED", `clip.setDuckingFromAnalysis: speech clip "${speechClip.id}" has a non-positive speed (${String(speechClip)})`);
  }
  const speechTimelineStart = speechClip.startTime;
  const speechTimelineEnd = speechClip.startTime + speechClip.duration;
  const targetTimelineStart = targetClip.startTime;
  const targetTimelineEnd = targetClip.startTime + targetClip.duration;
  const presence: Array<{ start: number; end: number }> = [];
  for (const region of regions) {
    // Source seconds → speech-clip timeline position: the clip anchors
    // source inPoint at startTime and plays forward at constant speed.
    const timelineStart = speechTimelineStart + (region.startSec - speechClip.inPoint) / speed;
    const timelineEnd = speechTimelineStart + (region.endSec - speechClip.inPoint) / speed;
    const overlapStart = Math.max(timelineStart, speechTimelineStart, targetTimelineStart);
    const overlapEnd = Math.min(timelineEnd, speechTimelineEnd, targetTimelineEnd);
    if (overlapEnd - overlapStart > MIN_PRESENCE_SEC) {
      presence.push({ start: overlapStart - targetTimelineStart, end: overlapEnd - targetTimelineStart });
    }
  }
  return presence;
}

/**
 * Rewrite every clip.setDuckingFromAnalysis op in the batch into a
 * clip.setDucking op with concrete presenceRanges. Runs before any mutation
 * begins (edit.apply and edit.validate both call it), so a rejected record,
 * mapping or envelope conflict fails the whole call with zero side effects.
 */
export async function enrichDuckingFromAnalysisOps(
  ops: readonly EditOp[],
  artifactRoot: string | undefined,
  getProject: () => Promise<Project | null>,
): Promise<readonly EditOp[]> {
  if (!ops.some((op) => op.op === "clip.setDuckingFromAnalysis")) return ops;
  if (!artifactRoot) {
    throw new FacadeError("UNSUPPORTED", "clip.setDuckingFromAnalysis requires artifactRoot to read the speechActivity analysis record");
  }
  const project = await getProject();
  if (!project) {
    throw new FacadeError("UNSUPPORTED", "clip.setDuckingFromAnalysis requires an open project");
  }
  const allClips = project.timeline.tracks.flatMap((track) => track.clips);
  const enriched: EditOp[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "clip.setDuckingFromAnalysis") {
      enriched.push(op);
      continue;
    }
    const duck = op as ClipSetDuckingFromAnalysisOp;
    const label = `edit.apply ops[${index}] clip.setDuckingFromAnalysis`;
    const record = await loadAnalysisRecord(artifactRoot, duck.recordId);
    if (record.stale.kind === "source-changed") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${duck.recordId}" is stale — the source file changed after the analysis; re-run media.analyze_start with analysisTypes ["speechActivity"] and use the new record id`, { recordId: duck.recordId, stale: record.stale });
    }
    if (record.stale.kind === "source-missing") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${duck.recordId}" is stale — its source file is missing; restore the source or re-analyze a readable one`, { recordId: duck.recordId });
    }
    const facts = record.observations.find((observation) => observation.source === "speechActivity")?.facts as
      | { speechRegions?: ReadonlyArray<{ startSec: number; endSec: number }> }
      | undefined;
    const regions = facts?.speechRegions;
    if (!Array.isArray(regions) || regions.length === 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: analysis record "${duck.recordId}" contains no speechActivity speechRegions — run media.analyze_start with analysisTypes ["speechActivity"] on the speech media first`, { recordId: duck.recordId });
    }
    const speechClip = allClips.find((clip) => clip.id === duck.speechClipId);
    if (!speechClip) {
      throw new FacadeError("NOT_FOUND", `${label}: speech clip "${duck.speechClipId}" not found`, { speechClipId: duck.speechClipId });
    }
    if (speechClip.mediaId !== record.subject.mediaId) {
      throw new FacadeError("INVALID_PARAMS", `${label}: speech clip "${speechClip.id}" plays media "${speechClip.mediaId}" but the record analyzed media "${record.subject.mediaId}" ("${record.subject.name}") — analyze the speech clip's own media and pass that record`, { speechClipId: speechClip.id, clipMediaId: speechClip.mediaId, recordMediaId: record.subject.mediaId });
    }
    const targetClip = allClips.find((clip) => clip.id === duck.clipId);
    if (!targetClip) {
      throw new FacadeError("NOT_FOUND", `${label}: clip "${duck.clipId}" not found`, { clipId: duck.clipId });
    }
    // clip.setDucking synthesizes and persists on the AUDIBLE target (linked
    // audio when the addressed clip is muted), so the envelope-conflict gate
    // and the presence mapping both use that same resolved clip.
    const audibleTarget = resolveAudibleAudioTarget(targetClip, project.timeline);
    const existingPoints = audibleTarget.automation?.volume?.length ?? 0;
    if (existingPoints > 0 && duck.existingEnvelope !== "replace") {
      throw new FacadeError("CONFLICT", `${label}: clip "${audibleTarget.id}" already has ${existingPoints} volume-automation points (a manual envelope or earlier ducking) — pass existingEnvelope:"replace" to overwrite them explicitly, or clear the envelope first`, { clipId: audibleTarget.id, existingPoints });
    }
    const presenceRanges = mapSpeechRegionsToPresenceRanges(speechClip, audibleTarget, regions);
    if (presenceRanges.length === 0) {
      throw new FacadeError("INVALID_PARAMS", `${label}: no speech regions from record "${duck.recordId}" overlap clip "${duck.clipId}" on the timeline — check the speech clip placement, the analyzed range, or duck a clip that plays under the speech`, { recordId: duck.recordId, clipId: duck.clipId, speechClipId: speechClip.id });
    }
    enriched.push({
      op: "clip.setDucking",
      clipId: duck.clipId,
      threshold: duck.threshold,
      reduction: duck.reduction,
      attack: duck.attack,
      release: duck.release,
      holdTime: duck.holdTime,
      presenceRanges,
    });
  }
  return enriched;
}
