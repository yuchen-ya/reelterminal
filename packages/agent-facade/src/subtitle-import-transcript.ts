/**
 * AUD-07: record-driven subtitle import.
 *
 * `subtitle.importTranscript` consumes a durable speechTranscript record and
 * maps its VAD-segment text through the named clip's placement/trim/speed
 * curve/reverse/freeze timing onto the timeline. The op is planned BEFORE any
 * mutation and then expanded by ops.ts into the same core `subtitle/setAll`
 * action as subtitle.importSrt, so it reuses the existing subtitle model,
 * one-batch undo semantics and caption rendering.
 *
 * Gates (all before mutation): artifactRoot and record presence, staleness,
 * transcript facts, clip existence, clip media == analyzed media, analyzed
 * audio stream (0:a:0), a bounded cue count and at least one non-empty mapped
 * cue. Reverse/speed/freeze timing uses the shared core SpeedEngine.
 */
import { randomUUID } from "node:crypto";

import { DEFAULT_SUBTITLE_STYLE } from "@reelterminal/core/text/subtitle-engine";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip } from "@reelterminal/core/types/timeline";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";

import { loadAnalysisRecord } from "./analysis-records";
import { FacadeError } from "./errors";
import type { SubtitleImportTranscriptOp } from "./types";

const SOURCE_EPSILON = 1e-9;
const MIN_CUE_SEC = 0.04;
const DEFAULT_MAX_CUES = 500;

export interface TranscriptSubtitleCue {
  readonly id: string;
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly style: typeof DEFAULT_SUBTITLE_STYLE;
}

/** The internal prepared shape after enrichment; never part of the public op. */
export type PreparedSubtitleImportTranscriptOp = SubtitleImportTranscriptOp & {
  readonly cues?: readonly TranscriptSubtitleCue[];
};

interface TranscriptSegmentFacts {
  readonly startSec: number;
  readonly endSec: number;
  readonly text: string;
}

function fail(code: "INVALID_PARAMS" | "NOT_FOUND" | "CONFLICT" | "UNSUPPORTED", message: string, details?: Record<string, unknown>): never {
  throw new FacadeError(code, `subtitle.importTranscript: ${message}`, details);
}

/**
 * Pure source→timeline mapping for one clip. Segments outside the clip's
 * trimmed source span are skipped; frozen holds whose source frame belongs to
 * the segment extend the cue over the hold. Forward/reverse constant speed,
 * speed curves and freeze frames all delegate to the shared SpeedEngine.
 */
export function mapTranscriptSegmentsToCues(
  clip: Clip,
  segments: readonly TranscriptSegmentFacts[],
): TranscriptSubtitleCue[] {
  const engine = new SpeedEngine();
  engine.loadClips([clip]);
  const sourceSpan = Math.max(0, clip.outPoint - clip.inPoint);
  const cues: TranscriptSubtitleCue[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    const sourceStart = Math.max(0, Math.min(sourceSpan, segment.startSec - clip.inPoint));
    const sourceEnd = Math.max(0, Math.min(sourceSpan, segment.endSec - clip.inPoint));
    if (!(sourceEnd > sourceStart + SOURCE_EPSILON)) continue;
    const playbackA = engine.getPlaybackTimeAtSourceTime(clip.id, sourceStart);
    const playbackB = engine.getPlaybackTimeAtSourceTime(clip.id, sourceEnd);
    let startTime = clip.startTime + Math.min(playbackA, playbackB);
    let endTime = clip.startTime + Math.max(playbackA, playbackB);
    // A freeze holds its source frame across a playback interval; include the
    // held span so the caption does not disappear during the hold.
    for (const freeze of clip.freezeFrames ?? []) {
      if (freeze.sourceTime < sourceStart - SOURCE_EPSILON || freeze.sourceTime > sourceEnd + SOURCE_EPSILON) continue;
      startTime = Math.min(startTime, clip.startTime + freeze.startTime);
      endTime = Math.max(endTime, clip.startTime + freeze.startTime + freeze.duration);
    }
    if (endTime - startTime < MIN_CUE_SEC) continue;
    cues.push({
      id: `subtitle-${randomUUID()}`,
      text,
      startTime: Number(startTime.toFixed(6)),
      endTime: Number(endTime.toFixed(6)),
      style: { ...DEFAULT_SUBTITLE_STYLE },
    });
  }
  return cues.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
}

export interface EnrichSubtitleImportTranscriptOptions {
  /** Original batch index, so single-op calls keep the batch-wide label. */
  readonly opIndexBase?: number;
  readonly verb?: "edit.apply" | "edit.validate";
}

/**
 * Rewrite every subtitle.importTranscript op into the same op carrying the
 * concrete mapped cues. Runs against the sequential draft so earlier ops in
 * the same batch are visible.
 */
export async function enrichSubtitleImportTranscriptOps(
  ops: readonly import("./types").EditOp[],
  artifactRoot: string | undefined,
  getProject: () => Promise<Project | null>,
  options: EnrichSubtitleImportTranscriptOptions = {},
): Promise<readonly import("./types").EditOp[]> {
  if (!ops.some((op) => op.op === "subtitle.importTranscript")) return ops;
  if (!artifactRoot) fail("UNSUPPORTED", "requires artifactRoot to read the speechTranscript analysis record");
  const project = await getProject();
  if (!project) fail("UNSUPPORTED", "requires a project");
  return Promise.all(ops.map(async (op) => {
    if (op.op !== "subtitle.importTranscript") return op;
    const label = options.verb === "edit.validate" && options.opIndexBase !== undefined
      ? `edit.validate ops[${options.opIndexBase}]`
      : `edit.${options.verb === "edit.validate" ? "validate" : "apply"}`;
    const record = await loadAnalysisRecord(artifactRoot, op.recordId).catch((error) => {
      if (error instanceof FacadeError) throw error;
      fail("NOT_FOUND", `${label}: analysis record "${op.recordId}" could not be read`, { recordId: op.recordId });
    });
    if (record.stale.kind !== "current") {
      fail("CONFLICT", `${label}: analysis record "${op.recordId}" is stale — the source file changed after transcription; re-run media.analyze_start with analysisTypes ["speechTranscript"] and use the new record id`, { recordId: op.recordId, stale: record.stale });
    }
    const facts = record.observations.find((observation) => observation.source === "speechTranscript")?.facts as
      { segments?: unknown; segmentCount?: unknown } | undefined;
    if (!facts || !Array.isArray(facts.segments)) {
      fail("UNSUPPORTED", `${label}: analysis record "${op.recordId}" contains no speechTranscript segments — run media.analyze_start with analysisTypes ["speechTranscript"] on the clip's own media first`, { recordId: op.recordId });
    }
    const clip = project.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === op.clipId);
    if (!clip) fail("NOT_FOUND", `${label}: clip "${op.clipId}" not found`, { clipId: op.clipId });
    const subject = record.subject as { mediaId?: unknown };
    if (subject.mediaId !== clip.mediaId) {
      fail("INVALID_PARAMS", `${label}: transcript record analyzed media "${String(subject.mediaId)}", but clip "${clip.id}" plays media "${clip.mediaId}"`, { recordId: op.recordId, clipId: clip.id });
    }
    if ((clip.audioTrackIndex ?? 0) !== 0) {
      fail("UNSUPPORTED", `${label}: clip "${clip.id}" plays audio track ${clip.audioTrackIndex}, but speechTranscript analyzed audio stream 0`, { clipId: clip.id, audioTrackIndex: clip.audioTrackIndex });
    }
    const maxCues = op.maxCues ?? DEFAULT_MAX_CUES;
    if (!Number.isInteger(maxCues) || maxCues < 1 || maxCues > DEFAULT_MAX_CUES) {
      fail("INVALID_PARAMS", `${label}: maxCues must be an integer in [1, ${DEFAULT_MAX_CUES}]`);
    }
    const segments = facts.segments as TranscriptSegmentFacts[];
    let cues = mapTranscriptSegmentsToCues(clip, segments);
    if (cues.length === 0) fail("INVALID_PARAMS", `${label}: no non-empty transcript segment overlaps clip "${clip.id}" (source ${clip.inPoint.toFixed(3)}–${clip.outPoint.toFixed(3)}s)`, { clipId: clip.id });
    if (cues.length > maxCues) {
      fail("UNSUPPORTED", `${label}: ${cues.length} cues exceed maxCues ${maxCues}; split the transcript or raise maxCues (up to ${DEFAULT_MAX_CUES})`, { cueCount: cues.length, maxCues });
    }
    return { ...op, cues } as PreparedSubtitleImportTranscriptOp;
  }));
}
