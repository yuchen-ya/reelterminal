import { describe, expect, it } from "vitest";
import {
  ClockSynchronizer,
  convertRendererTimestamp,
  crossProcessDuration,
  estimateClockOffset,
  type ClockHandshakeSample,
  type ClockSyncTransport,
} from "./clock-sync";
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  type PerfClockPing,
  type PerfClockPong,
} from "../../shared/performance-contract";

const SCHEMA = PERFORMANCE_CONTRACT_SCHEMA_VERSION;

function sample(overrides: Partial<ClockHandshakeSample>): ClockHandshakeSample {
  return {
    attempt: 1,
    m0Us: 1_000_000,
    r1Us: 1_002_000,
    r2Us: 1_002_000,
    m3Us: 1_004_000,
    ...overrides,
  };
}

describe("estimateClockOffset", () => {
  it("recovers a constant offset from clean samples", () => {
    // Renderer clock runs 2500 us ahead of main (offset = main - renderer =
    // -2500), with symmetric 2000 us one-way delays.
    const samples = Array.from({ length: 7 }, (_, i) =>
      sample({
        attempt: i + 1,
        m0Us: 1_000_000 + i * 10_000,
        r1Us: 1_004_500 + i * 10_000,
        r2Us: 1_004_500 + i * 10_000,
        m3Us: 1_004_000 + i * 10_000,
      }),
    );
    const estimate = estimateClockOffset(samples);
    expect(estimate.valid).toBe(true);
    expect(estimate.offsetUs).toBe(-2500);
    expect(estimate.uncertaintyUs).toBeGreaterThan(0);
    expect(estimate.validSampleCount).toBe(7);
    expect(estimate.intersectionLowerUs).toBeLessThanOrEqual(estimate.intersectionUpperUs as number);
  });

  it("requires the minimum sample count", () => {
    const three = estimateClockOffset([sample({ attempt: 1 }), sample({ attempt: 2 }), sample({ attempt: 3 })]);
    expect(three.valid).toBe(false);
    expect(three.invalidReason).toBe("insufficient_samples");
    const none = estimateClockOffset([]);
    expect(none.valid).toBe(false);
    expect(none.invalidReason).toBe("no_valid_samples");
  });

  it("excludes non-monotonic and negative-delay samples", () => {
    const good = (attempt: number): ClockHandshakeSample =>
      sample({ attempt, m0Us: attempt * 20_000, r1Us: attempt * 20_000 + 500, r2Us: attempt * 20_000 + 500, m3Us: attempt * 20_000 + 4_000 });
    const broken = [
      // r2 before r1 far beyond tolerance.
      sample({ attempt: 90, r1Us: 5_000_000, r2Us: 4_000_000 }),
      // negative transport delay beyond tolerance.
      sample({ attempt: 91, m0Us: 1_000_000, r1Us: 900_000, r2Us: 3_000_000, m3Us: 1_100_000 }),
    ];
    const estimate = estimateClockOffset([
      ...Array.from({ length: 7 }, (_, i) => good(i + 1)),
      ...broken,
    ]);
    expect(estimate.valid).toBe(true);
    expect(estimate.validSampleCount).toBe(7);
    expect(estimate.sampleCount).toBe(9);
  });

  it("grows uncertainty with spread and drift age", () => {
    const clean = Array.from({ length: 7 }, (_, i) => sample({ attempt: i + 1 }));
    const fresh = estimateClockOffset(clean, { ageUs: 0 });
    // Same round-trip delay as clean (4000 us) but midpoints alternating by
    // 5000 us — the spread term must dominate the causal half-width.
    const spread = Array.from({ length: 7 }, (_, i) =>
      sample({
        attempt: i + 1,
        m0Us: i * 10_000,
        r1Us: i * 10_000 + 5_000 * (i % 2),
        r2Us: i * 10_000 + 5_000 * (i % 2),
        m3Us: i * 10_000 + 4_000,
      }),
    );
    const spreadEstimate = estimateClockOffset(spread, { ageUs: 0 });
    expect(spreadEstimate.uncertaintyUs as number).toBeGreaterThan(
      fresh.uncertaintyUs as number,
    );
    const aged = estimateClockOffset(clean, { ageUs: 60_000_000 });
    // 50 ppm over 60 s → ~3000 us of drift allowance.
    expect((aged.uncertaintyUs as number) - (fresh.uncertaintyUs as number)).toBeGreaterThanOrEqual(
      2_900,
    );
  });
});

describe("ClockSynchronizer", () => {
  function makeTransport(rendererOffsetUs: number, jitterUs = 20) {
    let mainUs = 0;
    const sent: PerfClockPing[] = [];
    let pongListener: ((pong: PerfClockPong) => void) | null = null;
    const transport: ClockSyncTransport & { advance(us: number): void; sentPings: PerfClockPing[] } = {
      advance: (us) => {
        mainUs += us;
      },
      sentPings: sent,
      nowUs: () => mainUs,
      sendPing: (ping) => {
        sent.push(ping);
        // Deliver m0→r1 with outbound delay, reply r2→m3 with inbound delay.
        const r1 = mainUs + 500 + rendererOffsetUs;
        mainUs += 600;
        const r2 = mainUs + rendererOffsetUs;
        mainUs += 700;
        const jitter = sent.length % 2 === 0 ? jitterUs : 0;
        // Re-emit on a later microtask so m3 is captured after the wait.
        setTimeout(() => {
          mainUs += jitter;
          pongListener?.({
            schemaVersion: SCHEMA,
            attempt: ping.attempt,
            r1Us: r1,
            r2Us: r2,
          });
        }, 0);
      },
      onPong: (callback) => {
        pongListener = callback;
        return () => {
          pongListener = null;
        };
      },
      delay: async () => {
        mainUs += 1_000;
      },
    };
    return transport;
  }

  it("recovers the simulated renderer offset", async () => {
    const transport = makeTransport(2_500);
    const synchronizer = new ClockSynchronizer(transport, { attempts: 7 });
    const result = await synchronizer.runHandshake();
    expect(transport.sentPings).toHaveLength(7);
    expect(result.valid).toBe(true);
    expect(result.estimatedAtUs).toBeGreaterThan(0);
    // True offset is +2500 (renderer ahead); estimate = main - renderer.
    expect(Math.abs((result.offsetUs as number) + 2_500)).toBeLessThanOrEqual(
      result.uncertaintyUs as number,
    );
  });

  it("goes invalid when too few pongs return", async () => {
    const transport = makeTransport(0);
    const blackhole: ClockSyncTransport = {
      ...transport,
      sendPing: () => undefined,
    };
    const synchronizer = new ClockSynchronizer(blackhole, {
      attempts: 7,
      timeoutMs: 5,
      attemptSpacingMs: 0,
    });
    const result = await synchronizer.runHandshake();
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe("no_valid_samples");
  });

  it("ignores late pongs from earlier timed-out attempts", async () => {
    const transport = makeTransport(100);
    let pongSink: ((pong: PerfClockPong) => void) | null = null;
    const wrapped: ClockSyncTransport = {
      nowUs: transport.nowUs,
      sendPing: (ping) => {
        if (ping.attempt === 3) {
          // A very late answer for the timed-out attempt 2 arrives while
          // attempt 3 is waiting; the attempt mismatch must drop it.
          setTimeout(() => {
            pongSink?.({ schemaVersion: SCHEMA, attempt: 2, r1Us: 9_999_999, r2Us: 9_999_999 });
          }, 0);
        }
        if (ping.attempt !== 2) transport.sendPing(ping);
        // Attempt 2 never answers: it times out.
      },
      onPong: (callback) => {
        pongSink = callback;
        return transport.onPong(callback);
      },
      delay: transport.delay,
    };
    const synchronizer = new ClockSynchronizer(wrapped, {
      attempts: 8,
      timeoutMs: 5,
      attemptSpacingMs: 0,
    });
    const result = await synchronizer.runHandshake();
    expect(result.valid).toBe(true);
    expect(result.samples.every((s) => s.attempt !== 2)).toBe(true);
    expect(result.sampleCount).toBe(7);
  });

  it("rejects a concurrent handshake", async () => {
    const transport = makeTransport(0);
    const synchronizer = new ClockSynchronizer(transport, { attempts: 7 });
    const first = synchronizer.runHandshake();
    await expect(synchronizer.runHandshake()).rejects.toThrow();
    await first;
  });

  it("cancels a pending exchange and settles the handshake without waiting for timeout", async () => {
    const transport = makeTransport(0);
    const blackhole: ClockSyncTransport = { ...transport, sendPing: () => undefined };
    const synchronizer = new ClockSynchronizer(blackhole, {
      attempts: 7,
      timeoutMs: 10_000,
      attemptSpacingMs: 0,
    });
    const handshake = synchronizer.runHandshake();
    expect(synchronizer.isRunning).toBe(true);

    synchronizer.cancel();
    const result = await handshake;

    expect(synchronizer.isRunning).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe("no_valid_samples");
  });
});

describe("cross-process conversions", () => {
  const estimate = {
    ...estimateClockOffset(
      Array.from({ length: 7 }, (_, i) =>
        sample({
          attempt: i + 1,
          m0Us: 1_000_000 + i * 10_000,
          r1Us: 1_004_500 + i * 10_000,
          r2Us: 1_004_500 + i * 10_000,
          m3Us: 1_004_000 + i * 10_000,
        }),
      ),
    ),
    estimatedAtUs: 1_000,
  };

  it("converts renderer timestamps with the estimated offset", () => {
    const converted = convertRendererTimestamp(5_000_000, estimate);
    expect(converted?.mainTsUs).toBe(4_997_500);
    expect(converted?.uncertaintyUs).toBeGreaterThan(0);
  });

  it("returns null conversions for an invalid estimate", () => {
    const invalid = estimateClockOffset([]);
    expect(convertRendererTimestamp(5_000_000, invalid)).toBeNull();
  });

  it("classifies durations as unavailable / stale / indeterminate / ok", () => {
    const start = { role: "renderer" as const, tsUs: 1_000_000 };
    expect(crossProcessDuration(start, { role: "main", tsUs: 900_000 }, null).status).toBe(
      "unavailable",
    );
    const stale = crossProcessDuration(start, { role: "main", tsUs: 900_000 }, estimate, {
      nowUs: 120_000_000,
    });
    expect(stale.status).toBe("stale");
    // |duration| below the uncertainty cannot gate.
    const tiny = crossProcessDuration(start, { role: "main", tsUs: 997_600 }, estimate, {
      nowUs: 1_000,
    });
    expect(tiny.status).toBe("indeterminate");
    const clear = crossProcessDuration(start, { role: "main", tsUs: 5_000_000 }, estimate, {
      nowUs: 1_000,
    });
    expect(clear.status).toBe("ok");
    expect(clear.durationUs).toBeGreaterThan(0);
    expect(clear.uncertaintyUs).toBe((estimate.uncertaintyUs as number) * 2);
  });
});
