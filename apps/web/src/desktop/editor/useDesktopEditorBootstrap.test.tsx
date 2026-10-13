import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  getPerfSink,
  setPerfSink,
  type Outcome,
  type PerfOperation,
  type PerfSink,
} from "@reelterminal/core";

const mocks = vi.hoisted(() => {
  const engineState = {
    initialized: false,
    initializing: false,
    initError: null as string | null,
    initialize: vi.fn(async (_parent?: unknown) => {
      engineState.initialized = true;
    }),
  };
  const projectState = {
    project: { settings: { width: 1920, height: 1080 } },
    initializeAutoSave: vi.fn(async () => undefined),
  };
  return {
    engineState,
    projectState,
    initializeMediaBridge: vi.fn(async () => undefined),
    initializePlaybackBridge: vi.fn(async () => undefined),
    initializeRenderBridge: vi.fn(async () => undefined),
    initializeEffectsBridge: vi.fn(async () => undefined),
    initializeTransitionBridge: vi.fn(),
    syncTransitionBridgeFromProject: vi.fn(),
  };
});

vi.mock("../../stores/engine-store", () => ({
  useEngineStore: {
    getState: vi.fn(() => mocks.engineState),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(() => mocks.projectState),
  },
}));

vi.mock("../../bridges/media-bridge", () => ({
  initializeMediaBridge: mocks.initializeMediaBridge,
}));
vi.mock("../../bridges/playback-bridge", () => ({
  initializePlaybackBridge: mocks.initializePlaybackBridge,
}));
vi.mock("../../bridges/render-bridge", () => ({
  initializeRenderBridge: mocks.initializeRenderBridge,
}));
vi.mock("../../bridges/effects-bridge", () => ({
  initializeEffectsBridge: mocks.initializeEffectsBridge,
}));
vi.mock("../../bridges/transition-bridge", () => ({
  initializeTransitionBridge: mocks.initializeTransitionBridge,
  syncTransitionBridgeFromProject: mocks.syncTransitionBridgeFromProject,
}));

import { useDesktopEditorBootstrap } from "./useDesktopEditorBootstrap";

describe("useDesktopEditorBootstrap", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.engineState.initialized = false;
    mocks.engineState.initializing = false;
  });

  it("initializes engine, bridges, and autosave while recording the bootstrap stages", async () => {
    const events: Array<{
      phase: string;
      outcome?: Outcome;
      spanId?: number;
      parentSpanId?: number;
    }> = [];
    const transitionOrdering: string[] = [];
    const phaseBySpan = new Map<number, string>();
    let nextSpanId = 0;
    const previousSink = getPerfSink();
    const sink: PerfSink = {
      enabled: true,
      mode: "trace",
      runId: "bootstrap-test",
      begin: (phase, context) => {
        const id = ++nextSpanId;
        phaseBySpan.set(id, phase);
        events.push({ phase, spanId: id, parentSpanId: context.parentSpanId });
        return { id, startedUs: id };
      },
      end: (span, outcome) => {
        events.push({ phase: phaseBySpan.get(span.id) ?? "", outcome });
      },
      mark: (phase) => events.push({ phase }),
      count: () => undefined,
    };
    mocks.initializeTransitionBridge.mockImplementation(() => {
      transitionOrdering.push("transition");
      queueMicrotask(() => transitionOrdering.push("transition-microtask"));
    });
    mocks.projectState.initializeAutoSave.mockImplementation(async () => {
      transitionOrdering.push("autosave");
    });
    setPerfSink(sink);

    try {
      const { result } = renderHook(() => useDesktopEditorBootstrap());
      await waitFor(() => {
        expect(result.current.ready || result.current.error).toBeTruthy();
      });

      expect(result.current.error).toBeNull();
      expect(mocks.engineState.initialize).toHaveBeenCalledTimes(1);
      expect(mocks.initializeMediaBridge).toHaveBeenCalledTimes(1);
      expect(mocks.initializePlaybackBridge).toHaveBeenCalledTimes(1);
      expect(mocks.initializeRenderBridge).toHaveBeenCalledTimes(1);
      expect(mocks.initializeEffectsBridge).toHaveBeenCalledWith(1920, 1080);
      expect(mocks.initializeTransitionBridge).toHaveBeenCalledWith(1920, 1080);
      expect(mocks.syncTransitionBridgeFromProject).toHaveBeenCalledTimes(1);
      expect(mocks.projectState.initializeAutoSave).toHaveBeenCalledTimes(1);
      expect(transitionOrdering).toEqual([
        "transition",
        "autosave",
        "transition-microtask",
      ]);
      const bootstrapSpan = events.find((event) => event.phase === "editor.bootstrap");
      const engineStepSpan = events.find((event) => event.phase === "editor.bootstrap.engine_initialize");
      const engineParent = mocks.engineState.initialize.mock.calls[0]?.[0] as PerfOperation | undefined;
      expect(engineStepSpan?.parentSpanId).toBe(bootstrapSpan?.spanId);
      expect(engineParent?.span.id).toBe(engineStepSpan?.spanId);
    } finally {
      setPerfSink(previousSink);
    }

    for (const phase of [
      "editor.bootstrap",
      "editor.bootstrap.engine_initialize",
      "editor.bootstrap.media_bridge",
      "editor.bootstrap.playback_bridge",
      "editor.bootstrap.render_bridge",
      "editor.bootstrap.effects_bridge",
      "editor.bootstrap.transition_bridge",
      "editor.bootstrap.autosave",
    ]) {
      expect(events.some((event) => event.phase === phase)).toBe(true);
    }
    expect(events).toContainEqual({ phase: "editor.bootstrap", outcome: "ok" });
  });
});
