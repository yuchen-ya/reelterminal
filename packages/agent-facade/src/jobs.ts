/**
 * Facade-owned job registry (audit/facade-v0.md contract #4, ADR 0002 #6).
 *
 * Jobs are long-running runtime operations (video export in this slice).
 * The facade owns the state machine and the idempotency semantics; the
 * provider only reports transitions through callbacks. States:
 *
 *   queued ──▶ running ──▶ done
 *     │           │
 *     │           ├──▶ error
 *     │           └──▶ cancelled
 *     └──▶ cancelled
 *
 * A job that fails or is cancelled NEVER carries an artifact — providers
 * write to a temporary name and only publish a completed file, so no
 * success-looking artifact can survive a non-done state.
 */
import type { ArtifactRef, ExportProgressEvent } from "./providers";
import type { AnalysisJobResult, JobStatusView } from "./types";

/** The public job.status view of a registry record (a fresh copy). */
export function jobStatusView(job: JobRecord): JobStatusView {
  return {
    jobId: job.jobId,
    kind: job.kind,
    state: job.state,
    progress: job.progress ? { ...job.progress } : null,
    artifact: job.artifact ? { ...job.artifact } : null,
    result: job.result ? structuredClone(job.result) : null,
    error: job.error ? { ...job.error } : null,
    deliveredTo: job.deliveredTo,
    deliveryError: job.deliveryError,
    sourceRevision: job.sourceRevision,
    route: job.route,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export const JOB_STATES = ["queued", "running", "done", "error", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobProgressView {
  readonly phase: ExportProgressEvent["phase"];
  readonly percent: number;
  readonly currentFrame?: number;
  readonly totalFrames?: number;
  readonly bytesWritten?: number;
}

export interface JobRecord {
  readonly jobId: string;
  readonly kind: "export" | "analysis";
  readonly state: JobState;
  readonly progress: JobProgressView | null;
  readonly artifact: ArtifactRef | null;
  readonly result: AnalysisJobResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** destinationPath delivery outcome (both null when none was requested). */
  readonly deliveredTo: string | null;
  readonly deliveryError: string | null;
  /** Project revision snapshot the job exports. */
  readonly sourceRevision: number;
  /** Export route reported on completion (null until done). */
  readonly route: string | null;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type JobTerminalState = "done" | "error" | "cancelled";

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "error", "cancelled"]);

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

  create(
    jobId: string,
    sourceRevision: number,
    kind: JobRecord["kind"] = "export",
  ): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      jobId,
      kind,
      state: "queued",
      progress: null,
      artifact: null,
      result: null,
      error: null,
      deliveredTo: null,
      deliveryError: null,
      sourceRevision,
      route: null,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, record);
    return record;
  }

  get(jobId: string): JobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** All records (insertion order) — used by session dispose to cancel live jobs. */
  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  isTerminal(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job !== undefined && TERMINAL.has(job.state);
  }

  markCancelRequested(jobId: string): JobRecord | null {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL.has(job.state)) return job ?? null;
    this.jobs.set(jobId, { ...job, cancelRequested: true, updatedAt: new Date().toISOString() });
    return this.jobs.get(jobId) ?? null;
  }

  markRunning(jobId: string): void {
    this.transition(jobId, (job) =>
      job.state === "queued" ? { ...job, state: "running" as JobState } : job,
    );
  }

  markProgress(jobId: string, event: ExportProgressEvent): void {
    this.transition(jobId, (job) => {
      if (job.state !== "running" && job.state !== "queued") return job;
      return {
        ...job,
        state: "running" as JobState,
        progress: {
          phase: event.phase,
          percent: event.percent,
          ...(event.currentFrame !== undefined ? { currentFrame: event.currentFrame } : {}),
          ...(event.totalFrames !== undefined ? { totalFrames: event.totalFrames } : {}),
          ...(event.bytesWritten !== undefined ? { bytesWritten: event.bytesWritten } : {}),
        },
      };
    });
  }

  markDone(jobId: string, artifact: ArtifactRef, route: string): void {
    this.transition(jobId, (job) => {
      if (TERMINAL.has(job.state)) return job;
      return { ...job, state: "done" as JobState, artifact, route, error: null };
    });
  }

  markAnalysisDone(jobId: string, result: AnalysisJobResult): void {
    this.transition(jobId, (job) => {
      if (TERMINAL.has(job.state)) return job;
      return {
        ...job,
        state: "done" as JobState,
        result: structuredClone(result),
        artifact: null,
        route: "built-in-technical-quality",
        error: null,
      };
    });
  }

  /** destinationPath copy succeeded (post-done bookkeeping only). */
  markDelivered(jobId: string, deliveredTo: string): void {
    this.transition(jobId, (job) =>
      job.state === "done" ? { ...job, deliveredTo, deliveryError: null } : job,
    );
  }

  /**
   * destinationPath copy failed. The artifact itself is valid, so the job
   * stays "done" — the failure is reported on deliveryError, never by
   * hiding the artifact or faking a job error.
   */
  markDeliveryFailed(jobId: string, message: string): void {
    this.transition(jobId, (job) =>
      job.state === "done" ? { ...job, deliveryError: message } : job,
    );
  }

  markError(jobId: string, error: { code: string; message: string }): void {
    this.transition(jobId, (job) => {
      if (TERMINAL.has(job.state)) return job;
      // A failed job never exposes an artifact, even a partial one.
      return { ...job, state: "error" as JobState, error, artifact: null, result: null };
    });
  }

  markCancelled(jobId: string): void {
    this.transition(jobId, (job) => {
      if (TERMINAL.has(job.state)) return job;
      return { ...job, state: "cancelled" as JobState, artifact: null, result: null };
    });
  }

  private transition(jobId: string, fn: (job: JobRecord) => JobRecord): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const next = fn(job);
    if (next !== job) {
      this.jobs.set(jobId, { ...next, updatedAt: new Date().toISOString() });
    }
  }
}
