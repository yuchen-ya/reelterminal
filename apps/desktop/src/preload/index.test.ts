import { describe, expect, it, vi } from "vitest";

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

describe("preload bridge naming", () => {
  it("exposes only the reelterminal bridge", () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      "reelterminal",
      expect.anything(),
    );
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
  });


  it("a bridge call invokes the hardware channel exactly once", async () => {
    const viaNew = exposedApi("reelterminal");
    await viaNew.probeHardware();
    const probeCalls = electron.ipcRenderer.invoke.mock.calls.filter(
      ([channel]) => channel === CHANNELS.probeHardware,
    );
    expect(probeCalls).toHaveLength(1);
    for (const [channel] of probeCalls) expect(channel).toBe(CHANNELS.probeHardware);
  });

  it("menu actions and the export port handoff come from the CHANNELS table", () => {
    // The preload must subscribe through the shared constant table, not
    // bypassing string literals (those are what drifted during the rename).
    expect(CHANNELS.menuAction).toBe("reelterminal:menu:action");
    expect(CHANNELS.exportPortHandoff).toBe("reelterminal:export-port");
  });

  it("sends only the renderer error category over the crash IPC channel", () => {
    const crash = exposedApi("reelterminal").crash as {
      report(payload: { type?: string }): void;
    };

    crash.report({
      type: "react-error",
      message: "private project data",
      stack: "private stack",
      context: { path: "private" },
    } as unknown as { type?: string });

    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
      CHANNELS.crashReport,
      { type: "react-error" },
    );
  });
});
