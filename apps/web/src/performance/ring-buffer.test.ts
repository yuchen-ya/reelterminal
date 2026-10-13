import { describe, expect, it } from "vitest";
import { PerfRingBuffer } from "./ring-buffer";
import type { PerfEvent } from "@reelterminal/core";

function event(seq: number): PerfEvent {
  return {
    schemaVersion: 1,
    runId: "run",
    processRole: "renderer",
    processEpoch: "e",
    clockId: "c",
    seq,
    kind: "mark",
    phase: `phase.${seq}`,
    tsUs: seq * 10,
  };
}

describe("PerfRingBuffer", () => {
  it("overwrites the oldest event when the main ring is full and counts it", () => {
    const buffer = new PerfRingBuffer({ capacity: 3, criticalCapacity: 2 });
    for (let seq = 1; seq <= 5; seq += 1) buffer.append(event(seq));
    expect(buffer.snapshot().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(buffer.stats.eventsDropped).toBe(2);
    expect(buffer.stats.eventsAppended).toBe(5);
  });

  it("keeps insertion order across the wrap-around", () => {
    const buffer = new PerfRingBuffer({ capacity: 4, criticalCapacity: 2 });
    for (let seq = 1; seq <= 6; seq += 1) buffer.append(event(seq));
    expect(buffer.snapshot().map((e) => e.seq)).toEqual([3, 4, 5, 6]);
  });

  it("drops the NEW critical event when the critical store is full", () => {
    const buffer = new PerfRingBuffer({ capacity: 3, criticalCapacity: 2 });
    expect(buffer.append(event(1), { critical: true })).toBe(true);
    expect(buffer.append(event(2), { critical: true })).toBe(true);
    expect(buffer.append(event(3), { critical: true })).toBe(false);
    expect(buffer.criticalSnapshot().map((e) => e.seq)).toEqual([1, 2]);
    expect(buffer.stats.criticalEndpointsDropped).toBe(1);
  });

  it("refuses appends after freezing and counts them", () => {
    const buffer = new PerfRingBuffer({ capacity: 3, criticalCapacity: 2 });
    buffer.append(event(1));
    buffer.freeze();
    expect(buffer.append(event(2))).toBe(false);
    expect(buffer.append(event(3), { critical: true })).toBe(false);
    expect(buffer.stats.eventsDropped).toBe(1);
    expect(buffer.stats.criticalEndpointsDropped).toBe(1);
    expect(buffer.snapshot().map((e) => e.seq)).toEqual([1]);
  });

  it("exports main and critical events merged by seq", () => {
    const buffer = new PerfRingBuffer({ capacity: 10, criticalCapacity: 3 });
    buffer.append(event(1));
    buffer.append(event(2), { critical: true });
    buffer.append(event(3));
    buffer.append(event(4), { critical: true });
    expect(buffer.exportSnapshot().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("clears everything for reuse", () => {
    const buffer = new PerfRingBuffer({ capacity: 2, criticalCapacity: 1 });
    buffer.append(event(1));
    buffer.append(event(2), { critical: true });
    buffer.freeze();
    buffer.clear();
    expect(buffer.frozen).toBe(false);
    expect(buffer.snapshot()).toEqual([]);
    expect(buffer.stats.eventsDropped).toBe(0);
    expect(buffer.stats.criticalEndpointsDropped).toBe(0);
  });

  it("rejects invalid capacities", () => {
    expect(() => new PerfRingBuffer({ capacity: 0, criticalCapacity: 1 })).toThrow();
    expect(() => new PerfRingBuffer({ capacity: 1, criticalCapacity: -1 })).toThrow();
  });
});
