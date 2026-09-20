import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";

describe("media.analyze_start and generalized jobs", () => {
  let root = "";
  let facade: AgentFacade;
  let mediaId = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "reelterminal-analysis-"));
    const source = writeTinyMp4(root);
    facade = createAgentFacade({ mediaRoots: [root] });
    await facade["project.create"]({ name: "Analysis" });
    const imported = await facade["media.import"]({ path: source });
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs real technical-quality probing asynchronously and returns a bounded summary", async () => {
    const started = await facade["media.analyze_start"]({
      mediaId,
      analysisTypes: ["technicalQuality"],
      expectedRevision: 1,
      idempotencyKey: "analysis-1",
    });
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    expect(started.value).toMatchObject({ kind: "analysis", state: "queued", sourceRevision: 1 });

    let status = await facade["job.status"]({ jobId: started.value.jobId });
    for (let attempt = 0; status.ok && !["done", "error", "cancelled"].includes(status.value.state) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = await facade["job.status"]({ jobId: started.value.jobId });
    }
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.kind).toBe("analysis");
    expect(status.value.state).toBe("done");
    expect(status.value.artifact).toBeNull();
    expect(status.value.result).toMatchObject({
      analysisTypes: ["technicalQuality"],
      summary: {
        technicalQuality: {
          mediaId,
          readable: true,
        },
      },
      artifacts: [],
    });

    const replay = await facade["media.analyze_start"]({
      mediaId,
      analysisTypes: ["technicalQuality"],
      expectedRevision: 1,
      idempotencyKey: "analysis-1",
    });
    expect(replay.ok && replay.value.jobId).toBe(started.value.jobId);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
  });

  it("fails unavailable analysis types before creating a job", async () => {
    const result = await facade["media.analyze_start"]({
      mediaId,
      analysisTypes: ["speechTranscript", "faces"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
      expect(result.error.details).toMatchObject({
        unavailableTypes: ["speechTranscript", "faces"],
        availableTypes: ["technicalQuality", "audioSummary", "silence", "beatGrid"],
      });
    }
  });

  it("cancels a queued analysis job through the generalized job path", async () => {
    const started = await facade["media.analyze_start"]({
      mediaId,
      analysisTypes: ["technicalQuality"],
      idempotencyKey: "analysis-cancel",
    });
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    const cancelled = await facade["job.cancel"]({ jobId: started.value.jobId });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value).toMatchObject({
        kind: "analysis",
        state: "cancelled",
        cancelRequested: true,
        artifact: null,
        result: null,
      });
    }
  });

  it("persists basic color grading through the same Core action the GUI/render path uses", async () => {
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId, startTime: 0, duration: 1, clipId: "c1" },
      ],
    });
    const graded = await facade["edit.apply"]({
      ops: [{ op: "clip.setColorGrade", clipId: "c1", temperature: 20, tint: -5 }],
      expectedRevision: 2,
    });
    expect(graded.ok).toBe(true);
    const animated = await facade["edit.apply"]({
      ops: [{
        op: "clip.setKeyframes",
        clipId: "c1",
        keyframes: [
          { property: "opacity", time: 0, value: 0, easing: "linear" },
          { property: "opacity", time: 1, value: 1, easing: "ease-out" },
          { property: "position.x", time: 1, value: 120 },
        ],
      }],
      expectedRevision: 3,
    });
    expect(animated.ok).toBe(true);
    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value.tracks[0]?.clips[0]?.colorGrading).toMatchObject({
        temperature: 20,
        tint: -5,
      });
      expect(timeline.value.tracks[0]?.clips[0]?.keyframes).toHaveLength(3);
    }
  });
});
