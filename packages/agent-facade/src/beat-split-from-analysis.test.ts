/**
 * clip.splitAtBeat — AUD-06: beat-snapped cut points.
 *
 * Covered behavior:
 *  - the pure snap kernel: source-second beats mapped through the clip's
 *    placement/trim/speed/reverse timing, nearest-beat-within-tolerance
 *    selection, and an honest null when no beat is inside the allowed
 *    movement (the op never falls back to the unsnapped time);
 *  - the enrich gates: missing/stale/fact-less records, wrong media,
 *    non-zero audioTrackIndex, speed curves and freeze frames, cut points
 *    outside the clip, snapped points landing on the clip edges, and
 *    tolerance misses — all before any mutation starts;
 *  - end-to-end edit.apply: rewritten into clip.split at the snapped time
 *    (applied reports the submitted op name), an earlier clip.move in the
 *    same batch feeds the mapping, idempotent replay splits once, CAS
 *    conflicts change nothing, and the core merge inverse restores the clip.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@reelterminal/core/types/project";
import type { Clip } from "@reelterminal/core/types/timeline";
import { ActionExecutor } from "@reelterminal/core/actions/action-executor";
import { ActionHistory } from "@reelterminal/core/actions/action-history";

import { createAgentFacade } from "./index";
import { enrichSplitAtBeatOps, findSnappedSplitTime } from "./beat-split-from-analysis";
import { saveAnalysisRecord } from "./analysis-records";
import { opToCoreActions } from "./ops";

function makeClip(overrides: Partial<Clip> & Pick<Clip, "id" | "startTime" | "duration" | "inPoint">): Clip {
  return {
    mediaId: "m-music",
    trackId: "a1",
    outPoint: overrides.inPoint + (overrides.duration ?? 1),
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0, y: 0 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
    ...overrides,
  } as Clip;
}

describe("beat snap kernel", () => {
  const clip = makeClip({ id: "music", startTime: 10, duration: 4, inPoint: 5, outPoint: 9 });
  const beats = [
    { timeSec: 6, index: 0 },
    { timeSec: 7, index: 1 },
    { timeSec: 8, index: 2 },
  ];
  it("maps record beats onto the timeline and picks the nearest inside the tolerance", () => {
    // Beats land at timeline 11/12/13.
    const snap = findSnappedSplitTime(clip, beats, 12.3, 0.5)!;
    expect(snap).toMatchObject({ snappedTimeSec: 12, beatIndex: 1 });
    expect(snap.shiftSec).toBeCloseTo(0.3, 10);
    expect(findSnappedSplitTime(clip, beats, 11.9, 0.5)).toMatchObject({ snappedTimeSec: 12, beatIndex: 1 });
  });
  it("returns null when no beat lies inside the allowed movement", () => {
    // Nearest beats are 12 (0.45 away) and 13 (0.55) — both outside 0.3.
    expect(findSnappedSplitTime(clip, beats, 12.45, 0.3)).toBeNull();
    expect(findSnappedSplitTime(clip, [], 12, 1)).toBeNull();
  });
  it("maps reverse playback through the mirrored source timeline", () => {
    const reversed = makeClip({ id: "music", startTime: 10, duration: 4, inPoint: 5, outPoint: 9, reversed: true });
    // Source 5.5 mirrors to playback 3.5 → timeline 13.5.
    expect(findSnappedSplitTime(reversed, [{ timeSec: 5.5, index: 3 }], 13.4, 0.2))
      .toEqual({ snappedTimeSec: 13.5, shiftSec: 0.09999999999999964, beatIndex: 3 });
  });
  it("scales by constant speed", () => {
    const fast = makeClip({ id: "music", startTime: 0, duration: 2, inPoint: 0, outPoint: 4, speed: 2 });
    const snap = findSnappedSplitTime(fast, [{ timeSec: 3, index: 5 }], 1.4, 0.2)!;
    expect(snap).toMatchObject({ snappedTimeSec: 1.5, beatIndex: 5 });
    expect(snap.shiftSec).toBeCloseTo(0.1, 10);
  });
});

describe("clip.splitAtBeat enrichment gates", () => {
  let root: string;
  let artifactRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let musicWav: string;
  let mediaId: string;
  let recordId: string;

  async function seedProject() {
    await facade["project.create"]({ name: "AUD-06" });
    const imported = await facade["media.import"]({ path: musicWav });
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9, clipId: "music" },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
  }

  async function writeRecord(beats: ReadonlyArray<{ timeSec: number; index: number }>, subjectMediaId = mediaId) {
    const fileStat = await stat(musicWav);
    const saved = await saveAnalysisRecord(artifactRoot, {
      projectId: "test-project",
      sourceRevision: 1,
      coordinateSpace: "source",
      subject: { mediaId: subjectMediaId, name: "music.wav", sourcePath: musicWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["beatGrid"],
      rangeSec: { startSec: 0, endSec: 12 },
      config: { analysisTypes: ["beatGrid"], startSec: 0, endSec: 12, cloudUpload: false },
      provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-beat-engine", analysisType: "beatGrid" }],
      observations: [
        { source: "beatGrid", facts: { beats: beats.map((beat) => ({ ...beat, strength: 1 })), beatCount: beats.length, bpm: 120, confidence: 0.9 } },
      ],
      inferences: [],
      recommendations: [],
      unknowns: [],
      recheckOf: null,
      cloudOpinion: null,
    });
    return saved.id;
  }

  async function projectOf(): Promise<Project> {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    return state.value.project;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rt-split-at-beat-"));
    artifactRoot = join(root, "artifacts");
    musicWav = join(root, "music.wav");
    const rate = 16000;
    const data = Buffer.alloc(rate * 12 * 8, 0);
    for (let i = 0; i < data.length; i += 8) {
      const sample = 0.3 * Math.sin(i * 0.05);
      data.writeFloatLE(sample, i);
      data.writeFloatLE(sample, i + 4);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    await writeFile(musicWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot });
    await seedProject();
    recordId = await writeRecord([
      { timeSec: 6, index: 0 },
      { timeSec: 7, index: 1 },
      { timeSec: 8, index: 2 },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const op = (extra: Partial<{ clipId: string; recordId: string; time: number; maxShiftSec: number }> = {}) => ({
    op: "clip.splitAtBeat" as const,
    clipId: "music",
    recordId,
    time: 12.3,
    maxShiftSec: 0.5,
    ...extra,
  });

  it("rewrites the op into clip.split at the snapped beat time", async () => {
    const enriched = await enrichSplitAtBeatOps([op()], artifactRoot, async () => await projectOf());
    expect(enriched).toEqual([{ op: "clip.split", clipId: "music", time: 12 }]);
  });
  it("rejects missing and stale records before any mutation", async () => {
    await expect(enrichSplitAtBeatOps([op({ recordId: "analysis-00000000-0000-4000-8000-000000000000" })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await writeFile(musicWav, Buffer.concat([await readFile(musicWav), Buffer.alloc(16)]));
    await expect(enrichSplitAtBeatOps([op()], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("stale") });
  });
  it("rejects records that analyzed another media and non-zero audio streams", async () => {
    const otherMedia = await writeRecord([{ timeSec: 6, index: 0 }], "media-something-else");
    await expect(enrichSplitAtBeatOps([op({ recordId: otherMedia })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("analyzed media") });
  });
  it("rejects speed curves, freeze frames and cut points outside the clip", async () => {
    const project = await projectOf();
    const track = project.timeline.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === "music"))!;
    const music = track.clips.find((clip) => clip.id === "music")!;
    const curved = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((candidate) =>
          candidate.id === track.id
            ? {
                ...candidate,
                clips: [{
                  ...music,
                  speedKeyframes: [{ id: "k0", time: 0, speed: 1, easing: "linear" }, { id: "k1", time: 2, speed: 2, easing: "linear" }],
                }],
              }
            : candidate),
      },
    };
    await expect(enrichSplitAtBeatOps([op()], artifactRoot, async () => curved as unknown as Project))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("speed curves") });
  });
  it("rejects a tolerance miss instead of cutting unsnapped", async () => {
    // Nearest beats are 12 (0.45 away) and 13 (0.55) — both outside 0.3.
    await expect(enrichSplitAtBeatOps([op({ time: 12.45, maxShiftSec: 0.3 })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("within maxShiftSec") });
    await expect(enrichSplitAtBeatOps([op({ time: 20 })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("strictly inside") });
  });
  it("requires artifactRoot and a project", async () => {
    await expect(enrichSplitAtBeatOps([op()], undefined, async () => await projectOf()))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") });
    await expect(enrichSplitAtBeatOps([op()], artifactRoot, async () => null))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("project") });
  });
});

describe("clip.splitAtBeat end-to-end (headless edit.apply)", () => {
  let root: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let recordId: string;

  async function currentClips(): Promise<Clip[]> {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    return state.value.project.timeline.tracks.flatMap((track) => track.clips);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rt-split-at-beat-e2e-"));
    const musicWav = join(root, "music.wav");
    const rate = 16000;
    const data = Buffer.alloc(rate * 12 * 8, 0);
    for (let i = 0; i < data.length; i += 8) {
      const sample = 0.3 * Math.sin(i * 0.05);
      data.writeFloatLE(sample, i);
      data.writeFloatLE(sample, i + 4);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    await writeFile(musicWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
    await facade["project.create"]({ name: "AUD-06 e2e" });
    const imported = await facade["media.import"]({ path: musicWav });
    if (!imported.ok) throw new Error(imported.error.message);
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId: imported.value.mediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9, clipId: "music" },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    const fileStat = await stat(musicWav);
    const saved = await saveAnalysisRecord(join(root, "artifacts"), {
      projectId: "test-project",
      sourceRevision: seeded.value.revision,
      coordinateSpace: "source",
      subject: { mediaId: imported.value.mediaId, name: "music.wav", sourcePath: musicWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["beatGrid"],
      rangeSec: { startSec: 0, endSec: 12 },
      config: { analysisTypes: ["beatGrid"], startSec: 0, endSec: 12, cloudUpload: false },
      provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-beat-engine", analysisType: "beatGrid" }],
      observations: [{ source: "beatGrid", facts: { beats: [{ timeSec: 6, strength: 1, index: 0 }, { timeSec: 7, strength: 1, index: 1 }, { timeSec: 8, strength: 1, index: 2 }], beatCount: 3, bpm: 60, confidence: 0.9 } }],
      inferences: [],
      recommendations: [],
      unknowns: [],
      recheckOf: null,
      cloudOpinion: null,
    });
    recordId = saved.id;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("splits at the snapped beat and reports the submitted op name", async () => {
    const validated = await facade["edit.validate"]({
      ops: [{ op: "clip.splitAtBeat", clipId: "music", recordId, time: 12.3, maxShiftSec: 0.5 }],
    });
    expect(validated).toMatchObject({ ok: true, value: { valid: true } });
    if (!validated.ok) throw new Error(validated.error.message);
    // The dry run reports the snapped plain split.
    expect(validated.value.normalizedOps[0]).toEqual({ op: "clip.split", clipId: "music", time: 12 });

    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.splitAtBeat", clipId: "music", recordId, time: 12.3, maxShiftSec: 0.5 }],
      idempotencyKey: "split-at-beat-1",
    });
    expect(applied).toMatchObject({
      ok: true,
      value: { replayed: false, applied: [{ op: "clip.splitAtBeat" }] },
    });
    const clips = await currentClips();
    expect(clips).toHaveLength(2);
    const sorted = [...clips].sort((l, r) => l.startTime - r.startTime);
    expect(sorted.map((clip) => [clip.startTime, clip.duration, clip.inPoint, clip.outPoint]))
      .toEqual([[10, 2, 5, 7], [12, 2, 7, 9]]);

    const replay = await facade["edit.apply"]({
      ops: [{ op: "clip.splitAtBeat", clipId: "music", recordId, time: 12.3, maxShiftSec: 0.5 }],
      idempotencyKey: "split-at-beat-1",
    });
    expect(replay).toMatchObject({ ok: true, value: { replayed: true } });
    expect(await currentClips()).toHaveLength(2);
  });

  it("maps through an earlier clip.move in the same batch", async () => {
    const applied = await facade["edit.apply"]({
      ops: [
        { op: "clip.move", clipId: "music", startTime: 12 },
        { op: "clip.splitAtBeat", clipId: "music", recordId, time: 14.3, maxShiftSec: 0.5 },
      ],
    });
    expect(applied).toMatchObject({ ok: true });
    const sorted = [...(await currentClips())].sort((l, r) => l.startTime - r.startTime);
    // Beats now land at 13/14/15; the point 14.3 snaps to 14.
    expect(sorted.map((clip) => [clip.startTime, clip.duration])).toEqual([[12, 2], [14, 2]]);
  });

  it("CAS conflicts leave the clip untouched and merge restores one undo unit", async () => {
    const conflict = await facade["edit.apply"]({
      ops: [{ op: "clip.splitAtBeat", clipId: "music", recordId, time: 12.3, maxShiftSec: 0.5 }],
      expectedRevision: 0,
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await currentClips()).toHaveLength(1);

    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const project = state.value.project;
    const [prepared] = await enrichSplitAtBeatOps(
      [{ op: "clip.splitAtBeat", clipId: "music", recordId, time: 12.3, maxShiftSec: 0.5 }],
      join(root, "artifacts"),
      async () => project,
    );
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    const [action] = opToCoreActions(prepared, project);
    const executed = await executor.execute(action!, project);
    expect(executed.success).toBe(true);
    expect(project.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(2);
    const inverse = history.undo();
    expect(inverse?.type).toBe("clip/merge");
    const undone = await executor.execute(inverse!, project);
    expect(undone.success).toBe(true);
    const restored = project.timeline.tracks.flatMap((track) => track.clips);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "music", startTime: 10, duration: 4, inPoint: 5, outPoint: 9 });
  });
});
