/**
 * 选中画布位置，让 Agent 添加字幕，并检查过期上下文会返回冲突。
 *
 * Human side: real UI input only. Agent side: real MCP stdio client.
 * Pixel assertion decodes the facade's preview.render_frame PNG with ffmpeg
 * (no image libraries) and checks the caption's non-background centroid
 * against the OBSERVED canvas point.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { analyzePng } from "./harness/pixels";
import {
  createProjectViaUI,
  enableAgentSessionViaUI,
  setCanvasPointViaUI,
  setPlayheadViaUI,
  timelineTextClip,
} from "./harness/ui";

interface EditorContext {
  projectRevision: number;
  contextRevision: number | null;
  playheadSeconds: number | null;
  canvasPoint: { x: number; y: number } | null;
}

interface TimelineView {
  revision: number;
  textOverlays: Array<{ id: string; text: string }>;
}

const CAPTION_TEXT = "CAPTION-AT-TARGET";
const PLAYHEAD_T = 2.0;
const POINT = { x: 0.3, y: 0.7 };
const MOVED_POINT = { x: 0.6, y: 0.35 };

describe("flow B: caption at the user's canvas point + stale-context conflict", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;
  let contextWithPoint: EditorContext;
  let revisionAfterCaption: number;

  const readContext = async (): Promise<EditorContext> => {
    const result = await agent.callTool<EditorContext>("editor_get_context");
    expect(result.ok).toBe(true);
    return result.value!;
  };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("flow-b-canvas-caption", launched.page);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
  }, 300_000);

  afterAll(async () => {
    evidence.flush();
    await agent?.close();
    await launched?.close();
  });

  test("user sets playhead + canvas point with real gestures; agent reads both", async () => {
    // Human: move the playhead to T by clicking the time ruler (real mouse;
    // aim corrected against the agent-channel observation).
    const landed = await setPlayheadViaUI(
      launched.page,
      PLAYHEAD_T,
      async () => (await readContext()).playheadSeconds,
    );
    expect(Math.abs(landed - PLAYHEAD_T)).toBeLessThanOrEqual(0.25);

    // Human: arm the crosshair and click the preview canvas (real gesture).
    const point = await setCanvasPointViaUI(
      launched.page,
      POINT.x,
      POINT.y,
      async () => (await readContext()).canvasPoint,
    );

    contextWithPoint = await readContext();
    expect(contextWithPoint.playheadSeconds).not.toBeNull();
    expect(Math.abs(contextWithPoint.playheadSeconds! - PLAYHEAD_T)).toBeLessThanOrEqual(0.25);
    expect(contextWithPoint.canvasPoint).not.toBeNull();
    expect(Math.abs(contextWithPoint.canvasPoint!.x - POINT.x)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(contextWithPoint.canvasPoint!.y - POINT.y)).toBeLessThanOrEqual(0.03);

    evidence.record("context_with_playhead_and_point", {
      requested: { playhead: PLAYHEAD_T, point: POINT },
      observed: contextWithPoint,
      landedPlayhead: landed,
      landedPoint: point,
    });
    await evidence.screenshot("playhead-and-target-point");
  });

  test("agent places the caption at the point; GUI shows it; rendered pixels agree", async () => {
    const applied = await agent.callTool<{ revision: number }>("edit_apply", {
      ops: [
        { op: "track.add", trackType: "text" },
        {
          op: "text.create",
          text: CAPTION_TEXT,
          startTime: PLAYHEAD_T,
          duration: 3,
          position: { ...contextWithPoint.canvasPoint! },
        },
      ],
      expectedContextRevision: contextWithPoint.contextRevision,
    });
    expect(applied.ok).toBe(true);
    revisionAfterCaption = applied.value!.revision;
    expect(revisionAfterCaption).toBeGreaterThan(contextWithPoint.projectRevision);

    // GUI legibility without reload.
    await timelineTextClip(launched.page, CAPTION_TEXT).waitFor({ timeout: 15_000 });
    await evidence.screenshot("caption-in-gui");

    // Rendered pixels: frame at T+1 shows the caption at the observed point.
    const frame = await agent.callTool<{
      revision: number;
      width: number;
      height: number;
      artifact: { path: string; sizeBytes: number; sha256: string };
    }>("preview_render_frame", { timeSec: PLAYHEAD_T + 1 }, { timeoutMs: 300_000 });
    expect(frame.ok, JSON.stringify(frame)).toBe(true);
    const artifact = frame.value!.artifact;
    const png = readFileSync(artifact.path);
    const evidencePng = evidence.writePng("rendered-frame", png);

    const stats = await analyzePng(artifact.path, frame.value!.width, frame.value!.height);
    expect(stats.centroid).not.toBeNull();
    expect(stats.nonBackgroundCount).toBeGreaterThan(500);
    // The caption pixels land at the OBSERVED canvas point (anchor center).
    expect(Math.abs(stats.centroid!.x - contextWithPoint.canvasPoint!.x)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(stats.centroid!.y - contextWithPoint.canvasPoint!.y)).toBeLessThanOrEqual(0.07);

    evidence.record("render_frame", {
      request: { timeSec: PLAYHEAD_T + 1 },
      artifact: { path: artifact.path, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 },
      evidencePng,
      pixelStats: stats,
      expectedPoint: contextWithPoint.canvasPoint,
    });
  });

  test("stale context: replaying the edit after the user moved the point → CONFLICT, no duplicate", async () => {
    // Human: move the target point somewhere else (real gesture) — this bumps
    // the context revision the agent CAS-guarded against.
    await setCanvasPointViaUI(
      launched.page,
      MOVED_POINT.x,
      MOVED_POINT.y,
      async () => (await readContext()).canvasPoint,
    );

    const replayed = await agent.callTool("edit_apply", {
      ops: [
        { op: "track.add", trackType: "text" },
        {
          op: "text.create",
          text: CAPTION_TEXT,
          startTime: PLAYHEAD_T,
          duration: 3,
          position: { ...contextWithPoint.canvasPoint! },
        },
      ],
      expectedContextRevision: contextWithPoint.contextRevision,
    });
    expect(replayed.ok).toBe(false);
    expect(replayed.isError).toBe(true);
    expect(replayed.error!.code).toBe("CONFLICT");

    const timeline = await agent.callTool<TimelineView>("timeline_get");
    expect(timeline.value!.textOverlays).toHaveLength(1);
    expect(timeline.value!.textOverlays[0]!.text).toBe(CAPTION_TEXT);
    expect(await timelineTextClip(launched.page, CAPTION_TEXT).count()).toBe(1);

    evidence.record("stale_context_conflict", {
      staleContextRevision: contextWithPoint.contextRevision,
      conflict: replayed.error,
      overlayCountAfter: timeline.value!.textOverlays.length,
      revisionAfterCaption,
    });
  });
});
