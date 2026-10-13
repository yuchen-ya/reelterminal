/**
 * Bounded event storage for one capture (design phase P1).
 *
 * Two stores with different drop policies:
 * - the main ring overwrites its OLDEST event when full (recent evidence is
 *   what a failure report needs) and counts the overwrite in eventsDropped;
 * - the critical store keeps semantic endpoints (final commits, errors,
 *   cancels, save confirmations, first frames). When it is full the NEW event
 *   is dropped instead — silently replacing one semantic endpoint with
 *   another would let a result claim "first frame got faster" while the
 *   evidence for it is gone.
 *
 * Frozen buffers reject appends (counted as drops) so a finished capture
 * cannot be mutated afterwards.
 */
import type { PerfEvent } from "@reelterminal/core";

export interface PerfRingBufferOptions {
  readonly capacity: number;
  readonly criticalCapacity: number;
}

export interface PerfRingBufferStats {
  readonly eventsAppended: number;
  readonly eventsDropped: number;
  readonly criticalEventsAppended: number;
  readonly criticalEndpointsDropped: number;
}

export class PerfRingBuffer {
  private readonly ring: (PerfEvent | undefined)[];
  private readonly criticalCapacity: number;
  private readonly critical: PerfEvent[] = [];
  private ringHead = 0;
  private ringCount = 0;
  private appended = 0;
  private dropped = 0;
  private criticalAppended = 0;
  private criticalDropped = 0;
  private frozenFlag = false;

  constructor(options: PerfRingBufferOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("PerfRingBuffer: capacity must be a positive integer");
    }
    if (!Number.isInteger(options.criticalCapacity) || options.criticalCapacity < 1) {
      throw new Error("PerfRingBuffer: criticalCapacity must be a positive integer");
    }
    this.criticalCapacity = options.criticalCapacity;
    this.ring = new Array<PerfEvent | undefined>(options.capacity);
  }

  get frozen(): boolean {
    return this.frozenFlag;
  }

  get stats(): PerfRingBufferStats {
    return {
      eventsAppended: this.appended,
      eventsDropped: this.dropped,
      criticalEventsAppended: this.criticalAppended,
      criticalEndpointsDropped: this.criticalDropped,
    };
  }

  /**
   * Append an event. Returns true when stored. A frozen buffer or a full
   * critical store refuses the event (counted), a full main ring overwrites
   * the oldest entry (also counted).
   */
  append(event: PerfEvent, options: { critical?: boolean } = {}): boolean {
    if (this.frozenFlag) {
      if (options.critical) this.criticalDropped += 1;
      else this.dropped += 1;
      return false;
    }
    if (options.critical) {
      if (this.critical.length >= this.criticalCapacity) {
        this.criticalDropped += 1;
        return false;
      }
      this.critical.push(event);
      this.criticalAppended += 1;
      return true;
    }
    if (this.ringCount === this.ring.length) {
      // Ring semantics: the oldest entry is the evidence that gets lost.
      this.dropped += 1;
    } else {
      this.ringCount += 1;
    }
    this.ring[this.ringHead] = event;
    this.ringHead = (this.ringHead + 1) % this.ring.length;
    this.appended += 1;
    return true;
  }

  /** Main-ring events in insertion order (oldest surviving first). */
  snapshot(): PerfEvent[] {
    const out: PerfEvent[] = [];
    const start = (this.ringHead - this.ringCount + this.ring.length) % this.ring.length;
    for (let i = 0; i < this.ringCount; i += 1) {
      const event = this.ring[(start + i) % this.ring.length];
      if (event !== undefined) out.push(event);
    }
    return out;
  }

  criticalSnapshot(): PerfEvent[] {
    return [...this.critical];
  }

  /** All stored events ordered by their monotonic seq. */
  exportSnapshot(): PerfEvent[] {
    return [...this.snapshot(), ...this.criticalSnapshot()].sort((a, b) => a.seq - b.seq);
  }

  /** Seal the buffer; further appends are refused and counted. */
  freeze(): void {
    this.frozenFlag = true;
  }

  /** Drop everything and unfreeze (test/reuse only). */
  clear(): void {
    this.ring.fill(undefined);
    this.critical.length = 0;
    this.ringHead = 0;
    this.ringCount = 0;
    this.appended = 0;
    this.dropped = 0;
    this.criticalAppended = 0;
    this.criticalDropped = 0;
    this.frozenFlag = false;
  }
}
