import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPerfSink, type PerfContext, type PerfSpan } from "@reelterminal/core";
import type { Project } from "@reelterminal/core";
import type { JobStatusView } from "@reelterminal/agent-facade";
import {
  withExportPerformance,
  type ExportPerformanceSink,
} from "@reelterminal/runtime-chromium";

export interface DurableTaskInput {
  readonly jobId: string;
  readonly kind: "export" | "analysis";
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
  private readonly progressWriteIntervalMs: number;
  private readonly onInputWrite?: (jobId: string) => void;
  private readonly exportPerformanceSinkForJob?: (jobId: string) => ExportPerformanceSink | undefined;
  private readonly records = new Map<string, InternalRecord>();
  private pendingProgress: { jobId: string; status: JobStatusView } | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string, options: {
    progressWriteIntervalMs?: number;
    /** Test observation at the actual immutable-input write boundary. */
    onInputWrite?: (jobId: string) => void;
    /** Optional local collector used by deterministic export regression scenarios. */
    exportPerformanceSinkForJob?: (jobId: string) => ExportPerformanceSink | undefined;
  } = {}) {
    this.root = root;
    this.progressWriteIntervalMs = options.progressWriteIntervalMs ?? PROGRESS_WRITE_INTERVAL_MS;
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
      const status = loaded && terminalStates.has(loaded.state)
        ? loaded
        : this.interruptedStatus(input, loaded);
      this.records.set(jobId, { input, status });
      // Persist when the status changed (restart honesty) or when it only
      // exists in memory so far (v1 legacy migration / synthesized status).
      if (loaded !== status || !statusesFromFile.has(jobId)) this.writeStatusFile(jobId, status, true);
    }
  }

  private loadStatusFile(root: string, file: string, statuses: Map<string, JobStatusView>, statusesFromFile: Set<string>): void {
    const jobId = file.slice(0, -".status.json".length);
    try {
      const doc = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { formatVersion?: number; jobId?: string; status?: JobStatusView };
      if (doc.formatVersion !== 2 || doc.jobId !== jobId || !doc.status ||
          doc.status.jobId !== jobId || (doc.status.kind !== "export" && doc.status.kind !== "analysis") ||
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
          (record.kind !== "export" && record.kind !== "analysis") ||
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
      deliveredTo: null, deliveryError: null,
      error: { code: "INTERRUPTED", message: "Desktop restarted before this task completed. Its fixed input is retained; start a new task to retry." },
      route: null, upscalingRequestedButInactive: false, cancelRequested: false,
      createdAt: loaded?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  private validId(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid task ID");
    return jobId;
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

  private writeStatusFile(jobId: string, status: JobStatusView, flush: boolean): void {
    this.measureWrite(jobId, "export.status.persist", "export.status-writes", () => {
      this.writeAtomic(this.statusPath(jobId), JSON.stringify({ formatVersion: 2, jobId, status }), flush);
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
    record.status = status;
    // State transitions and terminal states are the load-bearing writes:
    // they flush synchronously BEFORE the caller exposes the transition. A
    // same-state progress tick is display-only and coalesces to one write
    // per interval (a trailing write always lands the latest value).
    if (status.state !== previousState || terminalStates.has(status.state)) {
      if (this.pendingProgress?.jobId === status.jobId) this.pendingProgress = null;
      this.writeStatusFile(status.jobId, status, true);
      return;
    }
    this.pendingProgress = { jobId: status.jobId, status };
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
      this.writeStatusFile(pending.jobId, pending.status, false);
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
}
