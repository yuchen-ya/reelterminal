/**
 * Frame render scheduling for the paused preview path.
 *
 * One render runs at a time; while it runs, only the LATEST requested target
 * is kept pending and starts the moment the current one settles — so a
 * continuous drag keeps producing frames instead of starving (a trailing
 * debounce that every move resets never fires at all). Every request carries
 * an incrementing generation plus the target time and project revision it was
 * asked for; a result may only reach the canvas while it is still the newest
 * committed one and its context is unchanged, which is what keeps a slow old
 * task from painting over a newer picture.
 */

import { finishPreviewSeek, type PreviewSeek } from "../../../performance/seek-flow";
import { beginPerfOperation, endPerfOperation, getPerfSink, markPerfOperation, type PerfOperation } from "@reelterminal/core";

export interface FrameRequestToken {
  /** Monotonic request id; continuous inputs may commit progress in order. */
  readonly seq: number;
  /** Invalidated (bumped) on media switches, preview invalidations, unmount. */
  readonly epoch: number;
  /** Target timeline position the frame was requested for. */
  readonly time: number;
  /** Project revision the request was made against. */
  readonly revision: number;
  /** Version of the active view (for example a history preview request). */
  readonly viewGeneration?: number;
  /** Measurement-only correlation; absent when capture is off. */
  readonly performance?: PerfOperation;
  readonly continuous?: boolean;
  readonly seek?: PreviewSeek;
  readonly contextKey?: string;
}

export type FrameRenderRunner = (token: FrameRequestToken) => Promise<void>;

export class FrameRenderScheduler {
  private seq = 0;
  private epoch = 0;
  private committedSeq = 0;
  private latestRevision = 0;
  private running = false;
  private pending: FrameRequestToken | null = null;
  private active: FrameRequestToken | null = null;
  private lastCommitted: FrameRequestToken | null = null;
  private strictSeq = 0;
  private latestContinuous = false;

  constructor(
    private readonly runner: FrameRenderRunner,
    private readonly getViewGeneration?: () => number,
    private readonly getContextKey?: () => string,
  ) {}

  /**
   * Ask for a frame at `time`. While a render is in flight the previous
   * pending target is replaced (latest wins) and this returns immediately.
   */
  request(time: number, revision: number, parent?: PerfOperation, options?: { continuous?: boolean; seek?: PreviewSeek; force?: boolean }): void {
    const viewGeneration = this.getViewGeneration?.();
    const contextKey = this.getContextKey?.();
    const sameTarget = (token: FrameRequestToken | null) => token && token.epoch === this.epoch &&
      token.time === time && token.revision === revision && token.viewGeneration === viewGeneration &&
      token.contextKey === contextKey;
    // A pointer release or decoder notification at the same visual target must
    // not supersede the work already producing (or displaying) that picture.
    if (!options?.force && (sameTarget(this.pending) || (!this.pending && sameTarget(this.active)) ||
      (!this.active && !this.pending && sameTarget(this.lastCommitted)))) {
      getPerfSink().count("frame.deduplicated", 1);
      if (options?.seek && options.seek !== (this.pending ?? this.active ?? this.lastCommitted)?.seek) {
        finishPreviewSeek(options.seek, "cancelled", "same-target");
      }
      return;
    }
    this.seq += 1;
    this.latestRevision = revision;
    this.latestContinuous = options?.continuous ?? false;
    if (!this.latestContinuous) this.strictSeq = this.seq;
    endPerfOperation(this.pending?.performance, "superseded");
    if (this.pending?.seek !== options?.seek) finishPreviewSeek(this.pending?.seek, "superseded", "coalesced");
    const operation = getPerfSink().enabled
      ? beginPerfOperation("frame.render", parent, { frameSeq: this.seq, frameEpoch: this.epoch, revision })
      : undefined;
    this.pending = {
      seq: this.seq, epoch: this.epoch, time, revision, viewGeneration, contextKey,
      continuous: this.latestContinuous, seek: options?.seek, performance: operation,
    };
    markPerfOperation(operation, "frame.requested", { timelineTimeSeconds: time, seekId: options?.seek?.id ?? 0 });
    void this.pump();
  }

  /**
   * Expire every result produced so far — the world changed underneath the
   * in-flight render (media source swap, preview invalidation, unmount).
   */
  invalidate(): void {
    this.epoch += 1;
    endPerfOperation(this.pending?.performance, "cancelled");
    finishPreviewSeek(this.pending?.seek, "cancelled");
    finishPreviewSeek(this.active?.seek, "cancelled");
    this.pending = null;
    this.lastCommitted = null;
  }

  /**
   * True while `token` still describes work the canvas wants: produced under
   * the current epoch and project revision, and not already beaten by a newer
   * committed frame.
   */
  isCurrent(token: FrameRequestToken): boolean {
    return (
      token.epoch === this.epoch &&
      (token.seq === this.seq || (token.continuous === true && this.latestContinuous && token.seq >= this.strictSeq)) &&
      token.revision === this.latestRevision &&
      (token.viewGeneration === undefined || token.viewGeneration === this.getViewGeneration?.()) &&
      (token.contextKey === undefined || token.contextKey === this.getContextKey?.()) &&
      token.seq > this.committedSeq
    );
  }

  /**
   * Claim the canvas for `token`. Returns false when the result is stale —
   * a newer frame committed first, or the request context was invalidated —
   * in which case the caller must not paint.
   */
  markCommitted(token: FrameRequestToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.committedSeq = token.seq;
    this.lastCommitted = token;
    markPerfOperation(token.performance, "frame.commit-claimed");
    return true;
  }

  /** True while a render is in flight. */
  get busy(): boolean {
    return this.running;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const target = this.pending;
        this.pending = null;
        const token = target;
        this.active = token;
        if (token.seek) token.seek.started = true;
        markPerfOperation(token.performance, "frame.started");
        try {
          await this.runner(token);
          const outcome = token.seq === this.committedSeq ? "ok" : this.isCurrent(token) ? "error" : "superseded";
          endPerfOperation(token.performance, outcome);
          if (outcome === "superseded") finishPreviewSeek(token.seek, outcome);
        } catch (error) {
          endPerfOperation(token.performance, "error");
          finishPreviewSeek(token.seek, "error");
          throw error;
        } finally {
          if (token.seek) {
            token.seek.started = false;
            if (token.seq < this.seq && (this.pending as FrameRequestToken | null)?.seek !== token.seek) finishPreviewSeek(token.seek, "superseded");
          }
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
