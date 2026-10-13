import { describe, expect, it } from "vitest";
import { createRendererClock } from "./renderer-clock";

describe("renderer clock", () => {
  it("converts injected milliseconds to microseconds", () => {
    const readings = [0, 1.5, 2.567, 1234.5];
    let i = 0;
    const clock = createRendererClock({ nowMs: () => readings[i++] });
    expect(clock.nowUs()).toBe(0);
    expect(clock.nowUs()).toBe(1500);
    expect(clock.nowUs()).toBe(2567);
    expect(clock.nowUs()).toBe(1234500);
  });

  it("gives every clock a unique id and keeps the injected epoch", () => {
    const a = createRendererClock({ epoch: "epoch-a", nowMs: () => 0 });
    const b = createRendererClock({ epoch: "epoch-a", nowMs: () => 0 });
    expect(a.clockId).not.toBe(b.clockId);
    expect(a.clockId).toContain("epoch-a");
    expect(a.processEpoch).toBe("epoch-a");
  });

  it("records the time origin as metadata", () => {
    const clock = createRendererClock({ nowMs: () => 0, timeOriginMs: 1728.5 });
    expect(clock.timeOriginUs).toBe(1728500);
  });

  it("generates a random epoch per clock by default", () => {
    const a = createRendererClock({ nowMs: () => 0 });
    const b = createRendererClock({ nowMs: () => 0 });
    expect(a.processEpoch).not.toBe(b.processEpoch);
    expect(a.processEpoch).toMatch(/^[0-9a-f]{16}$/);
  });
});
