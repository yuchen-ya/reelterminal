/**
 * Durable analysis records with provenance, source fingerprints, and rechecks.
 *
 *  - PROVENANCE: each record names its sources — "local-measurement"
 *    (technicalQuality/audioSummary, measured by local ffmpeg/mediabunny),
 *    "static-sampling" (frame/contact-sheet inspections), "cloud-opinion"
 *    (provider model text, stored AS DATA — model prose is never executed,
 *    never treated as instructions, and never auto-converts into a pass).
 *  - SEPARATION: observations (what was measured), inferences (what the
 *    analyzer concluded) and recommendations (what a human might change)
 *    never blend into one verdict.
 *  - HONEST UNKNOWNS: sampling rates, localization precision or confidences
 *    the provider did not supply are stored as explicit nulls — never
 *    invented.
 *  - STALENESS: records pin the source fingerprint; reads re-stat the file
 *    and report current/stale so a modified source can't masquerade as
 *    analyzed.
 *  - RECHECK: re-running with the stored configuration links the new record
 *    to the previous one (recheckOf), so before/after evidence is one query.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

import { FacadeError } from "./errors";
import type { AnalysisGetParams, MediaSilenceAnalysisParams } from "./types";

export const ANALYSIS_RECORDS_SCHEMA_VERSION = 3;

/** Where a finding/record came from — the anti-fabrication axis. */
export type AnalysisProvenance =
  | "local-measurement"
  | "static-sampling"
  | "cloud-opinion";

export interface AnalysisSubjectFacts {
  readonly mediaId: string;
  readonly name: string;
  /** Absolute path the analysis read — used for staleness re-stats. */
  readonly sourcePath: string;
  readonly sourceFingerprint: { readonly size: number; readonly lastModified: number };
}

export interface AnalysisRecord {
  readonly schemaVersion: typeof ANALYSIS_RECORDS_SCHEMA_VERSION;
  /** Absent on historical records whose event arrays may already be truncated. */
  readonly audioDetailsComplete?: true;
  readonly id: string;
  readonly projectId: string;
  /** Project revision captured when the analysis job was created. */
  readonly sourceRevision: number | null;
  /** Analysis ranges and time-coded findings use original media seconds. */
  readonly coordinateSpace: "source";
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly subject: AnalysisSubjectFacts;
  readonly analysisTypes: readonly string[];
  /** Original-media source seconds, matching coordinateSpace. */
  readonly rangeSec: { readonly startSec: number; readonly endSec: number };
  /** Exact request configuration — the "same config" needed for a recheck. */
  readonly config: {
    readonly analysisTypes: readonly string[];
    readonly startSec: number;
    readonly endSec: number;
    readonly cloudUpload: boolean;
    readonly reviewQuestion?: string;
    /** Effective silence tuning, including defaults; absent on historical records. */
    readonly silenceParams?: Required<MediaSilenceAnalysisParams>;
    /** Effective speech-activity (Silero VAD) tuning, including defaults; absent on historical records. */
    readonly vadParams?: { readonly threshold: number; readonly exitThreshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number };
    /** Effective sync-offset tuning, including defaults; absent on historical records. */
    readonly syncOffsetParams?: { readonly referenceMediaId: string; readonly referenceStartSec: number; readonly searchRangeSec: number; readonly windowSec: number; readonly guardSec: number };
    /** Effective transcript tuning and the external-VAD segmentation it used; absent on historical records. */
    readonly transcriptParams?: {
      readonly language: string;
      readonly useItn: boolean;
      readonly allowModelDownload: boolean;
      readonly vadParams: { readonly threshold: number; readonly exitThreshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number };
    };
  };
  readonly provenance: readonly {
    readonly kind: AnalysisProvenance;
    /** e.g. "built-in-mediabunny-stat", "qwen3.5-omni-flash", plugin id. */
    readonly provider: string;
    readonly analysisType: string;
  }[];
  /** Measured facts (numbers, metadata, waveforms…). */
  readonly observations: readonly Record<string, unknown>[];
  /** Analyzer conclusions, clearly downstream of observations. */
  readonly inferences: readonly Record<string, unknown>[];
  /** Suggestions — proposals, never verdicts. */
  readonly recommendations: readonly Record<string, unknown>[];
  /**
   * Facts the providers did NOT supply (sampling fps, localization
   * precision, confidences). Explicit nulls — never fabricated.
   */
  readonly unknowns: readonly { readonly field: string; readonly note: string }[];
  /** Link to the record this one re-checked (same-config re-run). */
  readonly recheckOf: string | null;
  /** Cloud-opinion text (if any), stored verbatim as DATA. */
  readonly cloudOpinion: {
    readonly provider: string;
    readonly text: string;
    readonly status: string;
    readonly serverSamplingFps: number | null;
  } | null;
}

export type AnalysisStaleness =
  | { readonly kind: "current" }
  | { readonly kind: "source-missing" }
  | { readonly kind: "source-changed"; readonly size: number; readonly lastModified: number };

export interface AnalysisRecordView extends AnalysisRecord {
  readonly stale: AnalysisStaleness;
  /** Absolute path of the persisted record file (auditable JSON). */
  readonly recordPath: string;
}

/** The persisted request configuration, stripped of derived/effective fields,
 * so it can be fed back to media.analyze_start unchanged. `config.vadParams`
 * intentionally stores the derived exitThreshold for auditability; the input
 * schema does not accept it. */
export interface AnalysisReplayParams {
  readonly analysisTypes: readonly string[];
  readonly startSec: number;
  readonly endSec: number;
  readonly silenceParams?: Required<MediaSilenceAnalysisParams>;
  readonly vadParams?: { readonly threshold: number; readonly minSpeechSec: number; readonly minSilenceSec: number; readonly padSec: number };
  readonly syncOffsetParams?: { readonly referenceMediaId: string; readonly referenceStartSec: number; readonly searchRangeSec: number; readonly windowSec: number };
  readonly transcriptParams?: { readonly language: string; readonly useItn: boolean; readonly allowModelDownload: boolean };
}

export function analysisReplayParams(record: AnalysisRecord): AnalysisReplayParams {
  const vadParams = record.config.vadParams;
  return {
    analysisTypes: [...record.config.analysisTypes],
    startSec: record.config.startSec,
    endSec: record.config.endSec,
    ...(record.config.silenceParams ? { silenceParams: record.config.silenceParams } : {}),
    ...(vadParams
      ? {
          vadParams: {
            threshold: vadParams.threshold,
            minSpeechSec: vadParams.minSpeechSec,
            minSilenceSec: vadParams.minSilenceSec,
            padSec: vadParams.padSec,
          },
        }
      : {}),
    ...(record.config.syncOffsetParams
      ? {
          syncOffsetParams: {
            referenceMediaId: record.config.syncOffsetParams.referenceMediaId,
            referenceStartSec: record.config.syncOffsetParams.referenceStartSec,
            searchRangeSec: record.config.syncOffsetParams.searchRangeSec,
            windowSec: record.config.syncOffsetParams.windowSec,
          },
        }
      : {}),
    ...(record.config.transcriptParams
      ? {
          transcriptParams: {
            language: record.config.transcriptParams.language,
            useItn: record.config.transcriptParams.useItn,
            allowModelDownload: record.config.transcriptParams.allowModelDownload,
          },
        }
      : {}),
  };
}

function recordsDir(artifactRoot: string): string {
  return resolvePath(artifactRoot, "analysis-records");
}

async function assertStaleness(record: AnalysisRecord): Promise<AnalysisStaleness> {
  const fileStat = await stat(record.subject.sourcePath).catch(() => null);
  if (!fileStat?.isFile()) return { kind: "source-missing" };
  if (
    fileStat.size !== record.subject.sourceFingerprint.size ||
    Math.round(fileStat.mtimeMs) !== record.subject.sourceFingerprint.lastModified
  ) {
    return {
      kind: "source-changed",
      size: fileStat.size,
      lastModified: Math.round(fileStat.mtimeMs),
    };
  }
  return { kind: "current" };
}

/** Persist one record; returns the record enriched with staleness + path. */
export async function saveAnalysisRecord(
  artifactRoot: string,
  record: Omit<AnalysisRecord, "schemaVersion" | "id" | "createdAt" | "finishedAt" | "sourceRevision"> & {
    readonly sourceRevision: number;
    readonly createdAt?: string;
  },
): Promise<AnalysisRecordView> {
  const dir = recordsDir(artifactRoot);
  await mkdir(dir, { recursive: true });
  const full: AnalysisRecord = {
    schemaVersion: ANALYSIS_RECORDS_SCHEMA_VERSION,
    audioDetailsComplete: true,
    id: `analysis-${randomUUID()}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...record,
  };
  const recordPath = resolvePath(dir, `${full.id}.json`);
  await writeFile(recordPath, `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return { ...full, stale: await assertStaleness(full), recordPath };
}

/** Load + staleness-check one record by id. */
export async function loadAnalysisRecord(
  artifactRoot: string,
  recordId: string,
): Promise<AnalysisRecordView> {
  if (!/^analysis-[0-9a-f-]{8,}$/i.test(recordId)) {
    throw new FacadeError("INVALID_PARAMS", `analysis record id must look like "analysis-<uuid>"`, { recordId });
  }
  const recordPath = resolvePath(recordsDir(artifactRoot), `${recordId}.json`);
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch {
    throw new FacadeError("NOT_FOUND", `analysis record "${recordId}" not found`, { recordId });
  }
  const parsed = JSON.parse(raw) as { readonly schemaVersion: number; readonly [key: string]: unknown };
  let record: AnalysisRecord;
  if (parsed.schemaVersion === 1) {
    // Historical records predate project-revision metadata. Their analyses
    // used source-media seconds, but the revision cannot be reconstructed.
    record = {
      ...parsed,
      schemaVersion: ANALYSIS_RECORDS_SCHEMA_VERSION,
      sourceRevision: null,
      coordinateSpace: "source",
    } as unknown as AnalysisRecord;
  } else if (parsed.schemaVersion === 2 || parsed.schemaVersion === ANALYSIS_RECORDS_SCHEMA_VERSION) {
    record = { ...parsed, schemaVersion: ANALYSIS_RECORDS_SCHEMA_VERSION } as unknown as AnalysisRecord;
  } else {
    throw new FacadeError("JOB_FAILED", `analysis record "${recordId}" has unsupported schema version ${parsed.schemaVersion}`);
  }
  return { ...record, stale: await assertStaleness(record), recordPath };
}

/** Roll back a record if cancellation or checkpoint failure prevents job success. */
export async function removeAnalysisRecord(artifactRoot: string, recordId: string): Promise<void> {
  if (!/^analysis-[0-9a-f-]{8,}$/i.test(recordId)) {
    throw new FacadeError("INVALID_PARAMS", "Invalid analysis record id");
  }
  // A failed completion checkpoint has already made the job terminal. Finish
  // its small-file rollback in this turn so status/list callers cannot observe
  // that failure alongside a record whose completion was never committed.
  rmSync(resolvePath(recordsDir(artifactRoot), `${recordId}.json`), { force: true });
}

const AUDIO_SERIES = {
  "audioSummary.onsets": { source: "audioSummary", field: "onsets", count: "onsetCount" },
  "audioSummary.silence": { source: "audioSummary", field: "silence", count: "silenceCount" },
  "silence.silentRegions": { source: "silence", field: "silentRegions", count: "regionCount" },
  "beatGrid.beats": { source: "beatGrid", field: "beats", count: "beatCount" },
  "speechActivity.speechRegions": { source: "speechActivity", field: "speechRegions", count: "regionCount" },
  "speechTranscript.segments": { source: "speechTranscript", field: "segments", count: "segmentCount" },
} as const;
type AudioSeries = keyof typeof AUDIO_SERIES;

/** The stored facts are full; job and Agent summary views omit dense audio arrays. */
export function compactAnalysisFacts(source: string, facts: Record<string, unknown>): Record<string, unknown> {
  const omitted = source === "audioSummary" ? ["waveform", "onsets", "silence"]
    : source === "silence" ? ["silentRegions"] : source === "beatGrid" ? ["beats"]
    : source === "speechActivity" ? ["speechRegions"]
    : source === "speechTranscript" ? ["segments"] : [];
  return Object.fromEntries(Object.entries(facts).filter(([key]) => !omitted.includes(key)));
}

interface AudioDetailAvailability {
  readonly series: AudioSeries;
  readonly totalCount: number | null;
  readonly storedCount: number;
  /** False means paging cannot recover information lost by the historical analyzer. */
  readonly complete: boolean;
}
interface AudioEvent extends Record<string, unknown> {
  readonly id: string;
  readonly timeSec?: number;
  readonly startSec?: number;
  readonly endSec?: number;
}
interface WaveformPoint {
  readonly startSec: number;
  readonly endSec: number;
  readonly rms: number;
  readonly peak: number;
}
export interface AnalysisAgentView extends AnalysisRecordView {
  readonly view: "summary" | "events" | "waveform";
  readonly details: readonly AudioDetailAvailability[];
  readonly events?: {
    readonly series: AudioSeries;
    readonly window: { readonly startSec: number; readonly endSec: number };
    readonly limit: number;
    /** Unknown when historical truncation discarded matching events. */
    readonly totalMatched: number | null;
    readonly storedMatched: number;
    readonly items: readonly AudioEvent[];
    readonly nextCursor: string | null;
    readonly complete: boolean;
  };
  readonly waveform?: {
    readonly window: { readonly startSec: number; readonly endSec: number };
    readonly maxPoints: number;
    readonly points: readonly WaveformPoint[];
    readonly complete: boolean;
  };
}

function audioFacts(record: AnalysisRecord, source: string): Record<string, unknown> | undefined {
  return record.observations.find((observation) => observation.source === source)?.facts as Record<string, unknown> | undefined;
}

function audioAvailability(record: AnalysisRecord): AudioDetailAvailability[] {
  return (Object.entries(AUDIO_SERIES) as [AudioSeries, typeof AUDIO_SERIES[AudioSeries]][]).flatMap(([series, definition]) => {
    const facts = audioFacts(record, definition.source);
    if (!facts) return [];
    const storedCount = (facts[definition.field] as unknown[] | undefined)?.length ?? 0;
    const totalCount = typeof facts[definition.count] === "number" ? facts[definition.count] as number : null;
    return [{ series, storedCount, totalCount, complete: totalCount === storedCount && (record.audioDetailsComplete === true || facts.truncated === false) }];
  });
}

function invalidQuery(message: string): never {
  throw new FacadeError("INVALID_PARAMS", message);
}

/** Check view-specific combinations before root requirements or disk access. */
export function validateAnalysisGetQuery(params: AnalysisGetParams): void {
  const view = params.view ?? "summary";
  const allowed = view === "summary" ? ["recordId", "view"]
    : view === "events" ? ["recordId", "view", "series", "startSec", "endSec", "limit", "cursor"]
    : ["recordId", "view", "startSec", "endSec", "maxPoints"];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) invalidQuery(`${key} is not valid for analysis.get view ${view}`);
  }
  if (params.view === "events" && (!params.series || !Object.hasOwn(AUDIO_SERIES, params.series))) {
    invalidQuery("events view requires a supported audio series");
  }
}

/** Read a validated Agent query. Desktop GUI loaders intentionally keep the full record. */
export async function getAnalysisRecordView(artifactRoot: string, params: AnalysisGetParams): Promise<AnalysisAgentView> {
  const view = params.view ?? "summary";
  const record = await loadAnalysisRecord(artifactRoot, params.recordId);
  const details = audioAvailability(record);
  const summary: AnalysisAgentView = {
    ...record, view, details,
    observations: record.observations.map((observation) => observation.facts
      ? { ...observation, facts: compactAnalysisFacts(String(observation.source), observation.facts as Record<string, unknown>) }
      : observation),
  };
  if (params.view !== "events" && params.view !== "waveform") return summary;
  const startSec = params.startSec ?? record.rangeSec.startSec;
  const endSec = params.endSec ?? record.rangeSec.endSec;
  if (!(Number.isFinite(startSec) && Number.isFinite(endSec) && startSec >= record.rangeSec.startSec && endSec <= record.rangeSec.endSec && startSec < endSec)) {
    invalidQuery("analysis.get requires a nonempty source-seconds window within the stored analysis range");
  }
  const window = { startSec, endSec };
  if (params.view === "events") {
    const series = params.series;
    const definition = AUDIO_SERIES[series];
    const availability = details.find((detail) => detail.series === series);
    if (!availability) throw new FacadeError("NOT_FOUND", `Record does not contain ${series}`);
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) invalidQuery("events limit must be an integer in [1, 256]");
    const facts = audioFacts(record, definition.source)!;
    const all = (facts[definition.field] as (number | Record<string, unknown>)[]).map((event, index): AudioEvent => ({
      ...(typeof event === "number" ? { timeSec: event } : event),
      id: `${record.id}/${series}/${index}`,
    }));
    all.sort((a, b) => (a.timeSec ?? a.startSec!) - (b.timeSec ?? b.startSec!));
    const matched = all.filter((event) => event.timeSec !== undefined
      ? event.timeSec >= startSec && event.timeSec < endSec
      : event.startSec! < endSec && event.endSec! > startSec);
    // A transparent cursor binds the page to the immutable record and normalized query.
    // It is an offset, not a credential; arbitrary valid offsets are safe.
    const query = [record.id, series, startSec, endSec, limit];
    let offset = 0;
    if (params.cursor) {
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")); }
      catch { invalidQuery("Invalid analysis events cursor"); }
      if (!Array.isArray(decoded) || decoded.length !== 6 || query.some((value, index) => value !== decoded[index])) invalidQuery("Cursor does not match the record, series, window and limit");
      offset = decoded[5] as number;
      if (!Number.isInteger(offset) || offset < 0 || offset > matched.length) invalidQuery("Cursor offset is outside the available event window");
    }
    const items = matched.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < matched.length ? Buffer.from(JSON.stringify([...query, nextOffset])).toString("base64url") : null;
    return { ...summary, events: { series, window, limit, totalMatched: availability.complete ? matched.length : null, storedMatched: matched.length, items, nextCursor, complete: availability.complete } };
  }
  const maxPoints = params.maxPoints ?? 150;
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 600) invalidQuery("waveform maxPoints must be an integer in [1, 600]");
  const facts = audioFacts(record, "audioSummary");
  const levels = facts?.waveform as { binDurationSec: number; bins: { rms: number; peak: number }[] }[] | undefined;
  if (!levels?.length) throw new FacadeError("NOT_FOUND", "Record does not contain an audioSummary waveform");
  const level = levels.reduce((best, candidate) => candidate.binDurationSec < best.binDurationSec ? candidate : best);
  const waveformStart = facts!.startSec as number;
  const waveformEnd = Math.min(record.rangeSec.endSec, waveformStart + (facts!.durationSec as number));
  const points = level.bins.map((bin, index) => ({ ...bin, startSec: waveformStart + index * level.binDurationSec, endSec: Math.min(waveformEnd, waveformStart + (index + 1) * level.binDurationSec) }))
    .filter((bin) => bin.startSec < endSec && bin.endSec > startSec);
  const stride = Math.max(1, Math.ceil(points.length / maxPoints));
  const bounded: WaveformPoint[] = [];
  for (let index = 0; index < points.length; index += stride) {
    const group = points.slice(index, index + stride);
    const duration = group.reduce((sum, point) => sum + point.endSec - point.startSec, 0);
    bounded.push({ startSec: group[0]!.startSec, endSec: group[group.length - 1]!.endSec,
      rms: Math.sqrt(group.reduce((sum, point) => sum + point.rms ** 2 * (point.endSec - point.startSec), 0) / duration),
      peak: Math.max(...group.map((point) => point.peak)) });
  }
  return { ...summary, waveform: { window, maxPoints, points: bounded, complete: waveformEnd >= endSec } };
}

/** List records (newest first), optionally filtered by media id. */
export async function listAnalysisRecords(
  artifactRoot: string,
  filter: { readonly mediaId?: string; readonly limit?: number } = {},
): Promise<readonly AnalysisRecordView[]> {
  const dir = recordsDir(artifactRoot);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const records: AnalysisRecordView[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("analysis-") || !entry.endsWith(".json")) continue;
    try {
      const view = await loadAnalysisRecord(artifactRoot, entry.replace(/\.json$/, ""));
      if (filter.mediaId && view.subject.mediaId !== filter.mediaId) continue;
      records.push(view);
    } catch {
      // Unreadable/corrupt record files are skipped in listings; direct
      // analysis.get still surfaces them loudly.
    }
  }
  records.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  return filter.limit ? records.slice(0, filter.limit) : records;
}

/** The previous record a recheck should link to, if the caller named one. */
export async function resolveRecheckTarget(
  artifactRoot: string,
  recheckOfRecordId: string | undefined,
): Promise<AnalysisRecordView | null> {
  if (!recheckOfRecordId) return null;
  return loadAnalysisRecord(artifactRoot, recheckOfRecordId);
}
