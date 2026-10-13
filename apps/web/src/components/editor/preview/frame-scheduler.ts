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

import { beginPerfOperation, endPerfOperation, getPerfSink, markPerfOperation, type PerfOperation } from "@reelterminal/core";

export interface FrameRequestToken {
  /** Monotonic id of the request; later requests supersede earlier ones. */
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
}

export type FrameRenderRunner = (token: FrameRequestToken) => Promise<void>;

export class FrameRenderScheduler {
  private seq = 0;
  private epoch = 0;
  private committedSeq = 0;
  private latestRevision = 0;
  private running = false;
  private pending: { time: number; revision: number; viewGeneration?: number; performance?: PerfOperation } | null = null;

  constructor(
    private readonly runner: FrameRenderRunner,
    private readonly getViewGeneration?: () => number,
  ) {}

  /**
   * Ask for a frame at `time`. While a render is in flight the previous
   * pending target is replaced (latest wins) and this returns immediately.
   */
  request(time: number, revision: number, parent?: PerfOperation): void {
    this.seq += 1;
    this.latestRevision = revision;
    endPerfOperation(this.pending?.performance, "superseded");
    const operation = getPerfSink().enabled
      ? beginPerfOperation("frame.render", parent, { frameSeq: this.seq, frameEpoch: this.epoch, revision })
      : undefined;
    if (operation) {
      this.pending = {
        time,
        revision,
        ...(this.getViewGeneration ? { viewGeneration: this.getViewGeneration() } : {}),
        performance: operation,
      };
      operation.sink.mark("frame.requested", operation.context, { timelineTimeSeconds: time });
    } else {
      this.pending = {
        time,
        revision,
        ...(this.getViewGeneration ? { viewGeneration: this.getViewGeneration() } : {}),
      };
    }
    void this.pump();
  }

  /**
   * Expire every result produced so far — the world changed underneath the
   * in-flight render (media source swap, preview invalidation, unmount).
   */
  invalidate(): void {
    this.epoch += 1;
    endPerfOperation(this.pending?.performance, "cancelled");
    this.pending = null;
  }

  /**
   * True while `token` still describes work the canvas wants: produced under
   * the current epoch and project revision, and not already beaten by a newer
   * committed frame.
   */
  isCurrent(token: FrameRequestToken): boolean {
    return (
      token.epoch === this.epoch &&
      token.seq === this.seq &&
      token.revision === this.latestRevision &&
      (token.viewGeneration === undefined || token.viewGeneration === this.getViewGeneration?.()) &&
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
        const token: FrameRequestToken = {
          seq: this.seq,
          epoch: this.epoch,
          time: target.time,
          revision: target.revision,
          ...(target.viewGeneration !== undefined ? { viewGeneration: target.viewGeneration } : {}),
          ...(target.performance ? { performance: target.performance } : {}),
        };
        markPerfOperation(token.performance, "frame.started");
        try {
          await this.runner(token);
          endPerfOperation(token.performance, token.seq === this.committedSeq ? "ok" : this.isCurrent(token) ? "error" : "superseded");
        } catch (error) {
          endPerfOperation(token.performance, "error");
          throw error;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
