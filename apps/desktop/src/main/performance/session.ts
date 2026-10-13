/**
 * Main-process performance session manager (design phase P1).
 *
 * One session at a time, coordinating:
 * - the renderer capture (started/stopped through the preload bridge's
 *   invoke channels — the renderer owns its own ring buffer and report);
 * - a bounded main-process event sink for main-local live IPC spans;
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
import { getPerfSink, NOOP_SINK, resolvePerfBudgets, setPerfSink } from "@reelterminal/core";
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
  PerfMainCaptureReport,
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
import { MainPerformanceCapture } from "./main-capture";

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
  captureTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  stoppedUs?: number;
  mainCaptureReport?: PerfMainCaptureReport;
  processSamples?: readonly PerfProcessSampleSummary[];
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
  private mainCapture: MainPerformanceCapture | null = null;

  constructor(deps: PerformanceSessionDeps) {
    this.deps = deps;
  }

  get active(): ActiveSessionInfo | null {
    return this.session && this.session.stoppedUs === undefined
      ? { runId: this.session.runId, mode: this.session.mode, startedUs: this.session.startedUs }
      : null;
  }

  get lastClockEstimate(): ClockSyncResult | null {
    return this.lastEstimate;
  }

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
    this.abortActiveSession();
  }

  /** Release bounded capture state when the renderer reloads, exits or crashes. */
  abortActiveSession(): void {
    this.cancelClockSynchronizer();
    const session = this.session;
    if (!session) return;
    if (session.stoppedUs === undefined) {
      this.finishCapture(session, this.deps.nowUs());
    } else {
      this.clearSessionTimers(session);
    }
    this.session = null;
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
    if (this.synchronizer === synchronizer) this.lastEstimate = result;
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
    if (getPerfSink() !== NOOP_SINK) return { ok: false, error: "sink_slot_occupied" };
    const runId = request.runId ?? generateRunId();
    this.lastEstimate = null;
    const startedUs = this.deps.nowUs();
    const sampler =
      this.deps.processMetricsSource != null
        ? new ProcessSampler(this.deps.processMetricsSource, { nowUs: this.deps.nowUs })
        : null;
    const session: ActiveSession = {
      runId,
      mode: request.mode,
      startedUs,
      sampler,
      captureTimer: null,
      cleanupTimer: null,
    };
    this.session = session;
    const mainCapture = new MainPerformanceCapture(runId, request.mode, startedUs, this.deps.nowUs);
    this.mainCapture = mainCapture;
    setPerfSink(mainCapture);
    sampler?.start();
    let clock: PerfClockEstimateSummary | null = null;
    const captureSeconds = resolvePerfBudgets(request.mode, request.budgets).captureSeconds;
    try {
      const remainingMs = Math.max(
        0,
        captureSeconds * 1_000 - (this.deps.nowUs() - startedUs) / 1_000,
      );
      session.captureTimer = setTimeout(() => this.expireCapture(session), remainingMs);
      if (request.runClockHandshake) {
        // A failed handshake degrades to valid:false, it never blocks.
        const result = await this.runClockHandshake();
        clock = summarizeEstimate(result);
      }
      const expired =
        this.session !== session ||
        session.stoppedUs !== undefined ||
        this.deps.nowUs() - startedUs >= captureSeconds * 1_000_000;
      if (expired) {
        if (this.session === session) this.abortActiveSession();
        return { ok: false, error: "capture_expired" };
      }
    } catch {
      if (this.session === session) this.abortActiveSession();
      return { ok: false, error: "internal_error" };
    }
    return { ok: true, runId, clock };
  }

  private async handleStop(request: PerfStopRequest): Promise<PerfStopReply> {
    const session = this.session;
    if (!session) return { ok: false, error: "no_active_session" };
    if (request.runId !== session.runId) return { ok: false, error: "invalid_request" };
    if (session.stoppedUs === undefined) {
      this.finishCapture(session, this.deps.nowUs());
    } else {
      this.clearSessionTimers(session);
    }
    this.session = null;
    const stoppedUs = session.stoppedUs as number;
    const processSamples = session.processSamples ?? (session.sampler ? session.sampler.samples : []);
    return {
      ok: true,
      runId: session.runId,
      sessionDurationUs: stoppedUs - session.startedUs,
      clock: this.lastEstimate ? summarizeEstimate(this.lastEstimate) : null,
      processSamples,
      mainCapture: session.mainCaptureReport
        ? session.mainCaptureReport
        : {
            runId: session.runId,
            mode: session.mode,
            clockId: "unavailable",
            processEpoch: "unavailable",
            startedUs: session.startedUs,
            stoppedUs,
            status: "incomplete",
            events: [],
            counters: {},
            eventsDropped: 0,
            labelsDropped: 0,
            spansDropped: 0,
            truncatedFields: 0,
            collectorErrors: 0,
            openSpans: 0,
            reasonCodes: ["main_capture_unavailable"],
          },
    };
  }

  private finishCapture(session: ActiveSession, stoppedUs: number, reasonCode?: string): void {
    this.cancelClockSynchronizer();
    this.clearSessionTimers(session);
    session.sampler?.stop();
    session.stoppedUs = stoppedUs;
    session.processSamples = session.sampler ? session.sampler.samples : [];
    const mainCapture = this.mainCapture;
    this.mainCapture = null;
    if (mainCapture) {
      if (getPerfSink() === mainCapture) setPerfSink(null);
      session.mainCaptureReport = mainCapture.finish(
        stoppedUs,
        reasonCode === undefined ? [] : [reasonCode],
      );
    }
  }

  private clearSessionTimers(session: ActiveSession): void {
    if (session.captureTimer !== null) {
      clearTimeout(session.captureTimer);
      session.captureTimer = null;
    }
    if (session.cleanupTimer !== null) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
  }

  private expireCapture(session: ActiveSession): void {
    if (this.session !== session || session.stoppedUs !== undefined) return;
    this.finishCapture(session, this.deps.nowUs(), "main_capture_budget_exceeded");
    session.cleanupTimer = setTimeout(() => {
      if (this.session === session && session.stoppedUs !== undefined) this.session = null;
    }, 30_000);
  }

  private cancelClockSynchronizer(): void {
    const synchronizer = this.synchronizer;
    this.synchronizer = null;
    synchronizer?.cancel();
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
