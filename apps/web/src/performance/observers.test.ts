import { describe, expect, it, vi } from "vitest";
import {
  createAnimationFrameSampler,
  createObserverBundle,
  type PerfObserverConstructorLike,
  type PerfObserverEntryLike,
  type PerfObserverLike,
} from "./observers";

class FakePerformanceObserver implements PerfObserverLike {
  static instances: FakePerformanceObserver[] = [];
  static supportedEntryTypes: readonly string[] = ["longtask", "event", "measure"];
  static push(entry: PerfObserverEntryLike): void {
    for (const observer of FakePerformanceObserver.instances) {
      observer.callback({ getEntries: () => [entry] });
    }
  }
  static reset(): void {
    FakePerformanceObserver.instances = [];
    FakePerformanceObserver.supportedEntryTypes = ["longtask", "event", "measure"];
  }
  observeCalls: Array<{ type: string; durationThreshold?: number; buffered?: boolean }> = [];
  disconnected = false;
  private readonly callback: (list: { getEntries(): PerfObserverEntryLike[] }) => void;

  constructor(callback: (list: { getEntries(): PerfObserverEntryLike[] }) => void) {
    this.callback = callback;
    FakePerformanceObserver.instances.push(this);
  }

  observe(options: { type: string; durationThreshold?: number; buffered?: boolean }): void {
    this.observeCalls.push(options);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  private emit(entry: PerfObserverEntryLike): void {
    this.callback({ getEntries: () => [entry] });
  }

  static deliver(entry: PerfObserverEntryLike): void {
    for (const observer of FakePerformanceObserver.instances) observer.emit(entry);
  }
}

function fakeHost(): { PerformanceObserver: PerfObserverConstructorLike } {
  return { PerformanceObserver: FakePerformanceObserver };
}

describe("createObserverBundle", () => {
  it("reports unsupported when the entry type is absent", () => {
    const bundle = createObserverBundle({}, {});
    expect(bundle.longTask.support).toBe("unsupported");
    expect(bundle.eventTiming.support).toBe("unsupported");
  });

  it("observes longtask without buffered replay and converts to microseconds", () => {
    FakePerformanceObserver.reset();
    const onLongTask = vi.fn();
    const bundle = createObserverBundle({ onLongTask }, fakeHost());
    expect(bundle.longTask.support).toBe("supported");
    const observer = FakePerformanceObserver.instances[0];
    expect(observer.observeCalls[0]).toMatchObject({ type: "longtask", buffered: false });
    FakePerformanceObserver.deliver({ entryType: "longtask", startTime: 12.5, duration: 80 });
    expect(onLongTask).toHaveBeenCalledWith({
      durationMs: 80,
      startTimeUs: 12500,
      name: "",
    });
    bundle.stopAll();
    expect(observer.disconnected).toBe(true);
  });

  it("observes event timing with a threshold", () => {
    FakePerformanceObserver.reset();
    const onEventTiming = vi.fn();
    const bundle = createObserverBundle({ onEventTiming }, fakeHost());
    // No longtask sink was passed, so the only live observer is event timing.
    const observer = FakePerformanceObserver.instances[0];
    expect(observer.observeCalls[0]).toMatchObject({ type: "event", durationThreshold: 16 });
    FakePerformanceObserver.deliver({ name: "pointermove", startTime: 3, duration: 42 });
    expect(onEventTiming).toHaveBeenCalledWith({
      durationMs: 42,
      startTimeUs: 3000,
      eventType: "pointermove",
    });
    bundle.stopAll();
  });

  it("treats a throwing observer constructor as unsupported, not zero", () => {
    const throwing = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      PerformanceObserver: class {
        constructor() {
          throw new Error("nope");
        }
      } as unknown as PerfObserverConstructorLike,
    };
    const bundle = createObserverBundle({ onLongTask: () => undefined }, throwing);
    expect(bundle.longTask.support).toBe("unsupported");
  });
});

describe("createAnimationFrameSampler", () => {
  it("samples injected frame timestamps and stops cleanly", () => {
    const frames: number[] = [];
    let handle = 0;
    const pending = new Map<number, (tsMs: number) => void>();
    const host = {
      requestFrame: (cb: (tsMs: number) => void) => {
        handle += 1;
        pending.set(handle, cb);
        return handle;
      },
      cancelFrame: (id: number) => {
        pending.delete(id);
      },
    };
    const sampler = createAnimationFrameSampler((us) => frames.push(us), host);
    expect(sampler.support).toBe("supported");
    const fire = (tsMs: number): void => {
      const [first] = [...pending.entries()];
      if (!first) return;
      pending.delete(first[0]);
      first[1]?.(tsMs);
    };
    fire(1);
    fire(17.5);
    sampler.stop();
    const pendingCount = pending.size;
    fire(33);
    expect(frames).toEqual([1000, 17500]);
    expect(pendingCount).toBe(0);
  });

  it("reports unsupported without a rAF host", () => {
    const sampler = createAnimationFrameSampler(() => undefined, null);
    expect(sampler.support).toBe("unsupported");
    expect(() => sampler.stop()).not.toThrow();
  });
});
