/**
 * Browser performance observers (design phase P1).
 *
 * Everything here is capability-first: when the host does not expose an
 * observer type, the capability is reported as "unsupported" and no observer
 * is created — never a count of zero pretending to be a measurement. All
 * timestamps are converted to the renderer clock's microseconds before
 * leaving this module.
 */

export type ObserverSupport = "supported" | "unsupported";

/** Structural subset of PerformanceObserver entries we consume. */
export interface PerfObserverEntryLike {
  readonly entryType?: string;
  readonly name?: string;
  readonly startTime: number;
  readonly duration: number;
}

export interface PerfObserverLike {
  observe(options: { type: string; durationThreshold?: number; buffered?: boolean }): void;
  disconnect(): void;
}

export interface PerfObserverConstructorLike {
  new (
    callback: (list: { getEntries(): PerfObserverEntryLike[] }) => void,
  ): PerfObserverLike;
  readonly supportedEntryTypes?: readonly string[];
}

export interface ObserverHost {
  readonly PerformanceObserver?: PerfObserverConstructorLike;
  readonly supportedEntryTypes?: readonly string[];
}

export function defaultObserverHost(): ObserverHost {
  if (typeof PerformanceObserver === "undefined") return {};
  return { PerformanceObserver };
}

export interface LongTaskRecord {
  readonly durationMs: number;
  readonly startTimeUs: number;
  readonly name: string;
}

export interface EventTimingRecord {
  readonly durationMs: number;
  readonly startTimeUs: number;
  readonly eventType: string;
}

export interface ObserverBundle {
  readonly longTask: { readonly support: ObserverSupport; readonly stop: () => void };
  readonly eventTiming: { readonly support: ObserverSupport; readonly stop: () => void };
  readonly stopAll: () => void;
}

export interface ObserverSinks {
  onLongTask?: (record: LongTaskRecord) => void;
  onEventTiming?: (record: EventTimingRecord) => void;
}

function resolveSupportedTypes(host: ObserverHost): readonly string[] {
  return host.supportedEntryTypes ?? host.PerformanceObserver?.supportedEntryTypes ?? [];
}

/**
 * Install LongTask and EventTiming observers. Only entries observed while
 * installed are delivered (buffered: false) — the action window owns the
 * evidence, not whatever happened before the capture started.
 */
export function createObserverBundle(
  sinks: ObserverSinks,
  host: ObserverHost = defaultObserverHost(),
): ObserverBundle {
  const supported = resolveSupportedTypes(host);

  const install = (
    entryType: string,
    sink: ((record: never) => void) | undefined,
    convert: (entry: PerfObserverEntryLike) => void,
    durationThresholdMs?: number,
  ): { support: ObserverSupport; stop: () => void } => {
    if (!host.PerformanceObserver || !supported.includes(entryType) || !sink) {
      return { support: "unsupported", stop: () => undefined };
    }
    let observer: PerfObserverLike | undefined;
    try {
      observer = new host.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) convert(entry);
      });
      observer.observe({ type: entryType, durationThreshold: durationThresholdMs, buffered: false });
    } catch {
      // A throwing constructor or observe() is a capability gap, not a
      // zero-measurement.
      return { support: "unsupported", stop: () => undefined };
    }
    return {
      support: "supported",
      stop: () => {
        observer?.disconnect();
        observer = undefined;
      },
    };
  };

  const longTask = install(
    "longtask",
    sinks.onLongTask as ((record: never) => void) | undefined,
    (entry) => {
      sinks.onLongTask?.({
        durationMs: entry.duration,
        startTimeUs: Math.round(entry.startTime * 1000),
        name: typeof entry.name === "string" ? entry.name : "",
      });
    },
  );

  const eventTiming = install(
    "event",
    sinks.onEventTiming as ((record: never) => void) | undefined,
    (entry) => {
      sinks.onEventTiming?.({
        durationMs: entry.duration,
        startTimeUs: Math.round(entry.startTime * 1000),
        eventType: typeof entry.name === "string" ? entry.name : "",
      });
    },
    16,
  );

  return {
    longTask,
    eventTiming,
    stopAll: () => {
      longTask.stop();
      eventTiming.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// rAF interval sampling
// ---------------------------------------------------------------------------

export interface FrameSamplerHost {
  requestFrame(callback: (timestampMs: number) => void): number;
  cancelFrame(handle: number): void;
}

export function defaultFrameSamplerHost(): FrameSamplerHost | null {
  if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") {
    return null;
  }
  return {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  };
}

export interface FrameIntervalSampler {
  readonly support: ObserverSupport;
  readonly stop: () => void;
}

/**
 * Sample rAF callback timestamps while an action window is open. Hidden or
 * occluded windows throttle rAF; the capture validity layer treats that as
 * an invalid run rather than trusting slow intervals.
 */
export function createAnimationFrameSampler(
  onFrame: (timestampUs: number) => void,
  host: FrameSamplerHost | null = defaultFrameSamplerHost(),
): FrameIntervalSampler {
  if (!host) return { support: "unsupported", stop: () => undefined };
  let stopped = false;
  let handle: number | null = null;
  const tick = (timestampMs: number): void => {
    if (stopped) return;
    onFrame(Math.round(timestampMs * 1000));
    handle = host.requestFrame(tick);
  };
  handle = host.requestFrame(tick);
  return {
    support: "supported",
    stop: () => {
      stopped = true;
      if (handle !== null) host.cancelFrame(handle);
      handle = null;
    },
  };
}
