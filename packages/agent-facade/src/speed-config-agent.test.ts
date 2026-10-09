import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";
import { createAgentFacade, type AgentFacade } from "./index";
import { TINY_MP4_FILENAME, writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { makeTempDir, removeTempDir } from "./test-helpers";

describe("Agent speed configuration and timeline-to-source mapping", () => {
  let mediaRoot: string;
  let projectRoot: string;
  let facade: AgentFacade;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await makeTempDir("speed-config-media");
    projectRoot = await makeTempDir("speed-config-project");
    writeTinyMp4(mediaRoot);
    facade = createAgentFacade({ mediaRoots: [mediaRoot], projectRoots: [projectRoot] });
    const created = await facade["project.create"]({ name: "Speed config" });
    expect(created.ok).toBe(true);
    const imported = await facade["media.import"]({ path: `${mediaRoot}/${TINY_MP4_FILENAME}` });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId,
          startTime: 10,
          duration: 3.5,
          inPoint: 0.25,
          outPoint: 3.75,
          clipId: "c1",
        },
      ],
    });
    expect(seeded.ok).toBe(true);
  });

  afterEach(async () => {
    await removeTempDir(mediaRoot);
    await removeTempDir(projectRoot);
  });

  const config = {
    op: "clip.setSpeedConfig" as const,
    clipId: "c1",
    speed: 2,
    reversed: false,
    pitchCorrection: false,
    keyframes: [
      { time: 0, speed: 2, easing: "linear" as const },
      { time: 3.5, speed: 4, easing: "linear" as const },
    ],
    freezeFrames: [{ sourceTime: 1.1, startTime: 0.3, duration: 0.45 }],
  };

  it("writes one canonical speed configuration and maps points through Core", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const params = { ops: [config], idempotencyKey: "speed-config-once" };
    const first = await facade["edit.apply"](params);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await facade["edit.apply"](params);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.revision).toBe(first.value.revision);

    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const clip = state.value.project.timeline.tracks[0]!.clips[0]!;
    expect(clip).toMatchObject({
      speed: 2,
      reversed: false,
      pitchCorrection: false,
      speedKeyframes: [
        { id: "speed-kf-c1-1", time: 0, speed: 2, easing: "linear" },
        { id: "speed-kf-c1-2", time: 3.5, speed: 4, easing: "linear" },
      ],
      freezeFrames: [{ id: "freeze-c1-1", clipId: "c1", sourceTime: 1.1, startTime: 0.3, duration: 0.45 }],
    });
    const engine = new SpeedEngine();
    engine.loadClips([clip]);
    expect(clip.duration).toBeCloseTo(engine.getEffectiveDuration(clip.id), 9);
    expect(state.value.project.timeline.duration).toBeGreaterThanOrEqual(clip.startTime + clip.duration);

    const timelineTimes = [10.1, 10.3, 10.5, 10.749, 10.75, 11.2];
    const mapped = await facade["timeline.mapSourceTimes"]({ clipId: "c1", timelineTimes });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.revision).toBe(state.value.revision);
    expect(mapped.value.mappings.map((entry) => entry.timelineTime)).toEqual(timelineTimes);
    for (const entry of mapped.value.mappings) {
      const localTime = entry.timelineTime - clip.startTime;
      expect(entry.clipLocalTime).toBeCloseTo(localTime, 10);
      expect(entry.sourceTimeFromInPoint).toBeCloseTo(
        engine.getSourceTimeAtPlaybackTime(clip.id, localTime),
        4,
      );
      expect(entry.sourceTime).toBeCloseTo(clip.inPoint + entry.sourceTimeFromInPoint, 10);
    }
    expect(mapped.value.mappings[1]).toMatchObject({
      frozen: true,
      freezeFrameId: "freeze-c1-1",
      sourceTimeFromInPoint: 1.1,
      sourceTime: 1.35,
    });
    expect(mapped.value.mappings[4]?.frozen).toBe(false);
    const stateAfterQuery = await facade["project.get_state"]();
    expect(stateAfterQuery.ok && stateAfterQuery.value.revision).toBe(state.value.revision);

    const checkpoint = `${projectRoot}/speed-config.openreel.json`;
    const saved = await facade["project.save"]({ path: checkpoint });
    expect(saved.ok).toBe(true);
    const reopened = createAgentFacade({ mediaRoots: [mediaRoot], projectRoots: [projectRoot] });
    const opened = await reopened["project.open"]({ path: checkpoint });
    if (!opened.ok) throw new Error(opened.error.message);
    const loaded = await reopened["project.get_state"]();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const loadedClip = loaded.value.project.timeline.tracks[0]!.clips[0]!;
      expect(loadedClip).toMatchObject({ speed: 2, pitchCorrection: false, freezeFrames: clip.freezeFrames });
      expect(loadedClip.duration).toBeCloseTo(clip.duration, 9);
    }
  });

  it("rejects stale revisions, nonlinear trims and invalid freeze ordering atomically", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const stale = await facade["edit.apply"]({
      ops: [config],
      expectedRevision: before.value.revision - 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const atomicFailure = await facade["edit.apply"]({
      ops: [config, { op: "clip.trim", clipId: "c1", outPoint: 3.5 }],
    });
    expect(atomicFailure.ok).toBe(false);
    if (!atomicFailure.ok) expect(atomicFailure.error.code).toBe("UNSUPPORTED");

    const overlapping = await facade["edit.apply"]({
      ops: [{
        ...config,
        freezeFrames: [
          { sourceTime: 1, startTime: 0.3, duration: 0.5 },
          { sourceTime: 1.5, startTime: 0.7, duration: 0.2 },
        ],
      }],
    });
    expect(overlapping.ok).toBe(false);
    if (!overlapping.ok) {
      expect(overlapping.error.code).toBe("ACTION_FAILED");
      expect(overlapping.error.details).toMatchObject({ coreCode: "INVALID_PARAMS" });
    }

    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.revision).toBe(before.value.revision);
      expect(after.value.project.timeline.tracks[0]!.clips[0]).not.toHaveProperty("speedKeyframes");
    }
  });

  it("bounds and validates mapping queries without changing project revision", async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const tooMany = await facade["timeline.mapSourceTimes"]({ clipId: "c1", timelineTimes: Array(65).fill(10) });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("INVALID_PARAMS");

    const outside = await facade["timeline.mapSourceTimes"]({ clipId: "c1", timelineTimes: [9.99] });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("INVALID_PARAMS");

    const stale = await facade["timeline.mapSourceTimes"]({
      clipId: "c1",
      timelineTimes: [10],
      expectedRevision: before.value.revision + 1,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const after = await facade["project.get_state"]();
    expect(after.ok && after.value.revision).toBe(before.value.revision);
  });
});
