/**
 * Main-process performance session manager (design phase P1).
 *
 * One session at a time, coordinating:
 * - the renderer capture (started/stopped through the preload bridge's
 *   invoke channels — the renderer owns its own ring buffer and report);
 * - the cross-process clock handshake (initiated by main over the ping/pong
 *   channels; late pongs from earlier attempts are dropped by the
 *   synchronizer);
 * - low-frequency process sampling while a session is active.
 *
 * A failed handshake never blocks a session: the reply simply carries a
 * clock summary with valid=false and cross-process metrics stay
 * "unavailable". install()/uninstall() are symmetric — every registered
 * handler and listener is removed, and uninstalling while a session is
 * active discards it (the renderer keeps running; its own stop will be
 * answered with no_active_session).
 */
import { randomBytes } from "node:crypto";
import {
  PERFORMANCE_IPC,
  isPerfClockPong,
  isPerfStartRequest,
  isPerfStopRequest,
} from "../../shared/performance-contract";
import type {
  PerfClockEstimateSummary,
  PerfClockPing,
  PerfClockPong,
  PerfProcessSampleSummary,
  PerfSessionMode,
  PerfStartReply,
  PerfStartRequest,
  PerfStopReply,
  PerfStopRequest,
} from "../../shared/performance-contract";
import {
  ClockSynchronizer,
  crossProcessDuration,
  type ClockOffsetEstimate,
  type ClockSyncOptions,
  type ClockSyncResult,
  type CrossProcessDuration,
  type CrossProcessOptions,
  type TimestampRef,
} from "./clock-sync";
import { ProcessSampler, type ProcessMetricsSource } from "./process-sampler";

export interface PerformanceSessionIpc {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown>): () => void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface PerformanceSessionDeps {
  /** Main-process monotonic clock (relative to process start, us). */
  nowUs(): number;
  /** Send to the renderer window (webContents.send). */
  send(channel: string, payload: unknown): void;
  ipc: PerformanceSessionIpc;
  processMetricsSource?: ProcessMetricsSource | null;
  sleep?: (ms: number) => Promise<void>;
  /** Clock handshake tuning (attempts/timeouts); defaults suit production. */
  clockSyncOptions?: ClockSyncOptions;
}

export interface ActiveSessionInfo {
  readonly runId: string;
  readonly mode: PerfSessionMode;
  readonly startedUs: number;
}

interface ActiveSession extends ActiveSessionInfo {
  sampler: ProcessSampler | null;
}

function generateRunId(): string {
  return `main-run-${randomBytes(8).toString("hex")}`;
}

export class PerformanceSessionManager {
  private readonly deps: PerformanceSessionDeps;
  private session: ActiveSession | null = null;
  private uninstalls: Array<() => void> = [];
  private lastEstimate: ClockSyncResult | null = null;
  private synchronizer: ClockSynchronizer | null = null;

  constructor(deps: PerformanceSessionDeps) {
    this.deps = deps;
  }

  get active(): ActiveSessionInfo | null {
    return this.session
      ? { runId: this.session.runId, mode: this.session.mode, startedUs: this.session.startedUs }
      : null;
  }

  get lastClockEstimate(): ClockSyncResult | null {
    return this.lastEstimate;
  }

  /**
   * The renderer capture report received with the last successful stop —
   * already sanitized renderer-side; main persists it via the artifact
   * writer (P2 wiring).
   */
  get lastRendererReport(): unknown {
    return this.lastRendererReportValue;
  }

  private lastRendererReportValue: unknown = null;

  install(): void {
    if (this.uninstalls.length > 0) return;
    this.uninstalls.push(
      this.deps.ipc.handle(PERFORMANCE_IPC.start, async (payload) =>
        isPerfStartRequest(payload) ? this.handleStart(payload) : invalidRequest(),
      ),
      this.deps.ipc.handle(PERFORMANCE_IPC.stop, async (payload) =>
        isPerfStopRequest(payload) ? this.handleStop(payload) : invalidRequest(),
      ),
    );
  }

  uninstall(): void {
    for (const uninstall of this.uninstalls) uninstall();
    this.uninstalls = [];
    this.synchronizer = null;
    if (this.session) {
      this.session.sampler?.stop();
      this.session = null;
    }
  }

  async runClockHandshake(): Promise<ClockSyncResult> {
    if (this.synchronizer?.isRunning) {
      throw new Error("performance-session: handshake already running");
    }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const synchronizer = new ClockSynchronizer(
      {
        nowUs: () => this.deps.nowUs(),
        sendPing: (ping: PerfClockPing) => this.deps.send(PERFORMANCE_IPC.clockPing, ping),
        onPong: (callback: (pong: PerfClockPong) => void) =>
          this.deps.ipc.on(PERFORMANCE_IPC.clockPong, (payload) => {
            // Only validated pongs reach the estimator; anything else is
            // dropped rather than parsed leniently.
            if (isPerfClockPong(payload)) callback(payload);
          }),
        delay: sleep,
      },
      this.deps.clockSyncOptions,
    );
    this.synchronizer = synchronizer;
    const result = await synchronizer.runHandshake();
    this.lastEstimate = result;
    return result;
  }

  /** Cross-process difference with all the honesty guards of clock-sync. */
  crossProcessDuration(
    start: TimestampRef,
    end: TimestampRef,
    options?: CrossProcessOptions,
  ): CrossProcessDuration {
    return crossProcessDuration(start, end, this.lastEstimate, options);
  }

  private async handleStart(request: PerfStartRequest): Promise<PerfStartReply> {
    if (this.session) return { ok: false, error: "session_already_active" };
    const runId = request.runId ?? generateRunId();
    const sampler =
      this.deps.processMetricsSource != null
        ? new ProcessSampler(this.deps.processMetricsSource, { nowUs: this.deps.nowUs })
        : null;
    this.session = { runId, mode: request.mode, startedUs: this.deps.nowUs(), sampler };
    sampler?.start();
    let clock: PerfClockEstimateSummary | null = null;
    if (request.runClockHandshake) {
      // A failed handshake degrades to valid:false, it never blocks.
      const result = await this.runClockHandshake();
      clock = summarizeEstimate(result);
    }
    return { ok: true, runId, clock };
  }

  private async handleStop(request: PerfStopRequest): Promise<PerfStopReply> {
    const session = this.session;
    if (!session) return { ok: false, error: "no_active_session" };
    if (request.runId !== session.runId) return { ok: false, error: "invalid_request" };
    this.session = null;
    session.sampler?.stop();
    if (request.rendererReport !== undefined) {
      this.lastRendererReportValue = request.rendererReport;
    }
    const processSamples: readonly PerfProcessSampleSummary[] = session.sampler
      ? session.sampler.samples
      : [];
    return {
      ok: true,
      runId: session.runId,
      sessionDurationUs: this.deps.nowUs() - session.startedUs,
      clock: this.lastEstimate ? summarizeEstimate(this.lastEstimate) : null,
      processSamples,
    };
  }
}

function invalidRequest(): { ok: false; error: "invalid_request" } {
  return { ok: false, error: "invalid_request" };
}

export function summarizeEstimate(
  estimate: ClockOffsetEstimate | null,
): PerfClockEstimateSummary | null {
  if (!estimate) return null;
  return {
    valid: estimate.valid,
    offsetUs: estimate.offsetUs,
    uncertaintyUs: estimate.uncertaintyUs,
    sampleCount: estimate.sampleCount,
  };
}
