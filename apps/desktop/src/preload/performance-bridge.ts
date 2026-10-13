/**
 * Preload bridge for the performance system (design phase P1).
 *
 * Exposes ONLY controlled start/stop invokes plus an automatic clock-pong
 * responder: a ping arrives, the bridge answers once with r1/r2 taken from
 * this renderer's performance.now() — the same time base as the renderer
 * capture clock. No fs surface, no raw project getters, and malformed pings
 * get no reply at all (their timestamps could not be trusted anyway).
 *
 * NOT registered by preload/index.ts in P1 — its existing test asserts a
 * single exposed bridge. Registration happens together with the e2e driver
 * wiring (P2), behind the performance capture being explicitly requested.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  PERFORMANCE_CONTRACT_SCHEMA_VERSION,
  PERFORMANCE_IPC,
  isPerfClockPing,
} from "../shared/performance-contract";

export const PERFORMANCE_BRIDGE_WORLD = "reelterminalPerformance";

export interface PerformanceBridgeDeps {
  exposeInMainWorld(name: string, api: unknown): void;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  send(channel: string, payload?: unknown): void;
  on(channel: string, listener: (payload: unknown) => void): void;
  nowMs(): number;
}

export interface PerformanceBridgeApi {
  start(request: unknown): Promise<unknown>;
  stop(request: unknown): Promise<unknown>;
}

export function installPerformanceBridge(overrides: Partial<PerformanceBridgeDeps> = {}): void {
  const deps: PerformanceBridgeDeps = {
    exposeInMainWorld: (name, api) => contextBridge.exposeInMainWorld(name, api),
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, listener) => ipcRenderer.on(channel, (_event, payload) => listener(payload)),
    nowMs: () => performance.now(),
    ...overrides,
  };

  const pongListener = (payload: unknown): void => {
    if (!isPerfClockPing(payload)) return;
    const r1Us = Math.round(deps.nowMs() * 1000);
    const r2Us = Math.round(deps.nowMs() * 1000);
    deps.send(PERFORMANCE_IPC.clockPong, {
      schemaVersion: PERFORMANCE_CONTRACT_SCHEMA_VERSION,
      attempt: payload.attempt,
      r1Us,
      r2Us,
    });
  };
  deps.on(PERFORMANCE_IPC.clockPing, pongListener);

  const api: PerformanceBridgeApi = {
    start: (request: unknown) => deps.invoke(PERFORMANCE_IPC.start, request),
    stop: (request: unknown) => deps.invoke(PERFORMANCE_IPC.stop, request),
  };
  deps.exposeInMainWorld(PERFORMANCE_BRIDGE_WORLD, api);
}
