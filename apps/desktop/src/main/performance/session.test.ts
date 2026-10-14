import { describe, expect, it, vi } from "vitest";
import {
  beginPerfOperation,
  endPerfOperation,
  getPerfSink,
  markPerfOperation,
  NOOP_SINK,
  validatePerformanceEvent,
} from "@reelterminal/core";
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

function makeManager(withSampler = false, onSleep?: () => void | Promise<void>) {
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
      await onSleep?.();
    },
  });
  manager.install();
  return { manager, harness, advance: (us: number) => (mainUs += us), sentPings };
}

describe("PerformanceSessionManager", () => {
  it("retains genuine asynchronous IPC span completion while sealing new stop-time admissions", async () => {
    let pending: ReturnType<typeof beginPerfOperation>;
    let sleeps = 0;
    const { manager, harness } = makeManager(false, () => {
      sleeps++;
      expect(getPerfSink()).toBe(NOOP_SINK);
      expect(beginPerfOperation("new-after-stop")).toBeUndefined();
      expect(pending!.sink.begin("new-retained-sink-work", pending!.context).id).toBe(0);
      endPerfOperation(pending, "ok");
    });
    try {
      await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, runId: "stop-ipc-tail", mode: "light" });
      pending = beginPerfOperation("live.ipc.main.request");
      const reply = await harness.invoke(PERFORMANCE_IPC.stop, { schemaVersion: SCHEMA, runId: "stop-ipc-tail" }) as { ok: boolean; mainCapture: { status: string; openSpans: number; events: { kind: string; phase: string }[] } };
      expect(sleeps).toBe(1);
      expect(reply.mainCapture.status).toBe("complete");
      expect(reply.mainCapture.openSpans).toBe(0);
      expect(reply.mainCapture.events.filter(event => event.kind === "span_end" && event.phase === "live.ipc.main.request")).toHaveLength(1);
    } finally { manager.uninstall(); }
  });

  it("keeps a genuinely unfinished span incomplete after the bounded stop wait", async () => {
    let sleeps = 0;
    const { manager, harness } = makeManager(false, () => { sleeps++; });
    try {
      await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, runId: "stop-stuck", mode: "light" });
      beginPerfOperation("live.ipc.main.request");
      const reply = await harness.invoke(PERFORMANCE_IPC.stop, { schemaVersion: SCHEMA, runId: "stop-stuck" }) as { mainCapture: { status: string; openSpans: number; reasonCodes: string[] } };
      expect(sleeps).toBe(10);
      expect(reply.mainCapture.status).toBe("incomplete");
      expect(reply.mainCapture.openSpans).toBe(1);
      expect(reply.mainCapture.reasonCodes).toContain("main_spans_left_open");
    } finally { manager.uninstall(); }
  });

  it("does not let a stopped old session finish or erase a replacement session", async () => {
    let replacement: unknown;
    const { manager, harness } = makeManager(false, async () => {
      manager.abortActiveSession();
      replacement = await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, runId: "stop-new", mode: "light" });
    });
    try {
      await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, runId: "stop-old", mode: "light" });
      beginPerfOperation("live.ipc.main.request");
      expect(await harness.invoke(PERFORMANCE_IPC.stop, { schemaVersion: SCHEMA, runId: "stop-old" })).toEqual({ ok: false, error: "no_active_session" });
      expect(replacement).toMatchObject({ ok: true });
      expect(manager.active?.runId).toBe("stop-new");
      expect(await harness.invoke(PERFORMANCE_IPC.stop, { schemaVersion: SCHEMA, runId: "stop-new" })).toMatchObject({ ok: true });
    } finally { manager.uninstall(); }
  });

  it("keeps the hard capture deadline active while waiting for an IPC tail", async () => {
    vi.useFakeTimers();
    const { manager, harness } = makeManager(false, async () => { await vi.advanceTimersByTimeAsync(1000); });
    try {
      await harness.invoke(PERFORMANCE_IPC.start, { schemaVersion: SCHEMA, runId: "stop-deadline", mode: "light", budgets: { captureSeconds: 1 } });
      beginPerfOperation("live.ipc.main.request");
      const reply = await harness.invoke(PERFORMANCE_IPC.stop, { schemaVersion: SCHEMA, runId: "stop-deadline" }) as { mainCapture: { status: string; openSpans: number; reasonCodes: string[] } };
      expect(reply.mainCapture.status).toBe("incomplete");
      expect(reply.mainCapture.openSpans).toBe(1);
      expect(reply.mainCapture.reasonCodes).toContain("main_capture_budget_exceeded");
    } finally { manager.uninstall(); vi.useRealTimers(); }
  });
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
    })) as { ok: true; runId: string; sessionDurationUs: number; processSamples: unknown[] };
    expect(stop.ok).toBe(true);
    expect(manager.active).toBeNull();
    expect(stop.sessionDurationUs).toBeGreaterThan(0);
    expect(stop.processSamples.length).toBeGreaterThanOrEqual(1);
  });

  it("captures main-process IPC spans on their own monotonic clock", async () => {
    const { manager, harness } = makeManager();
    const start = (await harness.invoke(PERFORMANCE_IPC.start, {
      schemaVersion: SCHEMA,
      runId: "shared-run",
      mode: "light",
    })) as { ok: true; runId: string };
    const operation = beginPerfOperation("live.ipc.main.request", undefined, {
      operationId: "live-call-1",
    });
    markPerfOperation(operation, "live.ipc.main.reply", { ok: true });
    endPerfOperation(operation, "ok");

    const stop = (await harness.invoke(PERFORMANCE_IPC.stop, {
      schemaVersion: SCHEMA,
      runId: start.runId,
    })) as {
      ok: true;
      mainCapture: {
        runId: string;
        clockId: string;
        processEpoch: string;
        events: readonly unknown[];
      };
    };
    expect(stop.mainCapture.runId).toBe("shared-run");
    expect(stop.mainCapture.clockId).toContain("main-clock-");
    expect(stop.mainCapture.processEpoch).toContain("main-epoch-");
    expect(stop.mainCapture.events).toHaveLength(3);
    for (const event of stop.mainCapture.events) {
      expect(validatePerformanceEvent(event).valid).toBe(true);
      expect(event).toMatchObject({ processRole: "main", runId: "shared-run" });
    }
    manager.uninstall();
  });

  it("auto-stops the main sink at the requested duration and returns its final report", async () => {
    vi.useFakeTimers();
    const { manager, harness } = makeManager();
    try {
      const start = (await harness.invoke(PERFORMANCE_IPC.start, {
        schemaVersion: SCHEMA,
        runId: "bounded-run",
        mode: "counts",
        budgets: { captureSeconds: 1 },
      })) as { ok: true; runId: string };
      expect(manager.active?.runId).toBe(start.runId);
      expect(getPerfSink()).not.toBe(NOOP_SINK);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(manager.active).toBeNull();
      expect(getPerfSink()).toBe(NOOP_SINK);
      const stop = (await harness.invoke(PERFORMANCE_IPC.stop, {
        schemaVersion: SCHEMA,
        runId: start.runId,
      })) as {
        ok: true;
        mainCapture: {
          runId: string;
          status: string;
          reasonCodes: readonly string[];
          events: readonly unknown[];
        };
      };
      expect(stop.mainCapture.runId).toBe(start.runId);
      expect(stop.mainCapture.status).toBe("incomplete");
      expect(stop.mainCapture.reasonCodes).toContain("main_capture_budget_exceeded");
      expect(stop.mainCapture.events).toHaveLength(0);
    } finally {
      manager.uninstall();
      vi.useRealTimers();
    }
  });

  it("anchors the hard duration before clock sync and rejects an expired start", async () => {
    vi.useFakeTimers();
    const harness = fakeIpc();
    let mainUs = 0;
    const manager = new PerformanceSessionManager({
      nowUs: () => mainUs,
      send: () => undefined,
      ipc: harness.ipc,
      sleep: async () => undefined,
      clockSyncOptions: { attempts: 1, timeoutMs: 10_000, attemptSpacingMs: 0, minSamples: 1 },
    });
    manager.install();
    try {
      const startPromise = harness.invoke(PERFORMANCE_IPC.start, {
        schemaVersion: SCHEMA,
        runId: "expires-during-handshake",
        mode: "light",
        runClockHandshake: true,
        budgets: { captureSeconds: 1 },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const start = await startPromise as { ok: boolean; error?: string };
      expect(start).toEqual({ ok: false, error: "capture_expired" });
      expect(manager.active).toBeNull();
      expect(getPerfSink()).toBe(NOOP_SINK);
    } finally {
      manager.uninstall();
      vi.useRealTimers();
    }
  });

  it("cancels an old renderer clock handshake before starting a fresh session", async () => {
    const harness = fakeIpc();
    let runLabel = "first";
    let mainUs = 0;
    const manager = new PerformanceSessionManager({
      nowUs: () => (mainUs += 10),
      send: (channel, payload) => {
        if (channel !== PERFORMANCE_IPC.clockPing || runLabel !== "second") return;
        const ping = payload as { attempt: number };
        const m0Us = mainUs;
        queueMicrotask(() => {
          harness.dispatch(PERFORMANCE_IPC.clockPong, {
            schemaVersion: SCHEMA,
            attempt: ping.attempt,
            r1Us: m0Us,
            r2Us: m0Us,
          });
        });
      },
      ipc: harness.ipc,
      sleep: async () => undefined,
      clockSyncOptions: { attempts: 1, timeoutMs: 10_000, attemptSpacingMs: 0, minSamples: 1 },
    });
    manager.install();
    const request = (runId: string) => ({
      schemaVersion: SCHEMA,
      runId,
      mode: "light",
      runClockHandshake: true,
      budgets: { captureSeconds: 30 },
    });
    try {
      const firstPromise = harness.invoke(PERFORMANCE_IPC.start, request("first-run"));
      manager.abortActiveSession();
      runLabel = "second";
      const second = await harness.invoke(PERFORMANCE_IPC.start, request("second-run")) as {
        ok: boolean;
        runId?: string;
        clock?: { valid: boolean } | null;
      };
      const first = await firstPromise as { ok: boolean; error?: string };

      expect(first).toEqual({ ok: false, error: "capture_expired" });
      expect(second).toMatchObject({ ok: true, runId: "second-run", clock: { valid: true } });
      expect(manager.active?.runId).toBe("second-run");
      const stop = await harness.invoke(PERFORMANCE_IPC.stop, {
        schemaVersion: SCHEMA,
        runId: "second-run",
      }) as { ok: boolean };
      expect(stop.ok).toBe(true);
      expect(manager.lastClockEstimate?.valid).toBe(true);
    } finally {
      manager.uninstall();
    }
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
    manager.uninstall();
  });
});
