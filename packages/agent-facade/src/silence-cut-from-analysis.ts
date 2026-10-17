/**
 * AUD-05: analysis-handle-driven silence cutting.
 *
 * `clip.cutSilenceFromAnalysis` consumes a durable silence analysis record,
 * maps its source-second silent regions through the clip's placement/trim/
 * speed/reverse timing onto the timeline, and plans the complete cut BEFORE
 * any mutation starts. The plan is attached to the op and expanded by the
 * ops.ts translator into the SAME core actions the GUI silence-cut panel
 * emits — `clip/split` + `clip/rippleDelete` (plus `audio/setFade` edge
 * protection) — so atomicity, per-track ripple semantics, idempotency and
 * one-step undo all ride the existing edit.apply machinery.
 *
 * Explicit scope decisions (AUD-05 wording):
 *  - kept pauses: regions shorter than `minSilenceSec` stay; the record's
 *    own analysis-time filtering is the default;
 *  - edge padding: `paddingSec` keeps extra audio on both edges of a cut;
 *  - linked tracks: timing-identical aligned A/V siblings of the same media
 *    are cut identically so picture and sound stay in sync; an aligned
 *    sibling with DIFFERENT timing is rejected rather than desynced;
 *  - ripple scope: `clip/rippleDelete` semantics — later clips on each
 *    affected track shift left, other tracks stay;
 *  - subtitles: the facade has no subtitle-shift action, so any project
 *    whose subtitle cues could desync (ending after the first cut) is
 *    rejected up front instead of silently broken;
 *  - unsupported mappings: speed curves and freeze frames are rejected
 *    because the core split/trim actions reject them; non-positive speed
 *    and non-zero audioTrackIndex are rejected like AUD-02.
 */
import type { Project } from "@reelterminal/core/types/project";
import type { Clip, Timeline } from "@reelterminal/core/types/timeline";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";

import { loadAnalysisRecord } from "./analysis-records";
import { FacadeError } from "./errors";
import type { ClipCutSilenceFromAnalysisOp, EditOp } from "./types";

/** Windows shorter than this are degenerate and never cut. */
const MIN_CUT_SEC = 1e-3;
const CLAMP_EPS = 1e-9;
/** Core clip/split requires strictly-inside times; window classification epsilon. */
export const EDGE_EPS = 1e-6;
/** Alignment tolerance reused from the core linked-clip resolver. */
const LINK_TOLERANCE = 0.01;
const TIMING_EPS = 1e-6;

export const DEFAULT_CUT_SILENCE_FADE_SEC = 0.01;
export const MAX_CUT_FADE_SEC = 0.05;
export const DEFAULT_MAX_CUT_REGIONS = 24;
export const MAX_CUT_REGIONS_LIMIT = 64;

/** A concrete cut window on the timeline (seconds, half-open [start, end)). */
export interface SilenceCutWindow {
  readonly startSec: number;
  readonly endSec: number;
}

/** One clip (primary or timing-identical sibling) and its cut windows. */
export interface SilenceCutPlanEntry {
  readonly clipId: string;
  readonly windows: readonly SilenceCutWindow[];
  /** The clip's fade at plan time; non-zero fades force edge normalization. */
  readonly baseFade: { readonly fadeIn: number; readonly fadeOut: number };
}

/**
 * The full precomputed plan the ops.ts translator expands. Attached to the
 * op as `cuts` by {@link enrichCutSilenceOps}; never part of the public op
 * schema (callers pass a recordId, not a plan).
 */
export interface SilenceCutPlan {
  readonly fadeSec: number;
  /** Emit audio/setFade on cut edges when fadeSec > 0 or a base fade exists. */
  readonly needsFades: boolean;
  readonly entries: readonly SilenceCutPlanEntry[];
}

/** The internal prepared shape of the op after enrichment. */
export type PreparedCutSilenceFromAnalysisOp = ClipCutSilenceFromAnalysisOp & {
  readonly cuts?: SilenceCutPlan;
};

function mergeWindows(windows: readonly SilenceCutWindow[]): SilenceCutWindow[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((left, right) => left.startSec - right.startSec);
  const merged: Array<{ startSec: number; endSec: number }> = [{ ...sorted[0]! }];
  for (const window of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (window.startSec <= last.endSec - CLAMP_EPS) last.endSec = Math.max(last.endSec, window.endSec);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * Pure source→timeline mapping of silence regions onto ONE clip's own span.
 * Constant speed (including reverse) maps through the shared core
 * SpeedEngine, exactly the way the core split action cuts source ranges.
 * Speed curves and freeze frames must be rejected by the caller first.
 */
export function mapSilenceRegionsToTimelineWindows(
  clip: Clip,
  regions: readonly { readonly startSec: number; readonly endSec: number }[],
): SilenceCutWindow[] {
  const speed = clip.speed ?? 1;
  if (!(Number.isFinite(speed) && speed > 0)) return [];
  const engine = new SpeedEngine();
  engine.loadClips([clip]);
  const sourceSpan = Math.max(0, clip.outPoint - clip.inPoint);
  const timelineStart = clip.startTime;
  const timelineEnd = clip.startTime + clip.duration;
  const windows: SilenceCutWindow[] = [];
  for (const region of regions) {
    const sourceStart = Math.max(0, Math.min(sourceSpan, region.startSec - clip.inPoint));
    const sourceEnd = Math.max(0, Math.min(sourceSpan, region.endSec - clip.inPoint));
    if (!(sourceEnd > sourceStart)) continue;
    const playbackA = engine.getPlaybackTimeAtSourceTime(clip.id, sourceStart);
    const playbackB = engine.getPlaybackTimeAtSourceTime(clip.id, sourceEnd);
    const start = Math.max(timelineStart, timelineStart + Math.min(playbackA, playbackB));
    const end = Math.min(timelineEnd, timelineStart + Math.max(playbackA, playbackB));
    if (end - start > CLAMP_EPS) windows.push({ startSec: start, endSec: end });
  }
  return mergeWindows(windows).filter((window) => window.endSec - window.startSec > MIN_CUT_SEC);
}

/**
 * Filter record regions by the caller's pause-keeping and edge-padding
 * policy, in source seconds. Regions kept as pauses (below minSilenceSec)
 * and regions consumed entirely by padding return no cut window.
 */
export function filterRegionsForCut(
  regions: readonly { readonly startSec: number; readonly endSec: number }[],
  tuning: { readonly minSilenceSec?: number; readonly paddingSec?: number },
): Array<{ startSec: number; endSec: number }> {
  const minSilenceSec = tuning.minSilenceSec ?? 0;
  const paddingSec = tuning.paddingSec ?? 0;
  const cuts: Array<{ startSec: number; endSec: number }> = [];
  for (const region of regions) {
    const duration = region.endSec - region.startSec;
    if (!(duration > minSilenceSec)) continue;
    const startSec = region.startSec + paddingSec;
    const endSec = region.endSec - paddingSec;
    if (endSec - startSec > MIN_CUT_SEC) cuts.push({ startSec, endSec });
  }
  return cuts;
}

/** Aligned same-media sibling on ANOTHER track whose timing is identical, so cutting both keeps A/V in sync. */
function findTimingIdenticalSiblings(clip: Clip, timeline: Pick<Timeline, "tracks">): Array<{ sibling: Clip; aligned: boolean; identical: boolean }> {
  const result: Array<{ sibling: Clip; aligned: boolean; identical: boolean }> = [];
  for (const track of timeline.tracks) {
    if (track.id === clip.trackId) continue;
    for (const candidate of track.clips) {
      if (candidate.id === clip.id || candidate.mediaId !== clip.mediaId) continue;
      if ((candidate.audioTrackIndex ?? 0) !== (clip.audioTrackIndex ?? 0)) continue;
      const aligned =
        Math.abs(candidate.startTime - clip.startTime) < LINK_TOLERANCE &&
        Math.abs(candidate.inPoint - clip.inPoint) < LINK_TOLERANCE;
      if (!aligned) continue;
      const identical =
        (candidate.speed ?? 1) === (clip.speed ?? 1) &&
        candidate.reversed === clip.reversed &&
        Math.abs((candidate.outPoint - candidate.inPoint) - (clip.outPoint - clip.inPoint)) < TIMING_EPS &&
        (candidate.speedKeyframes?.length ?? 0) === 0 &&
        (candidate.freezeFrames?.length ?? 0) === 0;
      result.push({ sibling: candidate, aligned: true, identical });
    }
  }
  return result;
}

/**
 * Compute the complete cut plan for one op: primary clip windows, sibling
 * entries, fade policy. Pure with respect to the supplied clip set; the
 * caller supplies the sequential draft's clips. Throws FacadeError on every
 * explicitly unsupported mapping.
 */
export function planSilenceCuts(
  primary: Clip,
  siblings: readonly Clip[],
  regions: readonly { readonly startSec: number; readonly endSec: number }[],
  tuning: {
    readonly minSilenceSec?: number;
    readonly paddingSec?: number;
    readonly fadeSec: number;
  },
): SilenceCutPlan {
  const label = "clip.cutSilenceFromAnalysis";
  const unsupported = (message: string, details?: Record<string, unknown>): never => {
    throw new FacadeError("UNSUPPORTED", `${label}: ${message}`, details);
  };
  const checkClipTiming = (clip: Clip, role: string): void => {
    if ((clip.speedKeyframes?.length ?? 0) > 0 || (clip.freezeFrames?.length ?? 0) > 0) {
      unsupported(`${role} clip "${clip.id}" uses speed curves or freeze frames — the core split/trim actions reject those timings; flatten the speed configuration first`, { clipId: clip.id });
    }
    const speed = clip.speed ?? 1;
    if (!(Number.isFinite(speed) && speed > 0)) {
      unsupported(`${role} clip "${clip.id}" has a non-positive speed (${String(speed)})`, { clipId: clip.id, speed });
    }
  };
  checkClipTiming(primary, "primary");
  for (const sibling of siblings) checkClipTiming(sibling, "linked");

  const cuts = filterRegionsForCut(regions, tuning);
  const entries: SilenceCutPlanEntry[] = [];
  for (const clip of [primary, ...siblings]) {
    const windows = mapSilenceRegionsToTimelineWindows(clip, cuts);
    entries.push({
      clipId: clip.id,
      windows,
      baseFade: { fadeIn: clip.fade?.fadeIn ?? 0, fadeOut: clip.fade?.fadeOut ?? 0 },
    });
  }
  const primaryWindows = entries[0]!.windows;
  const needsFades =
    tuning.fadeSec > 0 || entries.some((entry) => entry.baseFade.fadeIn > 0 || entry.baseFade.fadeOut > 0);
  return { fadeSec: tuning.fadeSec, needsFades, entries: primaryWindows.length === 0 ? [] : entries };
}

/**
 * Rewrite every clip.cutSilenceFromAnalysis op into the same op carrying the
 * concrete `cuts` plan (consumed by the ops.ts translator). All record,
 * mapping, sibling and subtitle gates run here — before any mutation starts
 * — so a rejected op leaves the batch untouched.
 */
export interface EnrichCutSilenceOptions {
  /** Original batch index, so single-op calls keep the batch-wide label. */
  readonly opIndexBase?: number;
  /** Verb name used in error labels (defaults to edit.apply). */
  readonly verb?: "edit.apply" | "edit.validate";
}

export async function enrichCutSilenceOps(
  ops: readonly EditOp[],
  artifactRoot: string | undefined,
  getProject: () => Promise<Project | null>,
  options: EnrichCutSilenceOptions = {},
): Promise<readonly EditOp[]> {
  if (!ops.some((op) => op.op === "clip.cutSilenceFromAnalysis")) return ops;
  if (!artifactRoot) {
    throw new FacadeError("UNSUPPORTED", "clip.cutSilenceFromAnalysis requires artifactRoot to read the silence analysis record");
  }
  const project = await getProject();
  if (!project) {
    throw new FacadeError("UNSUPPORTED", "clip.cutSilenceFromAnalysis requires an open project");
  }
  const opIndexBase = options.opIndexBase ?? 0;
  const verb = options.verb ?? "edit.apply";
  const allClips = project.timeline.tracks.flatMap((track) => track.clips);
  const enriched: EditOp[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "clip.cutSilenceFromAnalysis") {
      enriched.push(op);
      continue;
    }
    const cut = op as ClipCutSilenceFromAnalysisOp;
    const label = `${verb} ops[${opIndexBase + index}] clip.cutSilenceFromAnalysis`;
    const record = await loadAnalysisRecord(artifactRoot, cut.recordId);
    if (record.stale.kind === "source-changed") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${cut.recordId}" is stale — the source file changed after the analysis; re-run media.analyze_start with analysisTypes ["silence"] and use the new record id`, { recordId: cut.recordId, stale: record.stale });
    }
    if (record.stale.kind === "source-missing") {
      throw new FacadeError("CONFLICT", `${label}: analysis record "${cut.recordId}" is stale — its source file is missing; restore the source or re-analyze a readable one`, { recordId: cut.recordId });
    }
    const facts = record.observations.find((observation) => observation.source === "silence")?.facts as
      | { silentRegions?: ReadonlyArray<{ startSec: number; endSec: number }> }
      | undefined;
    const regions = facts?.silentRegions;
    if (!Array.isArray(regions)) {
      throw new FacadeError("UNSUPPORTED", `${label}: analysis record "${cut.recordId}" contains no silence silentRegions — run media.analyze_start with analysisTypes ["silence"] on the clip's own media first`, { recordId: cut.recordId });
    }
    const clip = allClips.find((candidate) => candidate.id === cut.clipId);
    if (!clip) {
      throw new FacadeError("NOT_FOUND", `${label}: clip "${cut.clipId}" not found`, { clipId: cut.clipId });
    }
    if (clip.mediaId !== record.subject.mediaId) {
      throw new FacadeError("INVALID_PARAMS", `${label}: clip "${clip.id}" plays media "${clip.mediaId}" but the record analyzed media "${record.subject.mediaId}" ("${record.subject.name}") — analyze the clip's own media and pass that record`, { clipId: clip.id, clipMediaId: clip.mediaId, recordMediaId: record.subject.mediaId });
    }
    // silence analysis always decodes the first audio stream (0:a:0).
    const audioTrack = clip.audioTrackIndex ?? 0;
    if (audioTrack !== 0) {
      throw new FacadeError("UNSUPPORTED", `${label}: clip "${clip.id}" plays audioTrackIndex ${audioTrack}, but silence analysis analyzed audio stream 0 — use a clip on track 0`, { clipId: clip.id, audioTrackIndex: audioTrack, analyzedAudioStream: 0 });
    }
    // Aligned same-media siblings on other tracks must be cut together or
    // the pair desyncs; a sibling with different timing cannot be cut with
    // the same windows, so it is rejected explicitly.
    const siblings: Clip[] = [];
    for (const { sibling, identical } of findTimingIdenticalSiblings(clip, project.timeline)) {
      if (!identical) {
        throw new FacadeError("UNSUPPORTED", `${label}: clip "${sibling.id}" is an aligned linked clip of the same media but has different speed/trim timing — cutting only one side would desync picture and sound; align the pair or cut manually`, { clipId: clip.id, siblingClipId: sibling.id });
      }
      siblings.push(sibling);
    }
    const maxCutRegions = cut.maxCutRegions ?? DEFAULT_MAX_CUT_REGIONS;
    const plan = planSilenceCuts(clip, siblings, regions, {
      minSilenceSec: cut.minSilenceSec,
      paddingSec: cut.paddingSec,
      fadeSec: cut.fadeSec ?? DEFAULT_CUT_SILENCE_FADE_SEC,
    });
    const primaryWindows = plan.entries[0]?.windows ?? [];
    if (primaryWindows.length === 0) {
      throw new FacadeError("INVALID_PARAMS", `${label}: no silence regions from record "${cut.recordId}" survive the minSilenceSec/paddingSec policy inside clip "${cut.clipId}" — nothing to cut; lower minSilenceSec/paddingSec or re-analyze with a lower threshold`, { recordId: cut.recordId, clipId: cut.clipId });
    }
    if (primaryWindows.length > maxCutRegions) {
      raiseTooManyRegions(label, primaryWindows.length, maxCutRegions, cut);
    }
    // Subtitle cues are absolute-time entities the facade cannot shift, so
    // refuse instead of silently breaking their alignment.
    const subtitles = project.timeline.subtitles ?? [];
    if (subtitles.length > 0) {
      const firstCutStart = Math.min(...plan.entries.flatMap((entry) => entry.windows.map((window) => window.startSec)));
      const desyncing = subtitles.filter((subtitle) => subtitle.endTime > firstCutStart + EDGE_EPS);
      if (desyncing.length > 0) {
        throw new FacadeError("UNSUPPORTED", `${label}: ${desyncing.length} subtitle cue(s) end after the first cut at ${firstCutStart.toFixed(3)}s and would desync — ripple-moving subtitles is not defined; clear or re-time them first, or cut manually`, { firstCutStartSec: firstCutStart, affectedSubtitleCount: desyncing.length });
      }
    }
    enriched.push({ ...cut, cuts: plan } as PreparedCutSilenceFromAnalysisOp);
  }
  return enriched;
}

function raiseTooManyRegions(label: string, count: number, maxCutRegions: number, cut: ClipCutSilenceFromAnalysisOp): never {
  throw new FacadeError(
    "INVALID_PARAMS",
    `${label}: ${count} silence regions survived the policy, above maxCutRegions ${maxCutRegions} — raise minSilenceSec (keep more pauses), raise maxCutRegions (up to ${MAX_CUT_REGIONS_LIMIT}), or re-run the analysis with a larger silenceParams.minDurationSec`,
    { regionCount: count, maxCutRegions, recordId: cut.recordId },
  );
}
