import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPerfSink, type PerfContext, type PerfSpan } from "@reelterminal/core";
import type { Project } from "@reelterminal/core";
import { isArtifactFileRecord, type ArtifactFileRecord, type ArtifactOwnership } from "@reelterminal/core/types/artifact-ownership";
import type { JobStatusView } from "@reelterminal/agent-facade";
import type {
  ProjectLibraryTrackedArtifactFile,
  ProjectLibraryTrackedWorkFingerprint,
  ProjectLibraryPurgeTrackedWorkFilesRequest,
  ProjectLibraryPurgeTrackedWorkFilesResult,
} from "../../shared/project-library-cleanup";
import {
  withExportPerformance,
  type ExportPerformanceSink,
} from "@reelterminal/runtime-chromium";

export interface DurableTaskInput {
  readonly jobId: string;
  readonly kind: "export" | "analysis" | "audio-process";
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRevision: number;
  readonly inputProject: Project;
  readonly parameters: unknown;
}

export interface DurableTaskRecord extends DurableTaskInput {
  readonly formatVersion: 1;
  readonly status: JobStatusView;
}

const terminalStates = new Set(["done", "error", "cancelled"]);
const taskStates = new Set(["queued", "running", "done", "error", "cancelled"]);

/** Identity subset of a task — the per-update event emit reads only this. */
export interface DurableTaskSummary {
  readonly jobId: string;
  readonly kind: DurableTaskInput["kind"];
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRevision: number;
}

/**
 * Minimum spacing between two progress-only status writes. Progress is
 * display-only state: a restart marks any non-terminal task INTERRUPTED
 * regardless of the last persisted percent, so a trailing write of the
 * latest value is durable enough without a per-frame fsync.
 */
export const PROGRESS_WRITE_INTERVAL_MS = 500;

interface InternalRecord {
  /** Detached at begin() — later GUI edits to the source project never leak in. */
  readonly input: DurableTaskInput;
  status: JobStatusView;
  readonly artifactFilesIntegrityError?: string;
  readonly persistedArtifactFileValues?: unknown;
  readonly artifactManifestMissing?: boolean;
}

function artifactFileManifest(status: JobStatusView | undefined): {
  readonly files: readonly ArtifactFileRecord[];
  readonly missing: boolean;
  readonly integrityError?: string;
  readonly persistedValues?: unknown;
} {
  if (!status || !Object.prototype.hasOwnProperty.call(status, "artifactFiles")) return { files: [], missing: true };
  const value = (status as { readonly artifactFiles?: unknown }).artifactFiles;
  if (!Array.isArray(value)) {
    return { files: [], integrityError: "Task artifact file manifest is not an array.", persistedValues: value, missing: false };
  }
  const files = value.filter(isArtifactFileRecord).map((file) => ({ ...file }));
  const fileIds = new Set(files.map((file) => file.fileId));
  const hasDuplicateIds = fileIds.size !== files.length;
  if (files.length !== value.length || hasDuplicateIds) {
    return {
      files,
      integrityError: "Task artifact file manifest contains invalid or duplicate entries.",
      persistedValues: value,
      missing: false,
    };
  }
  return { files, missing: false };
}

export interface CleanupCandidateTarget {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface CleanupCandidateFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
  readonly retainedReason: string;
}

export interface CleanupCandidateTask {
  readonly jobId: string;
  readonly kind: DurableTaskInput["kind"];
  readonly sourceRevision: number;
  readonly state: JobStatusView["state"];
  readonly ownership?: ArtifactOwnership;
  readonly artifactFiles: readonly ProjectLibraryTrackedArtifactFile[];
  /** Only failed/cancelled tasks expose their own removable ledger record files. */
  readonly files: readonly CleanupCandidateFile[];
  readonly retainedReason?: string;
}

export interface CleanupCandidateSummary {
  readonly tasks: readonly CleanupCandidateTask[];
  readonly unknowns: readonly string[];
  readonly artifactScanReady: boolean;
}

export interface FailedTaskRecordFingerprint {
  readonly jobId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}

export interface PurgeFailedTaskRecordsInput extends CleanupCandidateTarget {
  readonly jobIds: readonly string[];
  readonly expectedFiles: readonly FailedTaskRecordFingerprint[];
}

export interface PurgeFailedTaskRecordsResult {
  readonly actualBytes: number;
  readonly deleted: readonly { readonly jobId: string; readonly files: readonly string[] }[];
  readonly skipped: readonly { readonly jobId: string; readonly reason: string }[];
  readonly failed: readonly { readonly jobId: string; readonly reason: string }[];
}

interface SafeArtifactFile {
  readonly size: number;
  readonly mtimeMs: number;
}

const FAILED_RECORD_FILE_RETENTION_REASON =
  "Removing this failed task record removes its fixed-input and retry evidence; no output or media file is removed.";

function taskPurpose(input: DurableTaskInput): string {
  const parameters = input.parameters && typeof input.parameters === "object"
    ? input.parameters as Record<string, unknown>
    : {};
  if (input.kind === "export") return "Video export";
  if (input.kind === "analysis") {
    const types = Array.isArray(parameters.analysisTypes)
      ? parameters.analysisTypes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return types.length > 0 ? `Media analysis: ${types.join(", ")}` : "Media analysis";
  }
  const verb = typeof parameters.verb === "string" && parameters.verb.startsWith("audio.process.")
    ? parameters.verb.slice("audio.process.".length)
    : null;
  return verb ? `Audio processing: ${verb}` : "Audio processing";
}

function ownershipForTask(
  input: DurableTaskInput,
  status: Pick<JobStatusView, "state" | "deliveredTo">,
): ArtifactOwnership {
  return {
    kind: input.kind === "export" && status.state === "done" ? "output" : "work",
    purpose: taskPurpose(input),
    origin: "agent",
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    deliveryStatus: status.deliveredTo ? "delivered" : "pending",
  };
}

function normalizedPathKey(value: string): string {
  return path.resolve(value).normalize("NFC").toLocaleLowerCase("en-US");
}

function hasAbsolutePathReference(value: unknown, expectedPath: string): boolean {
  const expected = normalizedPathKey(expectedPath);
  if (typeof value === "string") {
    let candidate = value;
    if (/^file:/i.test(candidate)) {
      try { candidate = fileURLToPath(candidate); } catch { return true; }
    }
    return (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) && normalizedPathKey(candidate) === expected;
  }
  if (Array.isArray(value)) return value.some((item) => hasAbsolutePathReference(item, expectedPath));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => hasAbsolutePathReference(item, expectedPath));
}

/**
 * A fixed task input and its latest status survive a desktop restart.
 *
 * The two live in SEPARATE files so a progress update rewrites a
 * kilobyte-sized status document instead of the whole immutable input
 * (whose font snapshot can weigh tens of MiB):
 *   <jobId>.json         { formatVersion: 2, ...input }   written once
 *   <jobId>.status.json  { formatVersion: 2, jobId, status }  rewritten
 * Legacy v1 single-file records (input + status in one document) are
 * recognized on load and migrated in place.
 */
export class DurableTaskLedger {
  private readonly root: string;
  private readonly artifactRoots: readonly string[];
  private readonly progressWriteIntervalMs: number;
  private readonly unlinkRecordFile: (filePath: string) => void;
  private readonly onInputWrite?: (jobId: string) => void;
  private readonly exportPerformanceSinkForJob?: (jobId: string) => ExportPerformanceSink | undefined;
  private readonly records = new Map<string, InternalRecord>();
  private pendingProgress: { jobId: string; status: JobStatusView } | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string, options: {
    progressWriteIntervalMs?: number;
    /** Roots where producers are permitted to register exact work files. */
    artifactRoots?: readonly string[];
    /** Test seam for a filesystem failure while removing one task-record file. */
    unlinkRecordFile?: (filePath: string) => void;
    /** Test observation at the actual immutable-input write boundary. */
    onInputWrite?: (jobId: string) => void;
    /** Optional local collector used by deterministic export regression scenarios. */
    exportPerformanceSinkForJob?: (jobId: string) => ExportPerformanceSink | undefined;
  } = {}) {
    this.root = root;
    this.artifactRoots = [...new Set((options.artifactRoots ?? [root]).map((candidate) => path.resolve(candidate)))];
    this.progressWriteIntervalMs = options.progressWriteIntervalMs ?? PROGRESS_WRITE_INTERVAL_MS;
    this.unlinkRecordFile = options.unlinkRecordFile ?? unlinkSync;
    this.onInputWrite = options.onInputWrite;
    this.exportPerformanceSinkForJob = options.exportPerformanceSinkForJob;
    mkdirSync(root, { recursive: true });
    const inputs = new Map<string, DurableTaskInput>();
    const statuses = new Map<string, JobStatusView>();
    const statusesFromFile = new Set<string>();
    for (const file of readdirSync(root)) {
      if (file.endsWith(".tmp")) {
        // A crash between writeFileSync and renameSync strands a *.json.tmp;
        // it was never committed, so sweep it instead of letting orphans pile up.
        rmSync(path.join(root, file), { force: true });
        continue;
      }
      if (file.endsWith(".status.json")) {
        this.loadStatusFile(root, file, statuses, statusesFromFile);
        continue;
      }
      if (file.endsWith(".json")) {
        this.loadInputFile(root, file, inputs, statuses);
      }
    }
    for (const [jobId, input] of inputs) {
      const loaded = statuses.get(jobId);
      const manifest = artifactFileManifest(loaded);
      const normalizedLoaded = loaded
        ? {
            ...loaded,
            ...(manifest.missing ? {} : {
              artifactFiles: terminalStates.has(loaded.state)
                ? manifest.files.filter((file) => file.kind !== "source")
                : manifest.files,
            }),
          }
        : undefined;
      const status = normalizedLoaded && terminalStates.has(normalizedLoaded.state)
        ? normalizedLoaded
        : this.interruptedStatus(input, normalizedLoaded);
      const internal: InternalRecord = {
        input,
        status,
        ...(manifest.integrityError ? { artifactFilesIntegrityError: manifest.integrityError } : {}),
        ...(manifest.integrityError ? { persistedArtifactFileValues: manifest.persistedValues } : {}),
        ...(manifest.missing ? { artifactManifestMissing: true } : {}),
      };
      this.records.set(jobId, internal);
      // Persist when the status changed (restart honesty) or when it only
      // exists in memory so far (v1 legacy migration / synthesized status).
      if (loaded !== status || !statusesFromFile.has(jobId)) {
        this.writeStatusFile(jobId, status, true, this.manifestPersistence(internal));
      }
    }
  }

  private loadStatusFile(root: string, file: string, statuses: Map<string, JobStatusView>, statusesFromFile: Set<string>): void {
    const jobId = file.slice(0, -".status.json".length);
    try {
      const doc = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { formatVersion?: number; jobId?: string; status?: JobStatusView };
      if (doc.formatVersion !== 2 || doc.jobId !== jobId || !doc.status ||
          doc.status.jobId !== jobId || !this.validKind(doc.status.kind) ||
          !taskStates.has(doc.status.state)) {
        throw new Error("Invalid status document");
      }
      statuses.set(jobId, doc.status);
      statusesFromFile.add(jobId);
    } catch (error) {
      // A damaged status must not take the fixed input down with it:
      // quarantine it; the input resurfaces as INTERRUPTED below.
      renameSync(path.join(root, file), path.join(root, `${file}.corrupt-${Date.now()}`));
      console.warn(`[task-ledger] quarantined damaged status document ${file}:`, error);
    }
  }

  private loadInputFile(root: string, file: string, inputs: Map<string, DurableTaskInput>, statuses: Map<string, JobStatusView>): void {
    const jobId = file.slice(0, -".json".length);
    try {
      const record = JSON.parse(readFileSync(path.join(root, file), "utf8")) as Partial<DurableTaskRecord> & { formatVersion?: number };
      const legacy = record.status !== undefined;
      if (record.formatVersion !== (legacy ? 1 : 2) ||
          !this.validKind(record.kind) ||
          typeof record.projectId !== "string" || !record.projectId ||
          typeof record.workspaceId !== "string" || !record.workspaceId ||
          typeof record.jobId !== "string" || !record.jobId ||
          record.inputProject?.id !== record.projectId ||
          !Number.isSafeInteger(record.sourceRevision) || (record.sourceRevision ?? -1) < 0 ||
          this.validId(record.jobId) !== jobId) {
        throw new Error(`Invalid durable task record: ${file}`);
      }
      // Presence is guaranteed by the validation above.
      const checked = record as Pick<DurableTaskRecord, "jobId" | "kind" | "projectId" | "workspaceId" | "sourceRevision" | "inputProject"> & { parameters: unknown };
      const input: DurableTaskInput = {
        jobId: checked.jobId, kind: checked.kind, projectId: checked.projectId,
        workspaceId: checked.workspaceId, sourceRevision: checked.sourceRevision,
        inputProject: checked.inputProject, parameters: checked.parameters,
      };
      inputs.set(jobId, input);
      if (legacy) {
        // v1 single document: keep its recorded status and rewrite the pair
        // in the split layout. A failed migration write is non-fatal — the
        // v1 file stays on disk and the next restart retries it.
        const legacyStatus = record.status as JobStatusView;
        if (legacyStatus.jobId === jobId && legacyStatus.kind === input.kind && taskStates.has(legacyStatus.state)) {
          statuses.set(jobId, legacyStatus);
        }
        try {
          this.writeInputFile(input);
        } catch (error) {
          console.warn(`[task-ledger] v1→v2 migration write failed for ${file}:`, error);
        }
      }
    } catch (error) {
      // One damaged record file must not wedge every later live task, so
      // quarantine it beside the others and keep loading the rest.
      renameSync(path.join(root, file), path.join(root, `${file}.corrupt-${Date.now()}`));
      console.warn(`[task-ledger] quarantined damaged task record ${file}:`, error);
    }
  }

  /** Restart honesty: unfinished work is reported as an error, never resumed. */
  private interruptedStatus(input: DurableTaskInput, loaded: JobStatusView | undefined): JobStatusView {
    return {
      jobId: input.jobId, kind: input.kind, sourceRevision: input.sourceRevision,
      state: "error", progress: null, artifact: null, result: null,
      ...(loaded?.ownership ? { ownership: loaded.ownership } : {}),
      artifactFiles: loaded?.artifactFiles?.map((file) => ({ ...file })) ?? [],
      deliveredTo: null, deliveryError: null,
      error: { code: "INTERRUPTED", message: "Desktop restarted before this task completed. Its fixed input is retained; start a new task to retry." },
      ...(loaded?.ownership ? { ownership: { ...loaded.ownership, kind: "work" as const, deliveryStatus: "pending" as const } } : {}),
      ...(loaded?.artifactFiles ? { artifactFiles: loaded.artifactFiles.filter((file) => file.kind !== "source") } : {}),
      route: null, upscalingRequestedButInactive: false, cancelRequested: false,
      createdAt: loaded?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private validId(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid task ID");
    return jobId;
  }

  private validKind(kind: unknown): kind is DurableTaskInput["kind"] {
    return kind === "export" || kind === "analysis" || kind === "audio-process";
  }

  private inputPath(jobId: string): string {
    return path.join(this.root, `${this.validId(jobId)}.json`);
  }

  private statusPath(jobId: string): string {
    return path.join(this.root, `${this.validId(jobId)}.status.json`);
  }

  private writeAtomic(target: string, serialized: string, flush: boolean): void {
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, serialized, { encoding: "utf8", flush });
    renameSync(temporary, target);
  }

  private writeInputFile(input: DurableTaskInput): void {
    this.measureWrite(input.jobId, "export.write", "export.input-writes", () => {
      this.writeAtomic(this.inputPath(input.jobId), JSON.stringify({ formatVersion: 2, ...input }), true);
    });
    try {
      this.onInputWrite?.(input.jobId);
    } catch {
      // Test observers are observational; they must not change persistence semantics.
    }
  }

  private manifestPersistence(record: InternalRecord): { readonly present: boolean; readonly value?: unknown } {
    if (record.artifactFilesIntegrityError) return { present: true, value: record.persistedArtifactFileValues };
    if (record.artifactManifestMissing) return { present: false };
    return { present: true, value: record.status.artifactFiles ?? [] };
  }

  private writeStatusFile(
    jobId: string,
    status: JobStatusView,
    flush: boolean,
    manifest?: { readonly present: boolean; readonly value?: unknown },
  ): void {
    let persisted = status;
    if (manifest) {
      const { artifactFiles: _ignored, ...fields } = status;
      persisted = manifest.present
        ? { ...fields, artifactFiles: manifest.value } as JobStatusView
        : fields as JobStatusView;
    }
    this.measureWrite(jobId, "export.status.persist", "export.status-writes", () => {
      this.writeAtomic(this.statusPath(jobId), JSON.stringify({ formatVersion: 2, jobId, status: persisted }), flush);
    });
  }

  /** Measure only the actual atomic file write. The default/off path is the existing write directly. */
  private measureWrite(jobId: string, phase: string, countName: string, write: () => void): void {
    let exportSink: ExportPerformanceSink | undefined;
    try { exportSink = this.exportPerformanceSinkForJob?.(jobId); } catch { /* observational */ }
    let exportSinkEnabled = false;
    try { exportSinkEnabled = exportSink?.enabled === true; } catch { /* observational */ }
    if (exportSinkEnabled && exportSink) {
      const exportPhase = phase === "export.status.persist" ? "status.persist" : "write";
      withExportPerformance(exportSink, exportPhase, write);
      return;
    }

    const sink = getPerfSink();
    if (!sink.enabled) {
      write();
      return;
    }

    const context: PerfContext = {
      runId: sink.runId ?? "durable-task-ledger",
      operationId: jobId,
    };
    let span: PerfSpan | null = null;
    try {
      span = sink.begin(phase, context);
    } catch {
      // Instrumentation is observational; an unavailable span must not affect persistence.
    }
    try {
      write();
    } catch (error) {
      if (span) {
        try { sink.end(span, "error"); } catch { /* observational */ }
      }
      throw error;
    }
    if (span) {
      try { sink.end(span, "ok"); } catch { /* observational */ }
    }
    try { sink.count(countName, 1, context); } catch { /* observational */ }
  }

  begin(input: DurableTaskInput): void {
    if (this.records.has(input.jobId)) throw new Error(`Task already exists: ${input.jobId}`);
    if (input.inputProject.id !== input.projectId) throw new Error("Task input project does not match its target");
    const detached = JSON.parse(JSON.stringify(input)) as DurableTaskInput;
    const now = new Date().toISOString();
    const status: JobStatusView = {
      jobId: input.jobId, kind: input.kind, sourceRevision: input.sourceRevision,
      state: "queued", progress: null, artifact: null, result: null, error: null,
      artifactFiles: [],
      ownership: ownershipForTask(detached, { state: "queued", deliveredTo: null }),
      deliveredTo: null, deliveryError: null, route: null,
      upscalingRequestedButInactive: false, cancelRequested: false,
      createdAt: now, updatedAt: now,
    };
    this.writeInputFile(detached);
    this.writeStatusFile(input.jobId, status, true);
    this.records.set(input.jobId, { input: detached, status });
  }

  update(status: JobStatusView): void {
    const record = this.records.get(status.jobId);
    if (!record) throw new Error(`Unknown durable task: ${status.jobId}`);
    if (status.sourceRevision !== record.input.sourceRevision || status.kind !== record.input.kind ||
        !taskStates.has(status.state)) {
      throw new Error("Task status does not match its fixed input");
    }
    const previousState = record.status.state;
    const incomingArtifactFiles = Array.isArray(status.artifactFiles) ? status.artifactFiles : [];
    if (record.artifactFilesIntegrityError &&
        JSON.stringify(record.status.artifactFiles ?? []) !== JSON.stringify(incomingArtifactFiles)) {
      throw new Error("Cannot add tracked files while the persisted artifact file manifest is malformed");
    }
    const artifactFilesChanged = !record.artifactManifestMissing &&
      JSON.stringify(record.status.artifactFiles ?? []) !== JSON.stringify(incomingArtifactFiles);
    const { artifactFiles: _ignoredArtifactFiles, ...statusFields } = status;
    const persistedStatus: JobStatusView = {
      ...statusFields,
      ...(!record.artifactManifestMissing ? { artifactFiles: incomingArtifactFiles.map((file) => ({ ...file })) } : {}),
      ownership: ownershipForTask(record.input, status),
    };
    record.status = persistedStatus;
    // State transitions and terminal states are the load-bearing writes:
    // they flush synchronously BEFORE the caller exposes the transition. A
    // same-state progress tick is display-only and coalesces to one write
    // per interval (a trailing write always lands the latest value).
    if (status.state !== previousState || terminalStates.has(status.state) || artifactFilesChanged) {
      if (this.pendingProgress?.jobId === status.jobId) this.pendingProgress = null;
      this.writeStatusFile(status.jobId, persistedStatus, true, this.manifestPersistence(record));
      return;
    }
    this.pendingProgress = { jobId: status.jobId, status: persistedStatus };
    if (this.progressTimer === null) {
      this.progressTimer = setTimeout(() => {
        this.progressTimer = null;
        this.flushPendingProgress();
      }, this.progressWriteIntervalMs);
      this.progressTimer.unref?.();
    }
  }

  private flushPendingProgress(): void {
    const pending = this.pendingProgress;
    this.pendingProgress = null;
    if (!pending) return;
    const record = this.records.get(pending.jobId);
    if (!record || record.status !== pending.status) return; // superseded or removed
    try {
      this.writeStatusFile(pending.jobId, pending.status, false, this.manifestPersistence(record));
    } catch (error) {
      // Display-only loss: the next state-changing update writes synchronously
      // and will surface any real disk failure to the caller.
      console.warn(`[task-ledger] deferred progress write failed for ${pending.jobId}:`, error);
    }
  }

  /** Identity + revision without cloning the (potentially huge) input snapshot. */
  summary(jobId: string): DurableTaskSummary | null {
    const record = this.records.get(jobId);
    if (!record) return null;
    const { input } = record;
    return { jobId: input.jobId, kind: input.kind, projectId: input.projectId, workspaceId: input.workspaceId, sourceRevision: input.sourceRevision };
  }

  get(jobId: string): DurableTaskRecord | null {
    const record = this.records.get(jobId);
    if (!record) return null;
    return { ...structuredClone(record.input), formatVersion: 1, status: { ...record.status } };
  }

  getState(jobId: string): JobStatusView["state"] | null {
    return this.records.get(jobId)?.status.state ?? null;
  }

  /**
   * Composite records for the task list. Input snapshots are shared
   * references (callers never mutate them); statuses are fresh copies.
   */
  list(): DurableTaskRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record.input, formatVersion: 1 as const, status: { ...record.status },
    }));
  }

  listCleanupCandidates(target: CleanupCandidateTarget): CleanupCandidateSummary {
    const tasks: CleanupCandidateTask[] = [];
    const unknowns: string[] = [];
    let artifactScanReady = true;
    const quarantined = readdirSync(this.root).filter((name) => /\.json\.corrupt-/.test(name));
    if (quarantined.length > 0) {
      artifactScanReady = false;
      unknowns.push(`Quarantined task documents may retain unknown file references: ${quarantined.join(", ")}`);
    }
    for (const record of this.records.values()) {
      if (!record.artifactFilesIntegrityError) continue;
      artifactScanReady = false;
      unknowns.push(`${record.input.jobId}: ${record.artifactFilesIntegrityError} A damaged task manifest may reference files anywhere on disk.`);
    }
    for (const record of this.records.values()) {
      const { input, status } = record;
      if (input.projectId !== target.projectId || input.workspaceId !== target.workspaceId) continue;
      const files: CleanupCandidateFile[] = [];
      let retainedReason: string;
      if (status.state === "error" || status.state === "cancelled") {
        retainedReason = FAILED_RECORD_FILE_RETENTION_REASON;
        for (const filePath of [this.inputPath(input.jobId), this.statusPath(input.jobId)]) {
          const fingerprint = this.fileFingerprint(filePath, FAILED_RECORD_FILE_RETENTION_REASON);
          if (fingerprint) files.push(fingerprint);
          else unknowns.push(`${input.jobId}: task record file is missing or not a regular file; it was not offered for cleanup.`);
        }
        if (record.artifactManifestMissing) {
          unknowns.push(`${input.jobId}: this older failed task has no producer file manifest; unindexed outputs remain retained.`);
        }
      } else if (status.state === "done") {
        retainedReason = "Completed task and its outputs remain retained; this review only exposes failed task records for cleanup.";
      } else {
        retainedReason = "This task is active and cannot be purged.";
      }
      if (!status.ownership) unknowns.push(`${input.jobId}: this pre-existing task has no ownership metadata; none was inferred.`);
      if (record.artifactFilesIntegrityError) {
        artifactScanReady = false;
        unknowns.push(`${input.jobId}: ${record.artifactFilesIntegrityError} No tracked file from this target may be removed until it is repaired.`);
      }
      const artifactFiles: ProjectLibraryTrackedArtifactFile[] = [];
      for (const file of status.artifactFiles ?? []) {
        const inspected = this.inspectArtifactFile(file.path);
        if (!inspected.stats) {
          if (inspected.reason !== "Tracked file no longer exists.") {
            artifactScanReady = false;
            unknowns.push(`${input.jobId}/${file.fileId}: ${inspected.reason ?? "file is not available for review"}`);
          } else {
            unknowns.push(`${input.jobId}/${file.fileId}: tracked file is missing; it was not offered for cleanup.`);
          }
          continue;
        }
        const pathRetainedReason = this.findMemoryPathReference(file.path, input.jobId, file.fileId);
        const fileRetainedReason = status.state === "queued" || status.state === "running"
          ? "This task is active; its files are retained."
          : file.kind !== "work"
            ? `This ${file.kind} file is retained; only producer-registered work files can be removed.`
            : file.deliveryStatus === "delivered"
              ? "This work file is marked delivered and is retained."
              : pathRetainedReason ?? undefined;
        artifactFiles.push({
          ...file,
          path: path.resolve(file.path),
          sizeBytes: inspected.stats.size,
          lastModifiedMs: inspected.stats.mtimeMs,
          ...(fileRetainedReason ? { retainedReason: fileRetainedReason } : {}),
        });
      }
      tasks.push({
        jobId: input.jobId,
        kind: input.kind,
        sourceRevision: input.sourceRevision,
        state: status.state,
        ...(status.ownership ? { ownership: { ...status.ownership } } : {}),
        artifactFiles,
        files,
        retainedReason,
      });
    }
    return { tasks, unknowns: [...new Set(unknowns)], artifactScanReady };
  }

  purgeTrackedWorkFiles(input: ProjectLibraryPurgeTrackedWorkFilesRequest): ProjectLibraryPurgeTrackedWorkFilesResult {
    const expectedByJob = new Map<string, ProjectLibraryTrackedWorkFingerprint[]>();
    for (const expected of input.expectedFiles) {
      const files = expectedByJob.get(expected.jobId) ?? [];
      files.push(expected);
      expectedByJob.set(expected.jobId, files);
    }
    const deleted: ProjectLibraryTrackedWorkFingerprint[] = [];
    const skipped: { jobId: string; fileId: string; reason: string }[] = [];
    const failed: { jobId: string; fileId: string; reason: string }[] = [];
    let actualBytes = 0;

    if (readdirSync(this.root).some((name) => /\.json\.corrupt-/.test(name))) {
      return { actualBytes, deleted, failed, skipped: input.expectedFiles.map((file) => ({
        jobId: file.jobId, fileId: file.fileId, reason: "Quarantined task documents have unknown file references; removal is blocked.",
      })) };
    }

    const malformedManifest = [...this.records.values()].find((record) => record.artifactFilesIntegrityError);
    if (malformedManifest) {
      for (const expected of input.expectedFiles) {
        skipped.push({ jobId: expected.jobId, fileId: expected.fileId,
          reason: `Task ${malformedManifest.input.jobId} has a malformed artifact manifest; file removal is blocked until the manifest is reviewed.` });
      }
      return { actualBytes, deleted, skipped, failed };
    }

    for (const jobId of input.jobIds) {
      const expectedFiles = expectedByJob.get(jobId) ?? [];
      for (const expected of expectedFiles) {
        const record = this.records.get(jobId);
        if (!record || record.input.projectId !== input.projectId || record.input.workspaceId !== input.workspaceId) {
          skipped.push({ jobId, fileId: expected.fileId, reason: "Task does not belong to the requested project and workspace." });
          continue;
        }
        if (record.status.state === "queued" || record.status.state === "running") {
          skipped.push({ jobId, fileId: expected.fileId, reason: "Active task files cannot be removed." });
          continue;
        }
        const artifact = record.status.artifactFiles?.find((file) => file.fileId === expected.fileId);
        if (!artifact || artifact.kind !== "work" || artifact.deliveryStatus === "delivered" ||
            path.resolve(artifact.path) !== path.resolve(expected.path)) {
          skipped.push({ jobId, fileId: expected.fileId, reason: "The task no longer owns this exact eligible work file." });
          continue;
        }
        const inspected = this.inspectArtifactFile(artifact.path);
        if (!inspected.stats || inspected.stats.size !== expected.sizeBytes ||
            inspected.stats.mtimeMs !== expected.lastModifiedMs) {
          skipped.push({ jobId, fileId: expected.fileId, reason: inspected.reason ?? "File changed since review." });
          continue;
        }
        const memoryReferenceProblem = this.findMemoryPathReference(artifact.path, jobId, artifact.fileId);
        if (memoryReferenceProblem) {
          skipped.push({ jobId, fileId: expected.fileId, reason: memoryReferenceProblem });
          continue;
        }
        const referenceProblem = this.findDurableReferenceProblem(artifact.path, jobId, artifact.fileId);
        if (referenceProblem) {
          skipped.push({ jobId, fileId: expected.fileId, reason: referenceProblem });
          continue;
        }

        try {
          // Synchronous ledger operations serialize with task status updates.
          // Re-read status identity/state before unlinking, then remove exactly one file.
          const diskInput = JSON.parse(readFileSync(this.inputPath(jobId), "utf8")) as Partial<DurableTaskInput>;
          const diskStatus = JSON.parse(readFileSync(this.statusPath(jobId), "utf8")) as { jobId?: string; status?: JobStatusView };
          if (diskInput.jobId !== jobId || diskInput.projectId !== input.projectId || diskInput.workspaceId !== input.workspaceId ||
              diskStatus.jobId !== jobId || diskStatus.status?.jobId !== jobId ||
              diskStatus.status.kind !== record.status.kind || diskStatus.status.sourceRevision !== record.status.sourceRevision ||
              diskStatus.status.state !== record.status.state ||
              !diskStatus.status.artifactFiles?.some((file) => file.fileId === artifact.fileId &&
                file.path === artifact.path && file.kind === artifact.kind && file.purpose === artifact.purpose &&
                file.origin === artifact.origin && file.nodeId === artifact.nodeId &&
                file.rebuildable === artifact.rebuildable && file.deliveryStatus === "pending" &&
                file.deliveryStatus === artifact.deliveryStatus)) {
            skipped.push({ jobId, fileId: expected.fileId, reason: "Task identity or artifact ownership changed since review." });
            continue;
          }
          const finalReferenceProblem = this.findDurableReferenceProblem(artifact.path, jobId, artifact.fileId);
          if (finalReferenceProblem) {
            skipped.push({ jobId, fileId: expected.fileId, reason: finalReferenceProblem });
            continue;
          }
          const immediatelyBeforeDelete = this.inspectArtifactFile(artifact.path);
          if (!immediatelyBeforeDelete.stats || immediatelyBeforeDelete.stats.size !== expected.sizeBytes ||
              immediatelyBeforeDelete.stats.mtimeMs !== expected.lastModifiedMs) {
            skipped.push({ jobId, fileId: expected.fileId, reason: immediatelyBeforeDelete.reason ?? "File changed since review." });
            continue;
          }
          unlinkSync(artifact.path);
          actualBytes += immediatelyBeforeDelete.stats.size;
          deleted.push(expected);
          const updatedStatus: JobStatusView = {
            ...record.status,
            artifactFiles: (record.status.artifactFiles ?? []).filter((file) => file.fileId !== artifact.fileId),
            updatedAt: new Date().toISOString(),
          };
          record.status = updatedStatus;
          this.writeStatusFile(jobId, updatedStatus, true, this.manifestPersistence(record));
        } catch (error) {
          failed.push({ jobId, fileId: expected.fileId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (expectedFiles.length === 0) {
        skipped.push({ jobId, fileId: "", reason: "No exact file fingerprints were supplied for this task." });
      }
    }
    return { actualBytes, deleted, skipped, failed };
  }

  private inspectArtifactFile(filePath: string): { readonly stats: SafeArtifactFile | null; readonly reason?: string } {
    const absolute = path.resolve(filePath);
    for (const configuredRoot of this.artifactRoots) {
      let root: string;
      try { root = realpathSync(configuredRoot); } catch { continue; }
      const relative = path.relative(root, absolute);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      let current = root;
      const components = relative.split(path.sep);
      for (let index = 0; index < components.length; index++) {
        current = path.join(current, components[index]!);
        let stats;
        try { stats = lstatSync(current); } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return { stats: null, reason: "Tracked file no longer exists." };
          }
          const code = error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : "";
          return { stats: null, reason: `Tracked file could not be safely verified${code}; it is retained.` };
        }
        if (stats.isSymbolicLink()) return { stats: null, reason: "Tracked file path crosses a symbolic link and is retained." };
        const final = index === components.length - 1;
        if (final ? !stats.isFile() : !stats.isDirectory()) {
          return { stats: null, reason: "Tracked path is not a regular file inside its managed root." };
        }
        if (final) return { stats: { size: stats.size, mtimeMs: stats.mtimeMs } };
      }
    }
    return { stats: null, reason: "Tracked file is outside the configured managed roots and is retained." };
  }

  private findMemoryPathReference(filePath: string, ownJobId: string, ownFileId: string): string | null {
    const target = normalizedPathKey(filePath);
    for (const record of this.records.values()) {
      const jobId = record.input.jobId;
      if (hasAbsolutePathReference(record.input.inputProject, filePath)) {
        return jobId === ownJobId
          ? "This task's fixed project input references this exact path."
          : `Task ${jobId} fixed project input references this exact path.`;
      }
      for (const file of record.status.artifactFiles ?? []) {
        if (normalizedPathKey(file.path) !== target) continue;
        if (jobId !== ownJobId || file.fileId !== ownFileId) return `Task ${jobId} also tracks this exact path.`;
      }
      if (jobId !== ownJobId && hasAbsolutePathReference({ artifact: record.status.artifact, result: record.status.result }, filePath)) {
        return `Task ${jobId} result or artifact references this exact path.`;
      }
      if (jobId !== ownJobId && hasAbsolutePathReference(record.status.deliveredTo, filePath)) {
        return `Task ${jobId} delivered this exact path.`;
      }
      const parameters = record.input.parameters && typeof record.input.parameters === "object"
        ? record.input.parameters as Record<string, unknown>
        : null;
      if (jobId !== ownJobId && (record.status.state === "queued" || record.status.state === "running") &&
          hasAbsolutePathReference(parameters?.destinationPath, filePath)) {
        return `Active task ${jobId} targets this exact destination path.`;
      }
    }
    return null;
  }

  private findDurableReferenceProblem(filePath: string, ownJobId: string, ownFileId: string): string | null {
    const target = normalizedPathKey(filePath);
    for (const name of readdirSync(this.root)) {
      if (/\.json\.corrupt-/.test(name)) return "Quarantined task documents have unknown file references; removal is blocked.";
      if (!name.endsWith(".status.json")) continue;
      const statusPath = path.join(this.root, name);
      try {
        const document = JSON.parse(readFileSync(statusPath, "utf8")) as { jobId?: string; status?: JobStatusView };
        const jobId = document.jobId;
        if (!jobId || !/^[A-Za-z0-9_-]+$/.test(jobId) || name !== `${jobId}.status.json` || !document.status || document.status.jobId !== jobId) {
          return `Task status identity could not be verified; file removal is blocked.`;
        }
        const manifest = artifactFileManifest(document.status);
        if (manifest.integrityError) return `Task ${jobId} has a malformed artifact file manifest; file removal is blocked.`;
        if (jobId !== ownJobId && hasAbsolutePathReference({ artifact: document.status.artifact, result: document.status.result }, filePath)) {
          return `Task ${jobId} result or artifact references this exact path.`;
        }
        if (jobId !== ownJobId && hasAbsolutePathReference(document.status.deliveredTo, filePath)) {
          return `Task ${jobId} delivered this exact path.`;
        }
        for (const file of manifest.files) {
          if (normalizedPathKey(file.path) !== target) continue;
          if (jobId !== ownJobId || file.fileId !== ownFileId) {
            return `Task ${jobId} also references this exact path.`;
          }
        }
        const inputPath = this.inputPath(jobId);
        const input = JSON.parse(readFileSync(inputPath, "utf8")) as { inputProject?: unknown; parameters?: unknown };
        if (hasAbsolutePathReference(input.inputProject, filePath)) {
          return `Task ${jobId} fixed project input references this exact path.`;
        }
        const parameters = input.parameters && typeof input.parameters === "object"
          ? input.parameters as Record<string, unknown>
          : null;
        if (document.status.kind === "export" && (document.status.state === "queued" || document.status.state === "running") &&
            hasAbsolutePathReference(parameters?.destinationPath, filePath)) {
          return `Active export task ${jobId} targets this exact destination path.`;
        }
      } catch (error) {
        return `Task status or fixed input could not be verified (${error instanceof Error ? error.message : String(error)}); file removal is blocked.`;
      }
    }
    return null;
  }

  purgeFailedTaskRecords(input: PurgeFailedTaskRecordsInput): PurgeFailedTaskRecordsResult {
    const groupedFiles = new Map<string, FailedTaskRecordFingerprint[]>();
    for (const expected of input.expectedFiles) {
      const files = groupedFiles.get(expected.jobId) ?? [];
      files.push(expected);
      groupedFiles.set(expected.jobId, files);
    }

    const deleted: { jobId: string; files: string[] }[] = [];
    const skipped: { jobId: string; reason: string }[] = [];
    const failed: { jobId: string; reason: string }[] = [];
    let actualBytes = 0;

    for (const jobId of input.jobIds) {
      const record = this.records.get(jobId);
      if (!record || record.input.projectId !== input.projectId || record.input.workspaceId !== input.workspaceId) {
        skipped.push({ jobId, reason: "Task does not belong to the requested project and workspace." });
        continue;
      }
      if (record.artifactFilesIntegrityError || record.artifactManifestMissing) {
        skipped.push({ jobId, reason: "This task has no trustworthy producer file manifest; preserve its task record as cleanup evidence." });
        continue;
      }
      if (record.status.state !== "error" && record.status.state !== "cancelled") {
        skipped.push({ jobId, reason: "Only failed or cancelled tasks can have their ledger records removed." });
        continue;
      }
      const retainedArtifact = (record.status.artifactFiles ?? []).find((file) => {
        const inspected = this.inspectArtifactFile(file.path);
        return inspected.stats !== null || inspected.reason !== "Tracked file no longer exists.";
      });
      if (retainedArtifact) {
        skipped.push({ jobId, reason: "Tracked artifact files still exist; clean eligible work files first and review the task again." });
        continue;
      }

      const inputFile = path.resolve(this.inputPath(jobId));
      const statusFile = path.resolve(this.statusPath(jobId));
      const expected = groupedFiles.get(jobId) ?? [];
      const expectedByPath = new Map(expected.map(file => [file.path, file]));
      if (expected.length !== 2 || expectedByPath.size !== 2 ||
          !expectedByPath.has(inputFile) || !expectedByPath.has(statusFile)) {
        skipped.push({ jobId, reason: "The expected task-record fingerprints are incomplete or do not match this ledger." });
        continue;
      }

      const inputFingerprint = expectedByPath.get(inputFile)!;
      const statusFingerprint = expectedByPath.get(statusFile)!;
      try {
        const inputStats = this.matchingRecordFile(inputFile, inputFingerprint);
        const statusStats = this.matchingRecordFile(statusFile, statusFingerprint);
        const inputDoc = JSON.parse(readFileSync(inputFile, "utf8")) as Partial<DurableTaskInput> & { formatVersion?: number };
        const statusDoc = JSON.parse(readFileSync(statusFile, "utf8")) as {
          formatVersion?: number;
          jobId?: string;
          status?: JobStatusView;
        };
        const diskStatus = statusDoc.status;
        const targetStillMatches = inputDoc.jobId === jobId && inputDoc.projectId === input.projectId &&
          inputDoc.workspaceId === input.workspaceId && inputDoc.kind === record.input.kind &&
          inputDoc.sourceRevision === record.input.sourceRevision &&
          (inputDoc.formatVersion === 1 || inputDoc.formatVersion === 2);
        const terminalStatusMatches = statusDoc.formatVersion === 2 && statusDoc.jobId === jobId &&
          diskStatus?.jobId === jobId && diskStatus.kind === record.input.kind &&
          diskStatus.sourceRevision === record.input.sourceRevision &&
          (diskStatus.state === "error" || diskStatus.state === "cancelled") &&
          diskStatus.state === record.status.state;
        if (!targetStillMatches || !terminalStatusMatches) {
          skipped.push({ jobId, reason: "The persisted task identity or terminal state changed since review." });
          continue;
        }
        const diskManifest = artifactFileManifest(diskStatus);
        if (diskManifest.integrityError || diskManifest.missing) {
          skipped.push({ jobId, reason: "The persisted artifact file manifest is missing or malformed; task evidence was retained." });
          continue;
        }
        const diskArtifact = diskManifest.files.find((file) => {
          const inspected = this.inspectArtifactFile(file.path);
          return inspected.stats !== null || inspected.reason !== "Tracked file no longer exists.";
        });
        if (diskArtifact) {
          skipped.push({ jobId, reason: "Tracked artifact files still exist on disk; clean eligible work files first and review the task again." });
          continue;
        }

        // Recheck the compare-and-swap fingerprints immediately before removal.
        this.matchingRecordFile(inputFile, inputFingerprint);
        this.matchingRecordFile(statusFile, statusFingerprint);
        let removedStatus = false;
        try {
          // Remove the smaller status first. If removing the input then fails,
          // the retained fixed input can still be paired with a re-persisted
          // status and stays visible for another review.
          this.unlinkRecordFile(statusFile);
          removedStatus = true;
          this.unlinkRecordFile(inputFile);
        } catch (error) {
          if (removedStatus) {
            try {
              this.writeStatusFile(jobId, record.status, true);
              removedStatus = false;
            } catch (restoreError) {
              const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
              throw new Error(`input record removal failed and status restoration failed: ${restoreMessage}`);
            }
          }
          throw error;
        }
        actualBytes += inputStats.size + statusStats.size;
        this.records.delete(jobId);
        if (this.pendingProgress?.jobId === jobId) this.pendingProgress = null;
        deleted.push({ jobId, files: [inputFile, statusFile] });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "Task record file changed since review") {
          skipped.push({ jobId, reason });
        } else {
          failed.push({ jobId, reason: `Task record removal failed: ${reason}` });
        }
      }
    }
    return { actualBytes, deleted, skipped, failed };
  }

  private fileFingerprint(filePath: string, retainedReason: string): CleanupCandidateFile | null {
    try {
      const stats = lstatSync(filePath);
      if (!stats.isFile()) return null;
      return {
        path: path.resolve(filePath),
        sizeBytes: stats.size,
        lastModifiedMs: stats.mtimeMs,
        retainedReason,
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private matchingRecordFile(filePath: string, expected: FailedTaskRecordFingerprint) {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || expected.path !== path.resolve(filePath) ||
        expected.sizeBytes !== stats.size || expected.lastModifiedMs !== stats.mtimeMs) {
      throw new Error("Task record file changed since review");
    }
    return stats;
  }
}
