/**
 * Settle-once guard unit tests (pure Node, no Chromium): the provider may
 * emit EXACTLY ONE terminal callback per job — the first terminal wins, any
 * later terminal (however a route unwinds after a watchdog/cancel race) is
 * dropped, and no running/progress signal may follow a terminal.
 */
import { describe, expect, it } from "vitest";
import type { ExportCallbacks } from "@reelterminal/agent-facade";
import { guardExportCallbacks } from "./node/providers";
import { summarizeProbe } from "./node/probe";
import type { PageProbeFacts } from "./node/runtime";

interface Recorded {
  running: number;
  progress: number;
  terminals: string[];
}

function recorder(): { callbacks: ExportCallbacks; recorded: Recorded } {
  const recorded: Recorded = { running: 0, progress: 0, terminals: [] };
  return {
    recorded,
    callbacks: {
      onRunning: () => {
        recorded.running += 1;
      },
      onProgress: () => {
        recorded.progress += 1;
      },
      onDone: () => {
        recorded.terminals.push("done");
      },
      onError: () => {
        recorded.terminals.push("error");
      },
      onCancelled: () => {
        recorded.terminals.push("cancelled");
      },
    },
  };
}

const DONE_COMPLETION = {
  path: "/tmp/x/output.mp4",
  sizeBytes: 1,
  route: "chromium-webcodecs" as const,
  framesEncoded: 1,
};

describe("guardExportCallbacks (exactly-once terminal)", () => {
  it("first terminal wins: done, then error is dropped", () => {
    const { callbacks, recorded } = recorder();
    const guarded = guardExportCallbacks(callbacks);
    guarded.onRunning();
    guarded.onDone(DONE_COMPLETION);
    guarded.onError({ code: "JOB_FAILED", message: "late" });
    expect(recorded.terminals).toEqual(["done"]);
    expect(guarded.terminal).toBe("done");
  });

  it("first terminal wins: error, then cancelled is dropped", () => {
    const { callbacks, recorded } = recorder();
    const guarded = guardExportCallbacks(callbacks);
    guarded.onError({ code: "JOB_FAILED", message: "watchdog" });
    guarded.onCancelled();
    guarded.onDone(DONE_COMPLETION);
    expect(recorded.terminals).toEqual(["error"]);
    expect(guarded.terminal).toBe("error");
  });

  it("first terminal wins: cancelled, then done is dropped", () => {
    const { callbacks, recorded } = recorder();
    const guarded = guardExportCallbacks(callbacks);
    guarded.onCancelled();
    guarded.onDone(DONE_COMPLETION);
    expect(recorded.terminals).toEqual(["cancelled"]);
    expect(guarded.terminal).toBe("cancelled");
  });

  it("double error delivers exactly one", () => {
    const { callbacks, recorded } = recorder();
    const guarded = guardExportCallbacks(callbacks);
    guarded.onError({ code: "JOB_FAILED", message: "one" });
    guarded.onError({ code: "JOB_FAILED", message: "two" });
    expect(recorded.terminals).toEqual(["error"]);
  });

  it("no running/progress may follow a terminal", () => {
    const { callbacks, recorded } = recorder();
    const guarded = guardExportCallbacks(callbacks);
    guarded.onRunning();
    guarded.onProgress({ phase: "rendering", percent: 0.5 });
    guarded.onCancelled();
    guarded.onRunning();
    guarded.onProgress({ phase: "muxing", percent: 0.99 });
    expect(recorded.running).toBe(1);
    expect(recorded.progress).toBe(1);
    expect(recorded.terminals).toEqual(["cancelled"]);
  });
});

/* ------------------------------------------------------------------ */
/* summarizeProbe: capability honesty (no auto frames route; Route W   */
/* requires codec AND ExportEngine init) — pure facts in, verdict out. */
/* ------------------------------------------------------------------ */

function factsOf(overrides: Partial<PageProbeFacts>): PageProbeFacts {
  return {
    offscreenCanvas: true,
    offscreenPngEncode: true,
    videoDecoder: { "avc1.640028": true },
    videoEncoder: { "avc1.640028/prefer-software": true },
    audioEncoderAac: true,
    videoEngineInit: true,
    exportEngineInit: true,
    webCodecsSupported: true,
    mediabunnyLoaded: true,
    firstEncodableVideo: { avc: "avc", vp9: null, vp8: null },
    decodeSample: null,
    errors: [],
    ...overrides,
  };
}

describe("summarizeProbe (capability honesty)", () => {
  it("Route W requires H.264 encode AND exportEngineInit", () => {
    const ok = summarizeProbe(factsOf({}), false);
    expect(ok.exportRoute).toBe("chromium-webcodecs");

    // Codec encodable but the engine that would feed it failed to init:
    // the route must NOT be claimed.
    const engineDead = summarizeProbe(
      factsOf({ exportEngineInit: false }),
      false,
    );
    expect(engineDead.exportRoute).toBe("unavailable");
    expect(engineDead.exportUnavailableReason).toContain("ExportEngine");
    expect(engineDead.h264EncodeAvailable).toBe(true); // fact, not a route
  });

  it("never derives the video-only frames route by default", () => {
    // Report the video-only frames route separately from export availability.
    const summary = summarizeProbe(
      factsOf({ firstEncodableVideo: { avc: null, vp9: "vp9", vp8: null } }),
      true,
    );
    expect(summary.exportRoute).toBe("unavailable");
    expect(summary.videoOnlyFramesRouteAvailable).toBe(true);
    expect(summary.exportUnavailableReason).toContain("video-only");
  });

  it("reports unavailable with a reason when nothing can export", () => {
    const summary = summarizeProbe(
      factsOf({ firstEncodableVideo: { avc: null, vp9: null, vp8: null } }),
      false,
    );
    expect(summary.exportRoute).toBe("unavailable");
    expect(summary.videoOnlyFramesRouteAvailable).toBe(false);
    expect(summary.exportUnavailableReason).toBeTruthy();
  });

  it("render unavailability masks the frames experiment too", () => {
    const summary = summarizeProbe(
      factsOf({ videoEngineInit: false }),
      true,
    );
    expect(summary.renderAvailable).toBe(false);
    expect(summary.exportRoute).toBe("unavailable");
    expect(summary.videoOnlyFramesRouteAvailable).toBe(false);
  });
});
