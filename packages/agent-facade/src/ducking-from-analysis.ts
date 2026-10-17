/**
 * AUD-02: analysis-handle-driven ducking.
 *
 * `clip.setDuckingFromAnalysis` consumes a durable speechActivity analysis
 * record (AUD-01), maps its source-second speech regions through the SPEECH
 * clip's placement/trim/speed curve/reverse/freeze timing onto the timeline,
 * intersects them with the ducked clip, and rewrites the op into a plain
 * `clip.setDucking` presenceRanges op BEFORE any mutation starts. The
 * downstream path is the existing one: shared keyframe kernel,
 * `audio/setDucking` core action, one edit.apply batch/undo unit, and the
 * single volume-automation evaluation chain realtime preview and export
 * already share.
 *
 * Honesty gates, all enforced here rather than after partial application:
 * stale records (source changed/missing) are rejected; the record must
 * contain speechActivity facts and must analyze the speech clip's own media;
 * a clip selecting another audio stream than the analyzed 0:a:0 is rejected;
 * and an existing volume envelope on the target is never silently overwritten
 * — `existingEnvelope: "replace"` must authorize it.
 */
import { resolveAudibleAudioTarget } from "@reelterminal/core/audio/clip-audio-resolution";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip } from "@reelterminal/core/types/timeline";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";

import { loadAnalysisRecord } from "./analysis-records";
import { FacadeError } from "./errors";
import type { ClipSetDuckingFromAnalysisOp, EditOp } from "./types";

/** Degenerate overlaps below this many seconds are dropped, never clamped to zero-length. */
const MIN_PRESENCE_SEC = 1e-6;
const SOURCE_EPSILON = 1e-9;

function mergeTimelineRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0]! }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (range.start < last.end - SOURCE_EPSILON) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Pure source→timeline→target mapping. Uses the shared core SpeedEngine so
 * forward/reverse clips, speed curves and freeze-frame holds map exactly the
 * way preview/export play them. Freeze holds whose source moment falls inside
 * a speech region are included in the presence window. Returns target-clip-
 * relative presence windows (seconds), merged and sorted.
 */
export function mapSpeechRegionsToPresenceRanges(
  speechClip: Clip,
  targetClip: Clip,
  regions: readonly { readonly startSec: number; readonly endSec: number }[],
): Array<{ start: number; end: number }> {
  const speed = speechClip.speed ?? 1;
  if (!(Number.isFinite(speed) && speed > 0)) {
    throw new FacadeError("UNSUPPORTED", `clip.setDuckingFromAnalysis: speech clip "${speechClip.id}" has a non-positive speed (${String(speechClip)})`);
  }
  const engine = new SpeedEngine();
  engine.loadClips([speechClip]);
  const sourceSpan = Math.max(0, speechClip.outPoint - speechClip.inPoint);
  const speechTimelineStart = speechClip.startTime;
  const speechTimelineEnd = speechClip.startTime + speechClip.duration;
  const targetTimelineStart = targetClip.startTime;
  const targetTimelineEnd = targetClip.startTime + targetClip.duration;
  const presence: Array<{ start: number; end: number }> = [];
  for (const region of regions) {
    // Source seconds (relative to inPoint) → clip-local playback → timeline.
    const sourceStart = Math.max(0, Math.min(sourceSpan, region.startSec - speechClip.inPoint));
    const sourceEnd = Math.max(0, Math.min(sourceSpan, region.endSec - speechClip.inPoint));
    if (!(sourceEnd > sourceStart)) continue;
    const playbackA = engine.getPlaybackTimeAtSourceTime(speechClip.id, sourceStart);
    const playbackB = engine.getPlaybackTimeAtSourceTime(speechClip.id, sourceEnd);
    const pieces: Array<{ start: number; end: number }> = [{
      start: speechTimelineStart + Math.min(playbackA, playbackB),
      end: speechTimelineStart + Math.max(playbackA, playbackB),
    }];
    // A freeze holds its source frame over a playback interval; the inverse
    // mapping inserts the hold after its moving position, so add the held
    // interval whenever the held source moment is part of this region.
    for (const freeze of speechClip.freezeFrames ?? []) {
      if (freeze.sourceTime < sourceStart - SOURCE_EPSILON || freeze.sourceTime > sourceEnd + SOURCE_EPSILON) continue;
      pieces.push({
        start: speechTimelineStart + freeze.startTime,
        end: speechTimelineStart + freeze.startTime + freeze.duration,
      });
    }
    for (const piece of mergeTimelineRanges(pieces)) {
      const overlapStart = Math.max(piece.start, speechTimelineStart, targetTimelineStart);
      const overlapEnd = Math.min(piece.end, speechTimelineEnd, targetTimelineEnd);
      if (overlapEnd - overlapStart > MIN_PRESENCE_SEC) {
        presence.push({ start: overlapStart - targetTimelineStart, end: overlapEnd - targetTimelineStart });
      }
    }
  }
  return mergeTimelineRanges(presence);
}

/**
 * Rewrite every clip.setDuckingFromAnalysis op in the batch into a
 * clip.setDucking op with concrete presenceRanges.
 *
 * The caller supplies the project view that applies at the point this batch
 * is reached: edit.apply/edit.validate pass the sequential draft inside their
 * per-op loop, so earlier ops in the SAME batch (clip.add/move/trim) are
 * already reflected in the mapping. A rejected record, mapping or envelope
 * conflict still fails the whole call before anything is committed, because
 * both sessions only swap the canonical state after every op succeeds.
 */
export interface EnrichDuckingFromAnalysisOptions {
  /** Original batch index, so single-op calls keep the batch-wide label. */
  readonly opIndexBase?: number;
  /** Verb name used in error labels (defaults to edit.apply). */
  readonly verb?: "edit.apply" | "edit.validate";
}

export async function enrichDuckingFromAnalysisOps(
  ops: readonly EditOp[],
  artifactRoot: string | undefined,
  getProject: () => Promise<Project | null>,
  options: EnrichDuckingFromAnalysisOptions = {},
): Promise<readonly EditOp[]> {
  if (!ops.some((op) => op.op === "clip.setDuckingFromAnalysis")) return ops;
  if (!artifactRoot) {
    throw new FacadeError("UNSUPPORTED", "clip.setDuckingFromAnalysis requires artifactRoot to read the speechActivity analysis record");
  }
  const project = await getProject();
  if (!project) {
    throw new FacadeError("UNSUPPORTED", "clip.setDuckingFromAnalysis requires an open project");
  }
  const opIndexBase = options.opIndexBase ?? 0;
  const verb = options.verb ?? "edit.apply";
  const allClips = project.timeline.tracks.flatMap((track) => track.clips);
  const enriched: EditOp[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "clip.setDuckingFromAnalysis") {
      enriched.push(op);
      continue;
    }
    const duck = op as ClipSetDuckingFromAnalysisOp;
    const label = `${verb} ops[${opIndexBase + index}] clip.setDuckingFromAnalysis`;
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
    // speechActivity always decodes the first audio stream (0:a:0); a clip
    // selecting another track would duck from a different program.
    const speechAudioTrack = speechClip.audioTrackIndex ?? 0;
    if (speechAudioTrack !== 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: speech clip "${speechClip.id}" plays audioTrackIndex ${speechAudioTrack}, but speechActivity analyzed audio stream 0 — analyze/use a clip on track 0 or supply explicit presenceRanges to clip.setDucking`, { speechClipId: speechClip.id, audioTrackIndex: speechAudioTrack, analyzedAudioStream: 0 });
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
