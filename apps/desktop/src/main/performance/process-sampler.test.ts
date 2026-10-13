import { describe, expect, it } from "vitest";
import { ProcessSampler, type AppMetricEntry, type ProcessMetricsSource } from "./process-sampler";

function fakeSource(entries: AppMetricEntry[] | (() => AppMetricEntry[])): ProcessMetricsSource {
  return {
    getAppMetrics: () => (typeof entries === "function" ? entries() : entries),
  };
}

function fakeTimers() {
  const callbacks: Array<() => void> = [];
  return {
    timers: {
      set: (cb: () => void) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      clear: () => undefined,
    },
    tick(): void {
      for (const cb of [...callbacks]) cb();
    },
  };
}

const METRICS: AppMetricEntry[] = [
  { type: "Browser", pid: 100, memory: { workingSetSize: 50_000 } },
  { type: "Renderer", pid: 200, memory: { workingSetSize: 120_000 } },
  { type: "GPU", pid: 300, memory: { workingSetSize: 80_000 } },
];

describe("ProcessSampler", () => {
  it("maps Electron types to roles and converts KB to bytes", () => {
    let nowUs = 1_000;
    const harness = fakeTimers();
    const sampler = new ProcessSampler(fakeSource(METRICS), {
      nowUs: () => nowUs,
      timers: harness.timers,
    });
    expect(sampler.capability).toBe("supported");
    sampler.start();
    // start() collects a baseline immediately; each tick adds another batch.
    harness.tick();
    nowUs += 15_000_000;
    harness.tick();
    expect(sampler.samples).toHaveLength(9);
    const first = sampler.samples[0];
    expect(first).toEqual({ tsUs: 1_000, role: "main", pid: 100, rssBytes: 50_000 * 1024 });
    expect(sampler.samples[7]).toMatchObject({ role: "renderer", rssBytes: 120_000 * 1024 });
    expect(sampler.samples[8]).toMatchObject({ tsUs: 15_001_000, role: "gpu" });
  });

  it("caps stored samples and counts the dropped ones", () => {
    const harness = fakeTimers();
    const sampler = new ProcessSampler(fakeSource(METRICS.slice(0, 1)), {
      timers: harness.timers,
      maxSamples: 2,
    });
    sampler.start();
    harness.tick();
    harness.tick();
    harness.tick();
    expect(sampler.samples).toHaveLength(2);
    expect(sampler.droppedSamples).toBe(2);
  });

  it("is unsupported without a source and never produces zero samples", () => {
    const harness = fakeTimers();
    const sampler = new ProcessSampler(null, { timers: harness.timers });
    expect(sampler.capability).toBe("unsupported");
    sampler.start();
    harness.tick();
    expect(sampler.samples).toHaveLength(0);
    expect(sampler.running).toBe(false);
  });

  it("flips to unsupported and stops when the metrics API throws", () => {
    const harness = fakeTimers();
    let shouldThrow = false;
    const sampler = new ProcessSampler(
      fakeSource(() => {
        if (shouldThrow) throw new Error("metrics unavailable");
        return METRICS;
      }),
      { timers: harness.timers },
    );
    sampler.start();
    harness.tick();
    expect(sampler.capability).toBe("supported");
    shouldThrow = true;
    harness.tick();
    expect(sampler.capability).toBe("unsupported");
    expect(sampler.running).toBe(false);
  });
});
