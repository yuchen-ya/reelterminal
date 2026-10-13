import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  PERFORMANCE_IPC,
  isPerfClockPing,
} from "../../shared/performance-contract";
import { PerformanceSessionManager } from "./session";
import type { PerformanceSessionIpc } from "./session";
import type { ProcessMetricsSource } from "./process-sampler";

const SCHEMA = PERFORMANCE_CONTRACT_SCHEMA_VERSION;
/** Simulated renderer clock: renderer timestamps = main timestamps + 5000 us. */
const RENDERER_OFFSET_US = 5_000;

function fakeIpc() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const ipc: PerformanceSessionIpc = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      (listeners.get(channel) as Set<(payload: unknown) => void>).add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
  };
  return {
    ipc,
    registeredChannels: () => [...handlers.keys()],
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    invoke: (channel: string, payload: unknown) =>
      handlers.get(channel)?.(payload) ?? { ok: false, error: "invalid_request" as const },
    dispatch: (channel: string, payload: unknown) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
  };
}

function makeManager(withSampler = false) {
  const harness = fakeIpc();
  let mainUs = 0;
  const sentPings: unknown[] = [];
  const metricsSource: ProcessMetricsSource = {
    getAppMetrics: () => [{ type: "Browser", pid: 1, memory: { workingSetSize: 10 } }],
  };
  const manager = new PerformanceSessionManager({
    nowUs: () => mainUs,
    send: (channel, payload) => {
      if (channel !== PERFORMANCE_IPC.clockPing) return;
      sentPings.push(payload);
      if (!isPerfClockPing(payload)) return;
      // Renderer answers from a clock 5000 us ahead of main.
      const r1Us = mainUs + 100 + RENDERER_OFFSET_US;
      mainUs += 200;
      const r2Us = mainUs + RENDERER_OFFSET_US;
      mainUs += 150;
      setTimeout(() => {
        harness.dispatch(PERFORMANCE_IPC.clockPong, {
          schemaVersion: SCHEMA,
          attempt: payload.attempt,
          r1Us,
          r2Us,
        });
      }, 0);
    },
    ipc: harness.ipc,
    processMetricsSource: withSampler ? metricsSource : null,
    sleep: async () => {
      mainUs += 1_000;
    },
  });
  manager.install();
  return { manager, harness, advance: (us: number) => (mainUs += us), sentPings };
}

describe("PerformanceSessionManager", () => {
  it("runs a start → handshake → stop lifecycle with a simulated renderer", async () => {
    const { manager, harness, sentPings } = makeManager(true);
    const start = (await harness.invoke(PERFORMANCE_IPC.start, {
      schemaVersion: SCHEMA,
      mode: "light",
      runClockHandshake: true,
    })) as { ok: true; runId: string; clock: { valid: boolean; offsetUs: number | null; uncertaintyUs: number | null } };
    expect(start.ok).toBe(true);
    expect(typeof start.runId).toBe("string");
    expect(start.clock?.valid).toBe(true);
    expect(sentPings.length).toBeGreaterThanOrEqual(7);
    // Renderer is ahead by 5000 us → offset (main - renderer) ≈ -5000.
    expect(Math.abs((start.clock?.offsetUs as number) + RENDERER_OFFSET_US)).toBeLessThanOrEqual(
      start.clock?.uncertaintyUs as number,
    );
    expect(manager.active?.runId).toBe(start.runId);

    const stop = (await harness.invoke(PERFORMANCE_IPC.stop, {
      schemaVersion: SCHEMA,
      runId: start.runId,
      rendererReport: { status: "complete", secretFree: true },
    })) as { ok: true; runId: string; sessionDurationUs: number; processSamples: unknown[] };
    expect(stop.ok).toBe(true);
    expect(manager.active).toBeNull();
    expect(stop.sessionDurationUs).toBeGreaterThan(0);
    expect(stop.processSamples.length).toBeGreaterThanOrEqual(1);
    expect(manager.lastRendererReport).toEqual({ status: "complete", secretFree: true });
  });

  it("refuses duplicate sessions and unknown stops", async () => {
    const { manager, harness } = makeManager();
    const first = (await harness.invoke(PERFORMANCE_IPC.start, {
      schemaVersion: SCHEMA,
      mode: "counts",
    })) as { ok: true; runId: string };
    const second = (await harness.invoke(PERFORMANCE_IPC.start, {
      schemaVersion: SCHEMA,
      mode: "light",
    })) as { ok: false; error: string };
    expect(second.ok).toBe(false);
    expect(second.error).toBe("session_already_active");

    const wrongRun = (await harness.invoke(PERFORMANCE_IPC.stop, {
      schemaVersion: SCHEMA,
      runId: "not-the-run",
    })) as { ok: false; error: string };
    expect(wrongRun.error).toBe("invalid_request");

    const stop = (await harness.invoke(PERFORMANCE_IPC.stop, {
      schemaVersion: SCHEMA,
      runId: first.runId,
    })) as { ok: true };
    expect(stop.ok).toBe(true);

    const afterStop = (await harness.invoke(PERFORMANCE_IPC.stop, {
      schemaVersion: SCHEMA,
      runId: first.runId,
    })) as { ok: false; error: string };
    expect(afterStop.error).toBe("no_active_session");
    void manager;
  });

  it("rejects malformed payloads with invalid_request", async () => {
    const { harness } = makeManager();
    for (const payload of [null, undefined, {}, { schemaVersion: 99, mode: "light" }, "start"]) {
      const reply = (await harness.invoke(PERFORMANCE_IPC.start, payload)) as {
        ok: boolean;
        error?: string;
      };
      expect(reply.ok).toBe(false);
      expect(reply.error).toBe("invalid_request");
    }
  });

  it("keeps cross-process metrics unavailable until a valid, fresh handshake", async () => {
    const { manager, harness, advance } = makeManager();
    const start = { role: "renderer" as const, tsUs: 1_000_000 };
    const end = { role: "main" as const, tsUs: 2_000_000 };
    expect(manager.crossProcessDuration(start, end).status).toBe("unavailable");
    await manager.runClockHandshake();
    const okDuration = manager.crossProcessDuration(start, end, { nowUs: 10_000 });
    expect(okDuration.status).toBe("ok");
    advance(120_000_000);
    // Staleness needs a nowUs to compare against the estimate's age.
    const withNow = manager.crossProcessDuration(start, end, { nowUs: 130_000_000 });
    expect(withNow.status).toBe("stale");
    void harness;
  });

  it("uninstall removes handlers and discards an active session", async () => {
    const { manager, harness } = makeManager(true);
    await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, mode: "light" });
    expect(manager.active).not.toBeNull();
    manager.uninstall();
    expect(harness.registeredChannels()).toHaveLength(0);
    expect(manager.active).toBeNull();
  });

  it("tolerates a failing handshake without blocking the session", async () => {
    const harness = fakeIpc();
    let mainUs = 0;
    const manager = new PerformanceSessionManager({
      nowUs: () => mainUs,
      // Nobody answers pings: the handshake must time out, not hang.
      send: () => undefined,
      ipc: harness.ipc,
      sleep: async () => {
        mainUs += 1;
      },
      clockSyncOptions: { attempts: 7, timeoutMs: 5, attemptSpacingMs: 0 },
    });
    manager.install();
    const start = (await harness.invoke(PERFORMANCE_IPC.start, {
      schemaVersion: SCHEMA,
      mode: "light",
      runClockHandshake: true,
    })) as { ok: boolean; clock: { valid: boolean } | null };
    expect(start.ok).toBe(true);
    expect(start.clock?.valid).toBe(false);
  });
});
