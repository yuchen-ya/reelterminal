/**
 * AUD-06: beat-snapped cut points from an existing beatGrid analysis record.
 *
 * `clip.splitAtBeat` takes a desired cut point in timeline seconds plus an
 * explicit allowed movement (`maxShiftSec`), snaps the point to the NEAREST
 * beat of a durable beatGrid record mapped through the clip's placement/
 * trim/speed/reverse timing, and rewrites the op into a plain `clip.split`
 * BEFORE any mutation starts. No new detector is introduced: the record's
 * beats are the same shared core BeatDetectionEngine output the GUI
 * beat-sync panel uses. A request with no beat inside the allowed movement
 * is rejected — the op never silently cuts at the unsnapped time.
 *
 * Downbeat honesty (AUD-06): beatGrid beats are grid-model beats, not
 * downbeats — no downbeat detector is installed, and the core engine's
 * internal every-4th-beat heuristic is a periodicity assumption that is
 * deliberately NOT reported (see capabilities.get mediaAnalysis.beatGrid).
 * The record's BPM may also be half/double the true tempo; verify the grid
 * against the material before cutting.
 */
import type { Project } from "@reelterminal/core/types/project";
import type { Clip } from "@reelterminal/core/types/timeline";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";

import { loadAnalysisRecord } from "./analysis-records";
import { FacadeError } from "./errors";
import type { ClipSplitAtBeatOp, EditOp } from "./types";

const CLAMP_EPS = 1e-9;

export interface BeatSnapCandidate {
  readonly snappedTimeSec: number;
  /** Timeline distance between the requested point and the chosen beat. */
  readonly shiftSec: number;
  /** The chosen beat's stored index (disclosed, not used for scoring). */
  readonly beatIndex: number;
}

/**
 * Pure snap: map the record's source-second beats through ONE clip's
 * placement/trim/speed/reverse timing onto the timeline and return the
 * nearest beat within `maxShiftSec` of the requested cut point. Ties go to
 * the earlier beat. Returns null when no beat is inside the allowed
 * movement — callers must reject, never fall back to the unsnapped time.
 */
export function findSnappedSplitTime(
  clip: Clip,
  beats: readonly { readonly timeSec: number; readonly index?: number }[],
  requestedTimeSec: number,
  maxShiftSec: number,
): BeatSnapCandidate | null {
  const speed = clip.speed ?? 1;
  if (!(Number.isFinite(speed) && speed > 0)) return null;
  const engine = new SpeedEngine();
  engine.loadClips([clip]);
  const sourceSpan = Math.max(0, clip.outPoint - clip.inPoint);
  let best: BeatSnapCandidate | null = null;
  for (const beat of beats) {
    const source = Math.max(0, Math.min(sourceSpan, beat.timeSec - clip.inPoint));
    const playback = engine.getPlaybackTimeAtSourceTime(clip.id, source);
    if (playback === null || playback === undefined || !Number.isFinite(playback)) continue;
    const timeline = clip.startTime + playback;
    const shift = Math.abs(timeline - requestedTimeSec);
    if (shift > maxShiftSec + CLAMP_EPS) continue;
    if (best === null || shift < best.shiftSec - CLAMP_EPS) {
      best = { snappedTimeSec: timeline, shiftSec: shift, beatIndex: beat.index ?? -1 };
    }
  }
  return best;
}

/**
 * Rewrite every clip.splitAtBeat op in the batch into a clip.split op at
 * the snapped time. All record, mapping and bounds gates run here — before
 * any mutation starts — so a rejected op leaves the batch untouched.
 */
export interface EnrichSplitAtBeatOptions {
  /** Original batch index, so single-op calls keep the batch-wide label. */
  readonly opIndexBase?: number;
  /** Verb name used in error labels (defaults to edit.apply). */
  readonly verb?: "edit.apply" | "edit.validate";
}

export async function enrichSplitAtBeatOps(
  ops: readonly EditOp[],
  artifactRoot: string | undefined,
  getProject: () => Promise<Project | null>,
  options: EnrichSplitAtBeatOptions = {},
): Promise<readonly EditOp[]> {
  if (!ops.some((op) => op.op === "clip.splitAtBeat")) return ops;
  if (!artifactRoot) {
    throw new FacadeError("UNSUPPORTED", "clip.splitAtBeat requires artifactRoot to read the beatGrid analysis record");
  }
  const project = await getProject();
  if (!project) {
    throw new FacadeError("UNSUPPORTED", "clip.splitAtBeat requires an open project");
  }
  const opIndexBase = options.opIndexBase ?? 0;
  const verb = options.verb ?? "edit.apply";
  const allClips = project.timeline.tracks.flatMap((track) => track.clips);
  const enriched: EditOp[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "clip.splitAtBeat") {
      enriched.push(op);
      continue;
    }
    const split = op as ClipSplitAtBeatOp;
    const label = `${verb} ops[${opIndexBase + index}] clip.splitAtBeat`;
    const record = await loadAnalysisRecord(artifactRoot, split.recordId);
    if (record.stale.kind === "source-changed") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${split.recordId}" is stale — the source file changed after the analysis; re-run media.analyze_start with analysisTypes ["beatGrid"] and use the new record id`, { recordId: split.recordId, stale: record.stale });
    }
    if (record.stale.kind === "source-missing") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${split.recordId}" is stale — its source file is missing; restore the source or re-analyze a readable one`, { recordId: split.recordId });
    }
    const facts = record.observations.find((observation) => observation.source === "beatGrid")?.facts as
      | { beats?: ReadonlyArray<{ timeSec: number; index?: number }> }
      | undefined;
    const beats = facts?.beats;
    if (!Array.isArray(beats) || beats.length === 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: analysis record "${split.recordId}" contains no beatGrid beats — run media.analyze_start with analysisTypes ["beatGrid"] on the clip's own media first`, { recordId: split.recordId });
    }
    const clip = allClips.find((candidate) => candidate.id === split.clipId);
    if (!clip) {
      throw new FacadeError("NOT_FOUND", `${label}: clip "${split.clipId}" not found`, { clipId: split.clipId });
    }
    if (clip.mediaId !== record.subject.mediaId) {
      throw new FacadeError("INVALID_PARAMS", `${label}: clip "${clip.id}" plays media "${clip.mediaId}" but the record analyzed media "${record.subject.mediaId}" ("${record.subject.name}") — analyze the clip's own media and pass that record`, { clipId: clip.id, clipMediaId: clip.mediaId, recordMediaId: record.subject.mediaId });
    }
    // beatGrid decodes the first audio stream (0:a:0) as a mono mix.
    const audioTrack = clip.audioTrackIndex ?? 0;
    if (audioTrack !== 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: clip "${clip.id}" plays audioTrackIndex ${audioTrack}, but beatGrid analyzed audio stream 0 — use a clip on track 0`, { clipId: clip.id, audioTrackIndex: audioTrack, analyzedAudioStream: 0 });
    }
    if ((clip.speedKeyframes?.length ?? 0) > 0 || (clip.freezeFrames?.length ?? 0) > 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: clip "${clip.id}" uses speed curves or freeze frames — the core split action rejects those timings; flatten the speed configuration first`, { clipId: clip.id });
    }
    const speed = clip.speed ?? 1;
    if (!(Number.isFinite(speed) && speed > 0)) {
      throw new FacadeError("UNSUPPORTED", `${label}: clip "${clip.id}" has a non-positive speed (${String(speed)})`, { clipId: clip.id, speed });
    }
    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clip.duration;
    if (!(split.time > clipStart && split.time < clipEnd)) {
      throw new FacadeError("INVALID_PARAMS", `${label}: requested cut point ${split.time} must be strictly inside the clip bounds [${clipStart}, ${clipEnd})`, { clipId: clip.id, time: split.time, startTime: clipStart, endTime: clipEnd });
    }
    const snap = findSnappedSplitTime(clip, beats, split.time, split.maxShiftSec);
    if (!snap) {
      throw new FacadeError("INVALID_PARAMS", `${label}: no beatGrid beat from record "${split.recordId}" lies within maxShiftSec ${split.maxShiftSec} of the requested cut point ${split.time} — widen maxShiftSec, or cut manually with clip.split; remember the record's BPM can be half/double the true tempo`, { recordId: split.recordId, clipId: clip.id, time: split.time, maxShiftSec: split.maxShiftSec });
    }
    if (!(snap.snappedTimeSec > clipStart && snap.snappedTimeSec < clipEnd)) {
      throw new FacadeError("INVALID_PARAMS", `${label}: the nearest beat snaps to ${snap.snappedTimeSec}, outside the clip bounds [${clipStart}, ${clipEnd}) — pick a cut point further from the clip edges`, { clipId: clip.id, snappedTimeSec: snap.snappedTimeSec, startTime: clipStart, endTime: clipEnd });
    }
    enriched.push({
      op: "clip.split",
      clipId: split.clipId,
      time: snap.snappedTimeSec,
    });
  }
  return enriched;
}
