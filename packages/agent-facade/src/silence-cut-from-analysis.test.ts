/**
 * clip.cutSilenceFromAnalysis — AUD-05: record-driven silence cutting.
 *
 * Covered behavior:
 *  - the pure source→timeline mapping kernel (inPoint anchoring, constant
 *    speed, reverse mirroring, window clamping) and the pause/padding policy;
 *  - the enrich gates: missing/stale/fact-less records, wrong media,
 *    non-zero audioTrackIndex, speed curves and freeze frames, aligned
 *    siblings with divergent timing, desyncing subtitles, nothing-to-cut and
 *    the maxCutRegions cap — all before any mutation starts;
 *  - end-to-end edit.apply: the plan expands into the same split/ripple
 *    actions the GUI silence-cut panel emits (fragments land back-to-back,
 *    ripple shifts later clips, fades protect cut edges), linked siblings
 *    are cut together, an earlier clip.move in the same batch is honored,
 *    idempotent replay does not cut twice, CAS conflicts change nothing, and
 *    the core inverses restore the original clip in one undo unit.
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
import {
  DEFAULT_CUT_SILENCE_FADE_SEC,
  enrichCutSilenceOps,
  filterRegionsForCut,
  mapSilenceRegionsToTimelineWindows,
  planSilenceCuts,
  type PreparedCutSilenceFromAnalysisOp,
} from "./silence-cut-from-analysis";
import { saveAnalysisRecord } from "./analysis-records";
import { opToCoreActions } from "./ops";
import type { EditOp } from "./types";

function makeClip(overrides: Partial<Clip> & Pick<Clip, "id" | "startTime" | "duration" | "inPoint">): Clip {
  return {
    mediaId: "m-voice",
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

describe("silence region → timeline window kernel", () => {
  it("anchors source inPoint at the clip start and clamps to the clip window", () => {
    const clip = makeClip({ id: "voice", startTime: 10, duration: 10, inPoint: 5, outPoint: 15 });
    const windows = mapSilenceRegionsToTimelineWindows(clip, [
      { startSec: 7, endSec: 9 },   // inside the trim window → 12..14
      { startSec: 3, endSec: 6 },   // before inPoint → clamped to 5..6 → 10..11
      { startSec: 15, endSec: 18 }, // after the trim window → dropped
    ]);
    expect(windows).toEqual([
      { startSec: 10, endSec: 11 },
      { startSec: 12, endSec: 14 },
    ]);
  });
  it("scales by constant speed", () => {
    const clip = makeClip({ id: "voice", startTime: 0, duration: 5, inPoint: 0, outPoint: 10, speed: 2 });
    const windows = mapSilenceRegionsToTimelineWindows(clip, [{ startSec: 4, endSec: 8 }]);
    expect(windows).toEqual([{ startSec: 2, endSec: 4 }]);
  });
  it("maps reverse playback through the mirrored source timeline", () => {
    const clip = makeClip({ id: "voice", startTime: 10, duration: 4, inPoint: 5, outPoint: 9, reversed: true });
    // Source 5.5..6.5 mirrors to playback 3.5..2.5 → timeline 12.5..13.5.
    const windows = mapSilenceRegionsToTimelineWindows(clip, [{ startSec: 5.5, endSec: 6.5 }]);
    expect(windows).toEqual([{ startSec: 12.5, endSec: 13.5 }]);
  });
  it("drops degenerate windows", () => {
    const clip = makeClip({ id: "voice", startTime: 0, duration: 4, inPoint: 0 });
    expect(mapSilenceRegionsToTimelineWindows(clip, [{ startSec: 1, endSec: 1.0005 }])).toEqual([]);
    expect(mapSilenceRegionsToTimelineWindows(clip, [])).toEqual([]);
  });
});

describe("pause-keeping and padding policy", () => {
  const regions = [
    { startSec: 2, endSec: 4 },    // 2 s
    { startSec: 6, endSec: 6.5 },  // 0.5 s
  ];
  it("keeps regions below minSilenceSec as pauses", () => {
    expect(filterRegionsForCut(regions, { minSilenceSec: 1 })).toEqual([{ startSec: 2, endSec: 4 }]);
  });
  it("cuts everything the record kept by default", () => {
    expect(filterRegionsForCut(regions, {})).toEqual(regions);
  });
  it("shrinks both edges by padding and drops fully padded regions", () => {
    expect(filterRegionsForCut(regions, { paddingSec: 0.25 })).toEqual([{ startSec: 2.25, endSec: 3.75 }]);
    expect(filterRegionsForCut([{ startSec: 6, endSec: 6.4 }], { paddingSec: 0.25 })).toEqual([]);
  });
});

describe("plan gates (pure)", () => {
  const base = makeClip({ id: "voice", startTime: 10, duration: 10, inPoint: 5, outPoint: 15 });
  it("rejects speed curves and freeze frames like the core split action", () => {
    const curved = makeClip({
      id: "voice", startTime: 0, duration: 4, inPoint: 0, outPoint: 4,
      speedKeyframes: [{ id: "k0", time: 0, speed: 1, easing: "linear" }],
    });
    expect(() => planSilenceCuts(curved, [], [{ startSec: 1, endSec: 2 }], { fadeSec: 0.01 }))
      .toThrow(/speed curves or freeze frames/);
    const frozen = makeClip({
      id: "voice", startTime: 0, duration: 4, inPoint: 0, outPoint: 4,
      freezeFrames: [{ id: "f1", clipId: "voice", sourceTime: 1, startTime: 1, duration: 1 }],
    });
    expect(() => planSilenceCuts(frozen, [], [{ startSec: 1, endSec: 2 }], { fadeSec: 0.01 }))
      .toThrow(/speed curves or freeze frames/);
  });
  it("rejects a non-positive speed", () => {
    const clip = makeClip({ id: "voice", startTime: 0, duration: 4, inPoint: 0, speed: 0 });
    expect(() => planSilenceCuts(clip, [], [{ startSec: 1, endSec: 2 }], { fadeSec: 0.01 }))
      .toThrow(/non-positive speed/);
  });
  it("returns one entry per clip and flags fade needs", () => {
    const sibling = makeClip({ id: "voiceLinked", startTime: 10, duration: 10, inPoint: 5, outPoint: 15, trackId: "a2" });
    const plan = planSilenceCuts(base, [sibling], [{ startSec: 7, endSec: 9 }], { fadeSec: 0 });
    expect(plan.needsFades).toBe(false);
    expect(plan.entries.map((entry) => entry.clipId)).toEqual(["voice", "voiceLinked"]);
    expect(plan.entries[0]!.windows).toEqual([{ startSec: 12, endSec: 14 }]);
    const faded = planSilenceCuts(base, [], [{ startSec: 7, endSec: 9 }], { fadeSec: DEFAULT_CUT_SILENCE_FADE_SEC });
    expect(faded.needsFades).toBe(true);
    const inherited = makeClip({ ...base, fade: { fadeIn: 0.5, fadeOut: 0 } });
    expect(planSilenceCuts(inherited, [], [{ startSec: 7, endSec: 9 }], { fadeSec: 0 }).needsFades).toBe(true);
  });
});

describe("clip.cutSilenceFromAnalysis enrichment gates", () => {
  let root: string;
  let artifactRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let voiceWav: string;
  let mediaId: string;
  let recordId: string;

  async function seedProject(extra: readonly EditOp[] = []) {
    await facade["project.create"]({ name: "AUD-05" });
    const imported = await facade["media.import"]({ path: voiceWav });
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId, startTime: 10, duration: 10, inPoint: 5, outPoint: 15, clipId: "voice" },
        ...extra,
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
  }

  async function writeRecord(regions: ReadonlyArray<{ startSec: number; endSec: number }>, subjectMediaId = mediaId) {
    const fileStat = await stat(voiceWav);
    const saved = await saveAnalysisRecord(artifactRoot, {
      projectId: "test-project",
      sourceRevision: 1,
      coordinateSpace: "source",
      subject: { mediaId: subjectMediaId, name: "voice.wav", sourcePath: voiceWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["silence"],
      rangeSec: { startSec: 0, endSec: 20 },
      config: { analysisTypes: ["silence"], startSec: 0, endSec: 20, cloudUpload: false, silenceParams: { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 } },
      provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-silence-kernel", analysisType: "silence" }],
      observations: [
        { source: "silence", facts: { silentRegions: regions.map((region) => ({ ...region, durationSec: region.endSec - region.startSec })), regionCount: regions.length } },
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
    root = await mkdtemp(join(tmpdir(), "rt-cut-silence-"));
    artifactRoot = join(root, "artifacts");
    voiceWav = join(root, "voice.wav");
    const rate = 16000;
    const data = Buffer.alloc(rate * 20 * 8, 0);
    for (let i = rate * 6; i < rate * 8; i++) {
      const sample = 0.5 * Math.sin(i * 0.07);
      data.writeFloatLE(sample, i * 8);
      data.writeFloatLE(sample, i * 8 + 4);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    await writeFile(voiceWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot });
    await seedProject();
    recordId = await writeRecord([{ startSec: 7, endSec: 9 }, { startSec: 11, endSec: 13 }]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const op = (extra: Partial<{ clipId: string; recordId: string; minSilenceSec: number; paddingSec: number; maxCutRegions: number }> = {}) => ({
    op: "clip.cutSilenceFromAnalysis" as const,
    clipId: "voice",
    recordId,
    ...extra,
  });

  it("attaches the concrete plan with mapped windows", async () => {
    const enriched = await enrichCutSilenceOps([op()], artifactRoot, async () => await projectOf());
    const prepared = enriched[0] as PreparedCutSilenceFromAnalysisOp;
    expect(prepared.cuts).toMatchObject({
      fadeSec: DEFAULT_CUT_SILENCE_FADE_SEC,
      needsFades: true,
      entries: [{ clipId: "voice", windows: [{ startSec: 12, endSec: 14 }, { startSec: 16, endSec: 18 }] }],
    });
  });
  it("rejects missing, stale and fact-less records before any mutation", async () => {
    await expect(enrichCutSilenceOps([op({ recordId: "analysis-00000000-0000-4000-8000-000000000000" })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await writeFile(voiceWav, Buffer.concat([await readFile(voiceWav), Buffer.alloc(16)]));
    await expect(enrichCutSilenceOps([op()], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("stale") });
  });
  it("rejects records that analyzed another media and non-zero audio streams", async () => {
    const otherMedia = await writeRecord([{ startSec: 7, endSec: 9 }], "media-something-else");
    await expect(enrichCutSilenceOps([op({ recordId: otherMedia })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("analyzed media") });
    const project = await projectOf();
    const track = project.timeline.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === "voice"))!;
    const voice = track.clips.find((clip) => clip.id === "voice")!;
    const otherStream = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((candidate) =>
          candidate.id === track.id ? { ...candidate, clips: [{ ...voice, audioTrackIndex: 1 }] } : candidate),
      },
    };
    await expect(enrichCutSilenceOps([op()], artifactRoot, async () => otherStream))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("audioTrackIndex 1") });
  });
  it("requires artifactRoot and a project", async () => {
    await expect(enrichCutSilenceOps([op()], undefined, async () => await projectOf()))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") });
    await expect(enrichCutSilenceOps([op()], artifactRoot, async () => null))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("project") });
  });
  it("rejects when nothing survives the policy and caps the region count", async () => {
    await expect(enrichCutSilenceOps([op({ minSilenceSec: 5 })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("nothing to cut") });
    await expect(enrichCutSilenceOps([op({ maxCutRegions: 1 })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("maxCutRegions") });
  });
  it("rejects aligned siblings with divergent timing instead of desyncing them", async () => {
    const divergent = await seedLinkedClip({ speed: 2 });
    await expect(enrichCutSilenceOps([op()], artifactRoot, async () => divergent))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("desync") });
  });
  it("rejects projects whose subtitles would desync", async () => {
    const project = await projectOf();
    const withSubs = {
      ...project,
      timeline: {
        ...project.timeline,
        subtitles: [{ id: "s1", text: "hello", startTime: 13, endTime: 15 }],
      },
    };
    await expect(enrichCutSilenceOps([op()], artifactRoot, async () => withSubs))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("subtitle") });
    // A cue that ends before the first cut is safe.
    const safeSubs = {
      ...project,
      timeline: {
        ...project.timeline,
        subtitles: [{ id: "s0", text: "early", startTime: 1, endTime: 2 }],
      },
    };
    const enriched = await enrichCutSilenceOps([op()], artifactRoot, async () => safeSubs);
    expect((enriched[0] as PreparedCutSilenceFromAnalysisOp).cuts?.entries).toHaveLength(1);
  });

  async function seedLinkedClip(overrides: Partial<Clip>): Promise<Project> {
    const project = await projectOf();
    const voice = project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "voice")!;
    const linked = { ...voice, id: "voiceLinked", trackId: "a2", ...overrides } as Clip;
    const template = project.timeline.tracks[0]!;
    return {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: [
          ...project.timeline.tracks,
          { ...template, id: "a2", clips: [linked] },
        ],
      },
    };
  }
});

describe("clip.cutSilenceFromAnalysis end-to-end (headless edit.apply)", () => {
  let root: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let recordId: string;
  let mediaId: string;
  let voiceWav: string;
  let sourceRevision: number;

  async function currentClips(): Promise<Clip[]> {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    return state.value.project.timeline.tracks.flatMap((track) => track.clips);
  }

  async function writeSilenceRecord(regions: ReadonlyArray<{ startSec: number; endSec: number }>): Promise<string> {
    const fileStat = await stat(voiceWav);
    const saved = await saveAnalysisRecord(join(root, "artifacts"), {
      projectId: "test-project",
      sourceRevision,
      coordinateSpace: "source",
      subject: { mediaId, name: "voice.wav", sourcePath: voiceWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["silence"],
      rangeSec: { startSec: 0, endSec: 20 },
      config: { analysisTypes: ["silence"], startSec: 0, endSec: 20, cloudUpload: false, silenceParams: { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 } },
      provenance: [{ kind: "local-measurement", provider: "local-ffmpeg-pcm-silence-kernel", analysisType: "silence" }],
      observations: [{
        source: "silence",
        facts: {
          silentRegions: regions.map((region) => ({ ...region, durationSec: region.endSec - region.startSec })),
          regionCount: regions.length,
        },
      }],
      inferences: [],
      recommendations: [],
      unknowns: [],
      recheckOf: null,
      cloudOpinion: null,
    });
    return saved.id;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rt-cut-silence-e2e-"));
    voiceWav = join(root, "voice.wav");
    const rate = 16000;
    const data = Buffer.alloc(rate * 20 * 8, 0);
    for (let i = rate * 6; i < rate * 8; i++) {
      const sample = 0.4 * Math.sin(i * 0.07);
      data.writeFloatLE(sample, i * 8);
      data.writeFloatLE(sample, i * 8 + 4);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    await writeFile(voiceWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
    await facade["project.create"]({ name: "AUD-05 e2e" });
    const imported = await facade["media.import"]({ path: voiceWav });
    if (!imported.ok) throw new Error(imported.error.message);
    mediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId, startTime: 10, duration: 10, inPoint: 5, outPoint: 15, clipId: "voice" },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    sourceRevision = seeded.value.revision;
    recordId = await writeSilenceRecord([{ startSec: 7, endSec: 9 }, { startSec: 11, endSec: 13 }]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cuts mapped silences into back-to-back fragments with ripple and edge fades", async () => {
    const validated = await facade["edit.validate"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId }],
    });
    expect(validated).toMatchObject({ ok: true, value: { valid: true } });

    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId }],
      idempotencyKey: "cut-silence-1",
    });
    expect(applied).toMatchObject({
      ok: true,
      value: { replayed: false, applied: [{ op: "clip.cutSilenceFromAnalysis" }] },
    });
    const clips = await currentClips();
    // 10 s of speech with 2×2 s silences → three 2 s fragments, back to back.
    expect(clips).toHaveLength(3);
    const sorted = [...clips].sort((left, right) => left.startTime - right.startTime);
    expect(sorted.map((clip) => [clip.startTime, clip.duration])).toEqual([[10, 2], [12, 2], [14, 2]]);
    // Cut edges carry the click-protection fade; original clip edges keep 0.
    expect(sorted[0]!.fade).toEqual({ fadeIn: 0, fadeOut: DEFAULT_CUT_SILENCE_FADE_SEC });
    expect(sorted[1]!.fade).toEqual({ fadeIn: DEFAULT_CUT_SILENCE_FADE_SEC, fadeOut: DEFAULT_CUT_SILENCE_FADE_SEC });
    expect(sorted[2]!.fade).toEqual({ fadeIn: DEFAULT_CUT_SILENCE_FADE_SEC, fadeOut: 0 });
    // The fragments play the KEPT source ranges: 5..7, 9..11, 13..15.
    expect(sorted.map((clip) => [clip.inPoint, clip.outPoint])).toEqual([[5, 7], [9, 11], [13, 15]]);

    const replay = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId }],
      idempotencyKey: "cut-silence-1",
    });
    expect(replay).toMatchObject({ ok: true, value: { replayed: true } });
    expect(await currentClips()).toHaveLength(3);
  });

  it("cuts a leading silence and fades in the retained tail", async () => {
    const edgeRecord = await writeSilenceRecord([{ startSec: 5, endSec: 7 }]);
    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId: edgeRecord }],
    });
    expect(applied).toMatchObject({ ok: true });
    const clips = await currentClips();
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      startTime: 10,
      duration: 8,
      inPoint: 7,
      outPoint: 15,
      fade: { fadeIn: DEFAULT_CUT_SILENCE_FADE_SEC, fadeOut: 0 },
    });
  });

  it("cuts a trailing silence and fades out the retained head", async () => {
    const edgeRecord = await writeSilenceRecord([{ startSec: 13, endSec: 15 }]);
    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId: edgeRecord }],
    });
    expect(applied).toMatchObject({ ok: true });
    const clips = await currentClips();
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      startTime: 10,
      duration: 8,
      inPoint: 5,
      outPoint: 13,
      fade: { fadeIn: 0, fadeOut: DEFAULT_CUT_SILENCE_FADE_SEC },
    });
  });

  it("deletes a clip whose whole span is silent", async () => {
    const wholeRecord = await writeSilenceRecord([{ startSec: 5, endSec: 15 }]);
    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId: wholeRecord }],
    });
    expect(applied).toMatchObject({ ok: true });
    expect(await currentClips()).toHaveLength(0);
  });

  it("keeps pauses below minSilenceSec and honors edge padding", async () => {
    // Both regions are 2 s — below minSilenceSec 2.5 they are kept as
    // pauses, and the op refuses honestly instead of applying a no-op.
    const kept = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId, minSilenceSec: 2.5 }],
    });
    expect(kept).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("nothing to cut") } });
    expect(await currentClips()).toHaveLength(1);

    // paddingSec 0.5 shrinks every cut by 0.5 s on both edges: 2×1 s cuts
    // leave 2.5/3/2.5 s fragments.
    const padded = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId, paddingSec: 0.5 }],
    });
    expect(padded).toMatchObject({ ok: true });
    const sorted = [...(await currentClips())].sort((l, r) => l.startTime - r.startTime);
    expect(sorted.map((clip) => [clip.startTime, clip.duration])).toEqual([[10, 2.5], [12.5, 3], [15.5, 2.5]]);
    expect(sorted.map((clip) => [clip.inPoint, clip.outPoint])).toEqual([[5, 7.5], [8.5, 11.5], [12.5, 15]]);
  });

  it("cuts an aligned timing-identical sibling so A/V stays in sync", async () => {
    const linked = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a2" },
        { op: "clip.add", trackId: "a2", mediaId, startTime: 10, duration: 10, inPoint: 5, outPoint: 15, clipId: "voiceLinked" },
        { op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId },
      ],
    });
    expect(linked).toMatchObject({ ok: true });
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const tracks = state.value.project.timeline.tracks;
    for (const trackId of ["a1", "a2"]) {
      const clips = [...tracks.find((track) => track.id === trackId)!.clips].sort((l, r) => l.startTime - r.startTime);
      expect(clips.map((clip) => [clip.startTime, clip.duration])).toEqual([[10, 2], [12, 2], [14, 2]]);
    }
  });

  it("maps through an earlier clip.move in the same batch", async () => {
    const applied = await facade["edit.apply"]({
      ops: [
        { op: "clip.move", clipId: "voice", startTime: 12 },
        { op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId },
      ],
    });
    expect(applied).toMatchObject({ ok: true });
    const sorted = [...(await currentClips())].sort((l, r) => l.startTime - r.startTime);
    // Moved to 12..22: windows 14..16 and 18..20 → fragments 12/14/16.
    expect(sorted.map((clip) => [clip.startTime, clip.duration])).toEqual([[12, 2], [14, 2], [16, 2]]);
  });

  it("CAS conflicts leave the clip untouched", async () => {
    const before = await currentClips();
    const conflict = await facade["edit.apply"]({
      ops: [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId }],
      expectedRevision: 0,
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await currentClips()).toEqual(before);
  });

  it("the core inverses restore the original clip in one undo unit", async () => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const project = state.value.project;
    const [prepared] = await enrichCutSilenceOps(
      [{ op: "clip.cutSilenceFromAnalysis", clipId: "voice", recordId }],
      join(root, "artifacts"),
      async () => project,
    );
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    history.beginGroup("cut silence");
    for (const action of opToCoreActions(prepared, project)) {
      const result = await executor.execute(action, project);
      if (!result.success) throw new Error(`action ${action.type} failed`);
    }
    history.endGroup();
    const cut = project.timeline.tracks.flatMap((track) => track.clips);
    expect(cut).toHaveLength(3);

    // undoGroup() yields the inverses already ordered last-action-first.
    const inverseActions = history.undoGroup();
    expect(inverseActions.length).toBeGreaterThan(0);
    for (const inverse of inverseActions) {
      const result = await executor.execute(inverse, project);
      if (!result.success) throw new Error(`undo ${inverse.type} failed: ${result.error?.message}`);
    }
    const restored = project.timeline.tracks.flatMap((track) => track.clips);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "voice", startTime: 10, duration: 10, inPoint: 5, outPoint: 15 });
    expect(restored[0]!.fade).toBeUndefined();
  });
});
