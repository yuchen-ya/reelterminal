import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock("electron", () => electron);

import {
  PERFORMANCE_BRIDGE_WORLD,
  installPerformanceBridge,
} from "./performance-bridge";
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  PERFORMANCE_IPC,
} from "../shared/performance-contract";

function installWithFakes() {
  const exposed = new Map<string, unknown>();
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const invoked: Array<{ channel: string; payload: unknown }> = [];
  let nowMs = 0;
  installPerformanceBridge({
    exposeInMainWorld: (name, api) => exposed.set(name, api),
    invoke: async (channel, payload) => {
      invoked.push({ channel, payload });
      return { ok: true };
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      (listeners.get(channel) as Array<(payload: unknown) => void>).push(listener);
    },
    nowMs: () => (nowMs += 0.25),
  });
  const dispatch = (channel: string, payload: unknown): void => {
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
  };
  return { exposed, sent, invoked, dispatch };
}

describe("performance bridge", () => {
  it("exposes only the controlled performance surface", () => {
    const { exposed } = installWithFakes();
    expect(exposed.size).toBe(1);
    const api = exposed.get(PERFORMANCE_BRIDGE_WORLD) as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual(["start", "stop"]);
    // No fs surface, no project getters.
    expect(api.fs).toBeUndefined();
    expect(api.getProject).toBeUndefined();
  });

  it("delegates start/stop to the contract channels", async () => {
    const { exposed, invoked } = installWithFakes();
    const api = exposed.get(PERFORMANCE_BRIDGE_WORLD) as {
      start(request: unknown): Promise<unknown>;
      stop(request: unknown): Promise<unknown>;
    };
    await api.start({ schemaVersion: PERFORMANCE_CONTRACT_SCHEMA_VERSION, mode: "light" });
    await api.stop({ schemaVersion: PERFORMANCE_CONTRACT_SCHEMA_VERSION, runId: "r" });
    expect(invoked.map((i) => i.channel)).toEqual([PERFORMANCE_IPC.start, PERFORMANCE_IPC.stop]);
  });

  it("answers valid clock pings with numeric renderer timestamps", () => {
    const { sent, dispatch } = installWithFakes();
    dispatch(PERFORMANCE_IPC.clockPing, {
      schemaVersion: PERFORMANCE_CONTRACT_SCHEMA_VERSION,
      attempt: 4,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(PERFORMANCE_IPC.clockPong);
    const pong = sent[0].payload as { attempt: number; r1Us: number; r2Us: number };
    expect(pong.attempt).toBe(4);
    expect(Number.isFinite(pong.r1Us)).toBe(true);
    expect(Number.isFinite(pong.r2Us)).toBe(true);
    expect(pong.r2Us).toBeGreaterThanOrEqual(pong.r1Us);
  });

  it("stays silent for malformed pings", () => {
    const { sent, dispatch } = installWithFakes();
    dispatch(PERFORMANCE_IPC.clockPing, { attempt: "four" });
    dispatch(PERFORMANCE_IPC.clockPing, null);
    dispatch(PERFORMANCE_IPC.clockPing, { schemaVersion: 99, attempt: 1 });
    expect(sent).toHaveLength(0);
  });
});
