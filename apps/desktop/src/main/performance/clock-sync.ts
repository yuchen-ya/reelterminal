/**
 * Cross-process clock estimation for the main process (design phase P1).
 *
 * The renderer clock (performance.now-based) and the main clock
 * (process.hrtime-based) are never compared directly. The main process runs
 * a ping/pong handshake (>= 7 exchanges by default) and derives an offset
 * estimate with an honest uncertainty:
 *
 *   per exchange m0 --(main→renderer)--> r1, r2 --(renderer→main)--> m3
 *   offset (main minus renderer) = ((m0 + m3) - (r1 + r2)) / 2
 *   causal interval              = [m0 - r1, m3 - r2]
 *   transport delay              = (m3 - m0) - (r2 - r1)
 *
 * The chosen sample is the one with the smallest transport delay; the
 * uncertainty covers its causal half-width, the spread between sample
 * midpoints (asymmetric routing), the clock resolution and drift since the
 * estimate. A cross-process difference whose magnitude does not exceed its
 * uncertainty is "indeterminate" and must not gate anything.
 */
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  type PerfClockPing,
  type PerfClockPong,
} from "../../shared/performance-contract";

export interface ClockHandshakeSample {
  readonly attempt: number;
  readonly m0Us: number;
  readonly r1Us: number;
  readonly r2Us: number;
  readonly m3Us: number;
}

export type ClockEstimateInvalidReason = "insufficient_samples" | "no_valid_samples" | null;

export interface ClockOffsetEstimate {
  readonly valid: boolean;
  readonly invalidReason: ClockEstimateInvalidReason;
  readonly sampleCount: number;
  readonly validSampleCount: number;
  readonly chosenAttempt: number | null;
  /** main minus renderer; only meaningful when valid. */
  readonly offsetUs: number | null;
  readonly uncertaintyUs: number | null;
  readonly transportDelayUs: number | null;
  readonly intersectionLowerUs: number | null;
  readonly intersectionUpperUs: number | null;
  /** Main-clock time the estimate was taken at (set by the synchronizer). */
  readonly estimatedAtUs: number | null;
  readonly samples: readonly ClockHandshakeSample[];
}

export interface EstimateOptions {
  /** Minimum number of valid samples (design: at least 7 pings). */
  readonly minSamples?: number;
  /** Combined clock quantization of both clocks, microseconds. */
  readonly clockResolutionUs?: number;
  /** Clock drift allowance, microseconds per second (default 50 ppm). */
  readonly driftPpm?: number;
  /** Age since the estimate when computing drift, microseconds. */
  readonly ageUs?: number;
}

export const DEFAULT_MIN_HANDSHAKE_SAMPLES = 7;
const DEFAULT_CLOCK_RESOLUTION_US = 50;
const DEFAULT_DRIFT_PPM = 50;

export function estimateClockOffset(
  samples: readonly ClockHandshakeSample[],
  options: EstimateOptions = {},
): ClockOffsetEstimate {
  const minSamples = options.minSamples ?? DEFAULT_MIN_HANDSHAKE_SAMPLES;
  const resolution = options.clockResolutionUs ?? DEFAULT_CLOCK_RESOLUTION_US;
  const driftPpm = options.driftPpm ?? DEFAULT_DRIFT_PPM;
  const ageUs = options.ageUs ?? 0;
  const tolerance = resolution * 2;

  const valid = samples.filter((sample) => {
    if (sample.m3Us < sample.m0Us - tolerance) return false;
    if (sample.r2Us < sample.r1Us - tolerance) return false;
    const delay = sample.m3Us - sample.m0Us - (sample.r2Us - sample.r1Us);
    return delay >= -tolerance;
  });

  const invalid: ClockOffsetEstimate = {
    valid: false,
    invalidReason: valid.length === 0 ? "no_valid_samples" : "insufficient_samples",
    sampleCount: samples.length,
    validSampleCount: valid.length,
    chosenAttempt: null,
    offsetUs: null,
    uncertaintyUs: null,
    transportDelayUs: null,
    intersectionLowerUs: null,
    intersectionUpperUs: null,
    estimatedAtUs: null,
    samples,
  };
  if (valid.length < minSamples) return invalid;

  const mids: number[] = [];
  const lowers: number[] = [];
  const uppers: number[] = [];
  let chosen: { sample: ClockHandshakeSample; delay: number; mid: number } | null = null;
  for (const sample of valid) {
    const lower = sample.m0Us - sample.r1Us;
    const upper = sample.m3Us - sample.r2Us;
    const mid = (lower + upper) / 2;
    const delay = sample.m3Us - sample.m0Us - (sample.r2Us - sample.r1Us);
    mids.push(mid);
    lowers.push(lower);
    uppers.push(upper);
    if (chosen === null || delay < chosen.delay) chosen = { sample, delay, mid };
  }
  if (chosen === null) return invalid;

  const spread = Math.max(...mids) - Math.min(...mids);
  const driftAllowance = (driftPpm / 1_000_000) * ageUs;
  const uncertainty = Math.max(chosen.delay / 2, spread / 2) + resolution + driftAllowance;

  return {
    valid: true,
    invalidReason: null,
    sampleCount: samples.length,
    validSampleCount: valid.length,
    chosenAttempt: chosen.sample.attempt,
    offsetUs: Math.round(chosen.mid),
    uncertaintyUs: Math.round(uncertainty),
    transportDelayUs: Math.round(chosen.delay),
    intersectionLowerUs: Math.round(Math.max(...lowers)),
    intersectionUpperUs: Math.round(Math.min(...uppers)),
    estimatedAtUs: null,
    samples,
  };
}

// ---------------------------------------------------------------------------
// Conversions and guarded cross-process durations
// ---------------------------------------------------------------------------

export interface ConvertedTimestamp {
  readonly mainTsUs: number;
  readonly uncertaintyUs: number;
}

/** Convert a renderer-clock timestamp into the main clock. */
export function convertRendererTimestamp(
  rendererTsUs: number,
  estimate: ClockOffsetEstimate,
): ConvertedTimestamp | null {
  if (!estimate.valid || estimate.offsetUs === null || estimate.uncertaintyUs === null) {
    return null;
  }
  return {
    mainTsUs: rendererTsUs + estimate.offsetUs,
    uncertaintyUs: estimate.uncertaintyUs,
  };
}

export type TimestampRole = "main" | "renderer";

export interface TimestampRef {
  readonly role: TimestampRole;
  readonly tsUs: number;
}

export type CrossProcessStatus = "unavailable" | "stale" | "indeterminate" | "ok";

export interface CrossProcessDuration {
  readonly status: CrossProcessStatus;
  readonly durationUs: number | null;
  readonly uncertaintyUs: number | null;
}

export interface CrossProcessOptions {
  /** How old an estimate may be before it must be re-run. Default 60 s. */
  readonly maxEstimateAgeUs?: number;
  readonly nowUs?: number;
}

/**
 * Difference between two timestamps that may live on different clocks.
 * Never fabricates precision: no estimate → unavailable; estimate too old →
 * stale; |duration| within the uncertainty → indeterminate (cannot gate).
 */
export function crossProcessDuration(
  start: TimestampRef,
  end: TimestampRef,
  estimate: ClockOffsetEstimate | null,
  options: CrossProcessOptions = {},
): CrossProcessDuration {
  if (!estimate || !estimate.valid || estimate.offsetUs === null || estimate.uncertaintyUs === null) {
    return { status: "unavailable", durationUs: null, uncertaintyUs: null };
  }
  const maxAge = options.maxEstimateAgeUs ?? 60_000_000;
  if (options.nowUs !== undefined && estimate.estimatedAtUs !== null) {
    if (options.nowUs - estimate.estimatedAtUs > maxAge) {
      return { status: "stale", durationUs: null, uncertaintyUs: null };
    }
  }
  const toMain = (ref: TimestampRef): number =>
    ref.role === "main" ? ref.tsUs : ref.tsUs + (estimate.offsetUs as number);
  const duration = toMain(end) - toMain(start);
  // Two conversions each carry ±uncertainty.
  const uncertainty = estimate.uncertaintyUs * 2;
  if (Math.abs(duration) <= uncertainty) {
    return { status: "indeterminate", durationUs: Math.round(duration), uncertaintyUs: uncertainty };
  }
  return { status: "ok", durationUs: Math.round(duration), uncertaintyUs: uncertainty };
}

// ---------------------------------------------------------------------------
// Handshake driver
// ---------------------------------------------------------------------------

export interface ClockSyncTransport {
  nowUs(): number;
  sendPing(ping: PerfClockPing): void;
  onPong(callback: (pong: PerfClockPong) => void): () => void;
  delay(ms: number): Promise<void>;
}

export interface ClockSyncOptions {
  readonly attempts?: number;
  readonly attemptSpacingMs?: number;
  readonly timeoutMs?: number;
  readonly minSamples?: number;
}

export type ClockSyncResult = ClockOffsetEstimate & { readonly estimatedAtUs: number };

export class ClockSynchronizer {
  private readonly transport: ClockSyncTransport;
  private readonly attempts: number;
  private readonly spacingMs: number;
  private readonly timeoutMs: number;
  private readonly minSamples: number;
  private running = false;

  constructor(transport: ClockSyncTransport, options: ClockSyncOptions = {}) {
    this.transport = transport;
    this.attempts = options.attempts ?? DEFAULT_MIN_HANDSHAKE_SAMPLES;
    this.spacingMs = options.attemptSpacingMs ?? 2;
    this.timeoutMs = options.timeoutMs ?? 250;
    this.minSamples = options.minSamples ?? DEFAULT_MIN_HANDSHAKE_SAMPLES;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runHandshake(): Promise<ClockSyncResult> {
    if (this.running) throw new Error("clock-sync: handshake already running");
    this.running = true;
    const samples: ClockHandshakeSample[] = [];
    try {
      for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
        const pong = await this.exchange(attempt);
        if (pong) samples.push(pong);
        if (attempt < this.attempts) await this.transport.delay(this.spacingMs);
      }
    } finally {
      this.running = false;
    }
    const estimate = estimateClockOffset(samples, { minSamples: this.minSamples });
    const estimatedAtUs = this.transport.nowUs();
    return { ...estimate, estimatedAtUs };
  }

  private exchange(attempt: number): Promise<ClockHandshakeSample | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (sample: ClockHandshakeSample | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(sample);
      };
      const unsubscribe = this.transport.onPong((pong) => {
        // Late answers from earlier attempts can never corrupt this one.
        if (pong.attempt !== attempt) return;
        finish({
          attempt,
          m0Us: this.m0Us,
          r1Us: pong.r1Us,
          r2Us: pong.r2Us,
          m3Us: this.transport.nowUs(),
        });
      });
      const timeout = setTimeout(() => finish(null), this.timeoutMs);
      this.m0Us = this.transport.nowUs();
      this.transport.sendPing({ schemaVersion: PERFORMANCE_CONTRACT_SCHEMA_VERSION, attempt });
    });
  }

  private m0Us = 0;
}
