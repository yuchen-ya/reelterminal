import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  PERFORMANCE_IPC,
  isPerfClockPing,
  isPerfClockPong,
  isPerfStartRequest,
  isPerfStopRequest,
} from "./performance-contract";

const SCHEMA = PERFORMANCE_CONTRACT_SCHEMA_VERSION;

describe("performance contract guards", () => {
  it("channels are stable and namespaced", () => {
    expect(PERFORMANCE_IPC.start).toBe("reelterminal:performance:start");
    expect(PERFORMANCE_IPC.stop).toBe("reelterminal:performance:stop");
    expect(PERFORMANCE_IPC.clockPing).toBe("reelterminal:performance:clock:ping");
    expect(PERFORMANCE_IPC.clockPong).toBe("reelterminal:performance:clock:pong");
  });

  it("accepts a well-formed start request and rejects drift", () => {
    expect(isPerfStartRequest({ schemaVersion: SCHEMA, mode: "light" })).toBe(true);
    expect(
      isPerfStartRequest({ schemaVersion: SCHEMA, runId: "r", mode: "counts", runClockHandshake: true }),
    ).toBe(true);
    expect(
      isPerfStartRequest({ schemaVersion: SCHEMA, mode: "light", budgets: { captureSeconds: 30 } }),
    ).toBe(true);
    expect(isPerfStartRequest({ schemaVersion: 2, mode: "light" })).toBe(false);
    expect(isPerfStartRequest({ schemaVersion: SCHEMA, mode: "off" })).toBe(false);
    expect(isPerfStartRequest({ schemaVersion: SCHEMA, mode: "light", runId: 7 })).toBe(false);
    expect(isPerfStartRequest({ schemaVersion: SCHEMA, mode: "light", budgets: { captureSeconds: "x" } })).toBe(false);
    expect(isPerfStartRequest(null)).toBe(false);
    expect(isPerfStartRequest("start")).toBe(false);
  });

  it("accepts a well-formed stop request and rejects drift", () => {
    expect(isPerfStopRequest({ schemaVersion: SCHEMA, runId: "r" })).toBe(true);
    expect(
      isPerfStopRequest({ schemaVersion: SCHEMA, runId: "r", reason: "user_stop", rendererReport: { a: 1 } }),
    ).toBe(true);
    expect(isPerfStopRequest({ schemaVersion: SCHEMA })).toBe(false);
    expect(isPerfStopRequest({ schemaVersion: SCHEMA, runId: "" })).toBe(false);
    expect(isPerfStopRequest({ schemaVersion: SCHEMA, runId: "r", reason: 5 })).toBe(false);
  });

  it("validates clock pings and pongs", () => {
    expect(isPerfClockPing({ schemaVersion: SCHEMA, attempt: 3 })).toBe(true);
    expect(isPerfClockPing({ schemaVersion: SCHEMA })).toBe(false);
    expect(isPerfClockPing({ schemaVersion: SCHEMA, attempt: -1 })).toBe(false);
    expect(isPerfClockPing({ schemaVersion: SCHEMA, attempt: 1.5 })).toBe(false);
    expect(isPerfClockPong({ schemaVersion: SCHEMA, attempt: 3, r1Us: 10, r2Us: 11 })).toBe(true);
    expect(isPerfClockPong({ schemaVersion: SCHEMA, attempt: 3, r1Us: -1, r2Us: 11 })).toBe(false);
    expect(isPerfClockPong({ schemaVersion: SCHEMA, attempt: 3, r1Us: Number.NaN, r2Us: 11 })).toBe(false);
    expect(isPerfClockPong({ schemaVersion: SCHEMA, attempt: 3 })).toBe(false);
  });
});
