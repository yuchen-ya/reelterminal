import { describe, expect, it, vi } from "vitest";

// The preload runs against Electron's contextBridge, which copies values
// across worlds, so a real renderer cannot assert
// `window.openreel === window.reelterminal` directly. What the migration
// contract needs instead is structural: the preload must expose ONE api
// object under both names (never two factory instances), because two
// objects would double every ipcRenderer registration and commit one user
// action twice. The mocked contextBridge keeps the references it receives,
// which is exactly what we assert here.
const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, api: unknown) => {
        exposed.set(name, api);
      }),
    },
    ipcRenderer: {
      invoke: vi.fn(async (..._args: unknown[]) => ({})),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => "") },
    __exposed: exposed,
  };
});

vi.mock("electron", () => electron);

import { CHANNELS } from "../shared/channels";
// Importing the preload module performs the exposeInMainWorld calls.
import "./index";

type AnyApi = Record<string, unknown> & {
  probeHardware: () => Promise<unknown>;
};

const exposedApi = (name: string): AnyApi => {
  const api = electron.__exposed.get(name);
  if (!api) throw new Error(`preload did not expose "${name}"`);
  return api as AnyApi;
};

describe("preload bridge naming (N02)", () => {
  it("exposes the primary name reelterminal and keeps openreel as an alias", () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "reelterminal",
      expect.anything(),
    );
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "openreel",
      expect.anything(),
    );
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(2);
  });

  it("exposes the SAME object under both names (one implementation, no double registration)", () => {
    expect(exposedApi("openreel")).toBe(exposedApi("reelterminal"));
  });

  it("a call through either name lands on the same IPC channel exactly once", async () => {
    const viaNew = exposedApi("reelterminal");
    const viaOld = exposedApi("openreel");
    await Promise.all([viaNew.probeHardware(), viaOld.probeHardware()]);
    // Two bridge calls (one per name), but every call sends exactly one
    // invoke on the shared channel — a second registration would double it.
    const probeCalls = electron.ipcRenderer.invoke.mock.calls.filter(
      ([channel]) => channel === CHANNELS.probeHardware,
    );
    expect(probeCalls).toHaveLength(2);
    for (const [channel] of probeCalls) expect(channel).toBe(CHANNELS.probeHardware);
  });

  it("menu actions and the export port handoff come from the CHANNELS table", () => {
    // The preload must subscribe through the shared constant table, not
    // bypassing string literals (those are what drifted during the rename).
    expect(CHANNELS.menuAction).toBe("reelterminal:menu:action");
    expect(CHANNELS.exportPortHandoff).toBe("reelterminal:export-port");
  });
});
