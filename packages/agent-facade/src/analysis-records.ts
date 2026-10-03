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
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

import { FacadeError } from "./errors";

export const ANALYSIS_RECORDS_SCHEMA_VERSION = 1;

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
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly subject: AnalysisSubjectFacts;
  readonly analysisTypes: readonly string[];
  readonly rangeSec: { readonly startSec: number; readonly endSec: number };
  /** Exact request configuration — the "same config" needed for a recheck. */
  readonly config: {
    readonly analysisTypes: readonly string[];
    readonly startSec: number;
    readonly endSec: number;
    readonly cloudUpload: boolean;
    readonly reviewQuestion?: string;
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
  record: Omit<AnalysisRecord, "schemaVersion" | "id" | "createdAt" | "finishedAt"> & {
    readonly createdAt?: string;
  },
): Promise<AnalysisRecordView> {
  const dir = recordsDir(artifactRoot);
  await mkdir(dir, { recursive: true });
  const full: AnalysisRecord = {
    schemaVersion: ANALYSIS_RECORDS_SCHEMA_VERSION,
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
  const parsed = JSON.parse(raw) as AnalysisRecord;
  if (parsed.schemaVersion !== ANALYSIS_RECORDS_SCHEMA_VERSION) {
    throw new FacadeError("JOB_FAILED", `analysis record "${recordId}" has unsupported schema version ${parsed.schemaVersion}`);
  }
  return { ...parsed, stale: await assertStaleness(parsed), recordPath };
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
