import { describe, expect, it, vi } from "vitest";
import {
  ExportPerformanceCapture,
  EXPORT_PERFORMANCE_PHASES,
  withExportPerformance,
  withExportPerformanceSpan,
} from "./export-performance";

describe("export performance capture", () => {
  it("does no clock reads or events while disabled and reports unavailable phases", () => {
    const nowUs = vi.fn(() => 10);
    const capture = new ExportPerformanceCapture({
      enabled: false,
      supportedPhases: EXPORT_PERFORMANCE_PHASES,
      nowUs,
    });

    expect(capture.begin("submit")).toBeNull();
    capture.mark("progress", { currentFrame: 1 });
    expect(capture.report()).toMatchObject({
      status: "off",
      events: [],
      eventsDropped: 0,
      openSpans: 0,
      phaseStatus: { submit: "unavailable", progress: "unavailable" },
    });
    expect(nowUs).not.toHaveBeenCalled();
  });

  it("records supported phases, outcomes and explicit unavailability", () => {
    let now = 100;
    const capture = new ExportPerformanceCapture({
      enabled: true,
      supportedPhases: ["submit", "encode"],
      nowUs: () => now += 25,
    });
    const submit = capture.begin("submit")!;
    capture.end(submit, "ok");
    const encode = capture.begin("encode")!;
    capture.end(encode, "error");

    expect(capture.report()).toMatchObject({
      status: "complete",
      phaseStatus: { submit: "supported", encode: "supported", audio: "unavailable" },
      events: [
        { kind: "span_begin", phase: "submit", tsUs: 125 },
        { kind: "span_end", phase: "submit", durationUs: 25, outcome: "ok" },
        { kind: "span_begin", phase: "encode", tsUs: 175 },
        { kind: "span_end", phase: "encode", durationUs: 25, outcome: "error" },
      ],
    });
  });

  it("bounds progress events and marks a dropped capture incomplete", () => {
    const capture = new ExportPerformanceCapture({
      enabled: true,
      supportedPhases: ["progress"],
      capacity: 1,
      nowUs: () => 1,
    });
    capture.mark("progress", { currentFrame: 1 });
    capture.mark("progress", { currentFrame: 2 });

    expect(capture.report()).toMatchObject({
      status: "incomplete",
      eventsDropped: 1,
      events: [{ kind: "mark", phase: "progress", dims: { currentFrame: 1 } }],
    });
  });

  it("marks a clock that moves backwards invalid without inventing a duration", () => {
    const ticks = [100, 90];
    const capture = new ExportPerformanceCapture({
      enabled: true,
      supportedPhases: ["encode"],
      nowUs: () => ticks.shift()!,
    });
    const span = capture.begin("encode")!;
    capture.end(span, "ok");

    expect(capture.report()).toMatchObject({
      status: "incomplete",
      clockStatus: "invalid",
      collectorErrors: 1,
      events: [{ kind: "span_begin", phase: "encode", tsUs: 100 }],
    });
    expect(capture.report().events.some((event) => "durationUs" in event)).toBe(false);
  });

  it("bounds open spans and keeps malformed dimensions out of the report", () => {
    const capture = new ExportPerformanceCapture({
      enabled: true,
      supportedPhases: ["encode", "progress"],
      openSpanCapacity: 1,
      nowUs: () => 10,
    });
    const span = capture.begin("encode")!;
    expect(capture.begin("encode")).toBeNull();
    capture.mark("progress", { currentFrame: 1, leaked: "/private/path" } as never);
    capture.end(span, "ok");

    const report = capture.report();
    expect(report).toMatchObject({ status: "incomplete", eventsDropped: 1 });
    expect(JSON.stringify(report)).not.toContain("/private/path");
  });

  it("contains throwing sink adapters so instrumentation cannot fail the action", async () => {
    const throwingSupport = {
      enabled: true,
      supports: () => { throw new Error("probe failure"); },
      begin: () => null,
      end: () => undefined,
      mark: () => undefined,
    };
    const action = vi.fn(() => 7);
    const asyncAction = vi.fn(async () => 9);

    expect(withExportPerformance(throwingSupport, "submit", action)).toBe(7);
    await expect(withExportPerformanceSpan(throwingSupport, "prepare", asyncAction)).resolves.toBe(9);
    expect(action).toHaveBeenCalledOnce();
    expect(asyncAction).toHaveBeenCalledOnce();
  });
});
