import { describe, expect, it } from "vitest";
import { idleMemoryTrend, summarizeIdleMemory } from "./resource-trend";

describe("idle resource trends", () => {
  it("reports a signed idle slope and keeps missing memory unavailable", () => {
    expect(idleMemoryTrend([{ elapsed_ms: 0, bytes: 300 }, { elapsed_ms: 60_000, bytes: 200 }, { elapsed_ms: 120_000, bytes: 100 }])).toMatchObject({ status: "ok", bytes_per_minute: -100 });
    expect(idleMemoryTrend([{ elapsed_ms: 0, bytes: null }, { elapsed_ms: 60_000, bytes: null }])).toEqual({ status: "insufficient_samples", bytes_per_minute: null, n: 0 });
  });
  it("does not join memory observations across process replacement", () => {
    const summary = summarizeIdleMemory([0, 60_000, 120_000].map((elapsed_ms, index) => ({
      elapsed_ms, heap_bytes: null, resources: {},
      rss: [{ role: "renderer", process_epoch: index === 2 ? "new" : "old", rss_bytes: 100 + index * 10 }],
    })));
    expect(summary.processes.map((process) => process.n)).toEqual([2, 1]);
    expect(summary.processes.every((process) => process.bytes_per_minute === null)).toBe(true);
    expect(summary.vram).toEqual({ status: "unsupported", bytes: null });
  });
  it("keeps independent main and renderer heap series with honest missing values", () => {
    const result = summarizeIdleMemory([0, 60000, 120000].map((elapsed_ms, index) => ({
      elapsed_ms, heap_bytes: 400 - index * 100,
      main_memory: { heap_used_bytes: 100 + index * 50, heap_total_bytes: 1000, external_bytes: 0, array_buffer_bytes: 0 },
      resources: {}, rss: [],
    })));
    expect(result.heap.bytes_per_minute).toBe(-100);
    expect(result.main_heap.bytes_per_minute).toBe(50);
    expect(summarizeIdleMemory([]).main_heap.n).toBe(0);
  });

});
