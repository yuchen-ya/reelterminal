/**
 * Opt-in real Electron preview performance scenario.
 *
 * This is intentionally excluded from ordinary E2E cost by an environment
 * switch. It creates the project through the UI, creates all stress content
 * through the shipped live MCP edit_apply path, and performs the measured
 * preview move with Playwright's real mouse input.
 *
 * Run against an existing desktop build:
 *   OPENREEL_E2E_PREVIEW_PERF=1 pnpm --filter @openreel/desktop exec vitest run \
 *     --config e2e/vitest.config.ts e2e/preview-large-project-performance.e2e.ts
 */
import { describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import {
  connectExternalAgent,
  type ExternalAgent,
} from "./harness/mcp-client";
import { createEvidence } from "./harness/evidence";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  selectTextClipViaUI,
} from "./harness/ui";

const RUN_PERF = process.env.OPENREEL_E2E_PREVIEW_PERF === "1";
const performanceDescribe = RUN_PERF ? describe : describe.skip;
const TRACK_COUNT = 10;
const CLIPS_PER_TRACK = 100;
const CLIP_COUNT = TRACK_COUNT * CLIPS_PER_TRACK;
const EDIT_BATCH_SIZE = 100;
const TARGET_TEXT = "PREVIEW-PERF-TARGET";
const FRAME_BUDGET_MS = 1_000 / 60;

interface EditResult {
  revision: number;
}

interface EditorContext {
  projectRevision: number;
}

interface TextOverlay {
  id: string;
  trackId: string;
  text: string;
  position: { x: number; y: number };
}

interface TimelineView {
  revision: number;
  textOverlays: TextOverlay[];
}

interface RendererSample {
  frameIntervalsMs: number[];
  longTasksMs: number[];
  longTaskObserverAvailable: boolean;
  inputEventToRafCallbackMs: number | null;
  heapBeforeDragBytes: number | null;
  heapAfterDragBytes: number | null;
  heapPeakBytes: number | null;
  sampleDurationMs: number;
}

const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

async function readHeap(page: LaunchedApp["page"]): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    return typeof memory?.usedJSHeapSize === "number"
      ? memory.usedJSHeapSize
      : null;
  });
}

async function startRendererSampling(
  page: LaunchedApp["page"],
): Promise<void> {
  await page.evaluate(() => {
    type ChromiumMemory = { usedJSHeapSize?: number };
    type SampleState = {
      active: boolean;
      startedAt: number;
      lastFrameAt: number | null;
      frameIntervalsMs: number[];
      longTasksMs: number[];
      longTaskObserverAvailable: boolean;
      heapBeforeDragBytes: number | null;
      heapPeakBytes: number | null;
      firstInputAt: number | null;
      inputEventToRafCallbackMs: number | null;
      observer: PerformanceObserver | null;
    };
    type SamplingGlobal = typeof globalThis & {
      __openreelPreviewPerfSample?: SampleState;
    };
    const root = globalThis as SamplingGlobal;
    const readHeap = (): number | null => {
      const memory = (performance as Performance & { memory?: ChromiumMemory })
        .memory;
      return typeof memory?.usedJSHeapSize === "number"
        ? memory.usedJSHeapSize
        : null;
    };
    const initialHeap = readHeap();
    const state: SampleState = {
      active: true,
      startedAt: performance.now(),
      lastFrameAt: null,
      frameIntervalsMs: [],
      longTasksMs: [],
      longTaskObserverAvailable:
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask"),
      heapBeforeDragBytes: initialHeap,
      heapPeakBytes: initialHeap,
      firstInputAt: null,
      inputEventToRafCallbackMs: null,
      observer: null,
    };
    document.addEventListener(
      "mousemove",
      (event) => {
        if ((event.buttons & 1) !== 0 && state.firstInputAt === null) {
          state.firstInputAt = performance.now();
        }
      },
      { capture: true },
    );
    if (state.longTaskObserverAvailable) {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasksMs.push(entry.duration);
      });
      state.observer.observe({ entryTypes: ["longtask"] });
    }
    const sampleFrame = (now: number): void => {
      if (!state.active) return;
      if (state.lastFrameAt !== null) {
        state.frameIntervalsMs.push(now - state.lastFrameAt);
      }
      state.lastFrameAt = now;
      if (
        state.firstInputAt !== null &&
        state.inputEventToRafCallbackMs === null
      ) {
        // The RAF frame timestamp can precede event dispatch. Read the clock
        // inside the callback so both values use the same time origin.
        state.inputEventToRafCallbackMs = Math.max(
          0,
          performance.now() - state.firstInputAt,
        );
      }
      const heap = readHeap();
      if (
        heap !== null &&
        (state.heapPeakBytes === null || heap > state.heapPeakBytes)
      ) {
        state.heapPeakBytes = heap;
      }
      requestAnimationFrame(sampleFrame);
    };
    root.__openreelPreviewPerfSample = state;
    requestAnimationFrame(sampleFrame);
  });
}

async function stopRendererSampling(
  page: LaunchedApp["page"],
): Promise<RendererSample> {
  return page.evaluate(() => {
    type ChromiumMemory = { usedJSHeapSize?: number };
    type SampleState = {
      active: boolean;
      startedAt: number;
      frameIntervalsMs: number[];
      longTasksMs: number[];
      longTaskObserverAvailable: boolean;
      heapBeforeDragBytes: number | null;
      heapPeakBytes: number | null;
      inputEventToRafCallbackMs: number | null;
      observer: PerformanceObserver | null;
    };
    type SamplingGlobal = typeof globalThis & {
      __openreelPreviewPerfSample?: SampleState;
    };
    const state = (globalThis as SamplingGlobal).__openreelPreviewPerfSample;
    if (!state) throw new Error("preview performance sampler was not started");
    state.active = false;
    state.observer?.disconnect();
    const memory = (performance as Performance & { memory?: ChromiumMemory })
      .memory;
    const heapAfterDragBytes =
      typeof memory?.usedJSHeapSize === "number"
        ? memory.usedJSHeapSize
        : null;
    return {
      frameIntervalsMs: state.frameIntervalsMs,
      longTasksMs: state.longTasksMs,
      longTaskObserverAvailable: state.longTaskObserverAvailable,
      inputEventToRafCallbackMs: state.inputEventToRafCallbackMs,
      heapBeforeDragBytes: state.heapBeforeDragBytes,
      heapAfterDragBytes,
      heapPeakBytes: state.heapPeakBytes,
      sampleDurationMs: performance.now() - state.startedAt,
    };
  });
}

performanceDescribe("preview large-project GUI performance", () => {
  test("measures a real canvas drag with 1,000 MCP-created text clips", async () => {
    let launched: LaunchedApp | undefined;
    let agent: ExternalAgent | undefined;
    let evidence: ReturnType<typeof createEvidence> | undefined;
    try {
      launched = await launchApp();
      evidence = createEvidence("preview-large-project-performance", launched.page);
      await createProjectViaUI(launched.page);
      const heapBeforeBuildBytes = await readHeap(launched.page);
      await enableAgentSessionViaUI(launched.page, launched.endpointFile);
      await launched.waitForEndpointFile();
      agent = await connectExternalAgent(launched.endpointFile);

      const capabilities = await agent.callTool("capabilities_get");
      expect(capabilities.ok, JSON.stringify(capabilities)).toBe(true);
      const context = await agent.callTool<EditorContext>("editor_get_context");
      expect(context.ok, JSON.stringify(context)).toBe(true);
      let revision = context.value!.projectRevision;

      const trackIds = Array.from(
        { length: TRACK_COUNT },
        (_, index) => `preview-perf-text-${index}`,
      );
      const tracks = await agent.callTool<EditResult>("edit_apply", {
        ops: trackIds.map((trackId) => ({
          op: "track.add",
          trackType: "text",
          trackId,
        })),
        expectedRevision: revision,
        idempotencyKey: "preview-perf-tracks-v1",
      });
      expect(tracks.ok, JSON.stringify(tracks)).toBe(true);
      revision = tracks.value!.revision;

      const textOps = Array.from({ length: CLIP_COUNT }, (_, index) => {
        const trackIndex = index % TRACK_COUNT;
        const clipIndex = Math.floor(index / TRACK_COUNT);
        return {
          op: "text.create",
          trackId: trackIds[trackIndex],
          text: index === 0 ? TARGET_TEXT : `PERF-${index}`,
          startTime: clipIndex * 2,
          duration: 1.5,
          position: {
            x: 0.25 + (trackIndex % 5) * 0.12,
            y: 0.25 + Math.floor(trackIndex / 5) * 0.35,
          },
          ...(index === 0 ? { style: { fontSize: 160 } } : {}),
        };
      });

      for (let offset = 0; offset < textOps.length; offset += EDIT_BATCH_SIZE) {
        const batch = await agent.callTool<EditResult>(
          "edit_apply",
          {
            ops: textOps.slice(offset, offset + EDIT_BATCH_SIZE),
            expectedRevision: revision,
            idempotencyKey: `preview-perf-text-${offset / EDIT_BATCH_SIZE}-v1`,
          },
          { timeoutMs: 60_000 },
        );
        expect(batch.ok, JSON.stringify(batch)).toBe(true);
        revision = batch.value!.revision;
      }

      const timelineBefore = await agent.callTool<TimelineView>(
        "timeline_get",
        {},
        { timeoutMs: 60_000 },
      );
      expect(timelineBefore.ok, JSON.stringify(timelineBefore)).toBe(true);
      expect(timelineBefore.value!.textOverlays).toHaveLength(CLIP_COUNT);
      expect(
        new Set(timelineBefore.value!.textOverlays.map((clip) => clip.trackId))
          .size,
      ).toBe(TRACK_COUNT);
      const targetBefore = timelineBefore.value!.textOverlays.find(
        (clip) => clip.text === TARGET_TEXT,
      );
      expect(targetBefore).toBeDefined();

      const dismissIntro = launched.page.getByRole("button", {
        name: "Got it",
        exact: true,
      });
      if (await dismissIntro.isVisible().catch(() => false)) {
        await dismissIntro.click();
      }
      await selectTextClipViaUI(launched.page, TARGET_TEXT);
      const moveHandle = launched.page.locator('[title="Drag to move text"]');
      await moveHandle.waitFor({ state: "visible", timeout: 30_000 });
      const handleBox = await moveHandle.boundingBox();
      if (!handleBox) throw new Error("selected text move handle has no box");

      const heapAfterBuildBytes = await readHeap(launched.page);
      const startX = handleBox.x + handleBox.width / 2;
      const startY = handleBox.y + handleBox.height / 2;
      const hitTarget = await launched.page.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          const titled = element?.closest("[title]");
          return element
            ? {
                tag: element.tagName,
                title: element.getAttribute("title"),
                className: element.getAttribute("class"),
                titledAncestor: titled?.getAttribute("title") ?? null,
              }
            : null;
        },
        { x: startX, y: startY },
      );
      expect(hitTarget?.titledAncestor).toBe("Drag to move text");
      await launched.page.mouse.move(startX, startY);
      await startRendererSampling(launched.page);
      await launched.page.mouse.down();
      // React installs the move handler after the mousedown state transition.
      // Waiting one render turn mirrors a held pointer before movement.
      await launched.page.waitForTimeout(100);
      for (let step = 1; step <= 3; step += 1) {
        await launched.page.mouse.move(startX + (90 * step) / 3, startY);
        await launched.page.waitForTimeout(15);
      }
      await launched.page.mouse.up();
      await launched.page.waitForTimeout(1_000);
      const rendererSample = await stopRendererSampling(launched.page);

      const timelineAfter = await agent.callTool<TimelineView>(
        "timeline_get",
        {},
        { timeoutMs: 60_000 },
      );
      expect(timelineAfter.ok, JSON.stringify(timelineAfter)).toBe(true);
      const targetAfter = timelineAfter.value!.textOverlays.find(
        (clip) => clip.id === targetBefore!.id,
      );
      expect(targetAfter).toBeDefined();
      const dragDistance = Math.hypot(
        targetAfter!.position.x - targetBefore!.position.x,
        targetAfter!.position.y - targetBefore!.position.y,
      );
      expect(dragDistance).toBeGreaterThan(0.001);

      const intervals = rendererSample.frameIntervalsMs;
      const overOneFrameBudget = intervals.filter(
        (value) => value > FRAME_BUDGET_MS,
      ).length;
      const overTwoFrameBudgets = intervals.filter(
        (value) => value > FRAME_BUDGET_MS * 2,
      ).length;
      const estimatedMissedVsyncs = intervals.reduce(
        (total, value) =>
          total + Math.max(0, Math.floor(value / FRAME_BUDGET_MS) - 1),
        0,
      );
      const result = {
        schema: "openreel.preview-gui-performance/v1",
        project: {
          textClipCount: timelineAfter.value!.textOverlays.length,
          textTrackCount: TRACK_COUNT,
          timelineDurationSeconds: CLIPS_PER_TRACK * 2 - 0.5,
        },
        gesture: {
          input: "playwright-real-mouse",
          requestedDeltaPx: { x: 90, y: 0 },
          inputEventToRafCallbackMs:
            rendererSample.inputEventToRafCallbackMs,
          hitTarget,
          normalizedDistanceObserved: dragDistance,
          before: targetBefore!.position,
          after: targetAfter!.position,
        },
        frames: {
          sampleDurationMs: rendererSample.sampleDurationMs,
          intervalCount: intervals.length,
          intervalP50Ms: percentile(intervals, 0.5),
          intervalP95Ms: percentile(intervals, 0.95),
          intervalMaxMs: intervals.length > 0 ? Math.max(...intervals) : null,
          overOneFrameBudget,
          overTwoFrameBudgets,
          estimatedMissedVsyncs,
        },
        longTasks: {
          observerAvailable: rendererSample.longTaskObserverAvailable,
          count: rendererSample.longTasksMs.length,
          totalMs: rendererSample.longTasksMs.reduce(
            (total, value) => total + value,
            0,
          ),
          maxMs:
            rendererSample.longTasksMs.length > 0
              ? Math.max(...rendererSample.longTasksMs)
              : null,
        },
        jsHeap: {
          beforeBuildBytes: heapBeforeBuildBytes,
          afterBuildBytes: heapAfterBuildBytes,
          beforeDragBytes: rendererSample.heapBeforeDragBytes,
          peakDuringDragBytes: rendererSample.heapPeakBytes,
          afterDragBytes: rendererSample.heapAfterDragBytes,
        },
        limitations: [
          "RAF intervals and estimated missed vsyncs are renderer scheduling evidence, not Chromium's native dropped-frame counter.",
          "inputEventToRafCallbackMs measures renderer mousemove dispatch to the next RAF callback; it is a scheduling proxy, not input-to-display latency.",
          "performance.memory reports JavaScript heap when Chromium exposes it; it excludes GPU, decoder, native canvas, and process memory.",
          "No cross-machine pass threshold is applied; project scale and persisted drag success are the assertions.",
        ],
      };
      evidence.record("measurement", result);
      evidence.flush();
      console.info("PREVIEW_GUI_PERFORMANCE_EVIDENCE", JSON.stringify(result));
    } finally {
      evidence?.flush();
      await agent?.close();
      await launched?.close();
    }
  }, 120_000);
});
