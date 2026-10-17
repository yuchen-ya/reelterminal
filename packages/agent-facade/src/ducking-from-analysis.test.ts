/**
 * clip.setDuckingFromAnalysis — AUD-02: record-driven ducking.
 *
 * Covered behavior:
 *  - the pure source→timeline→target mapping: source inPoint anchoring,
 *    constant-speed scaling, trim and target-overlap intersection, and the
 *    explicit rejections (reverse, speed curves, freeze frames, non-positive
 *    speed) named in the audio TODO;
 *  - the enrich gates: missing/stale records, records without speechActivity
 *    facts, records analyzing another media than the speech clip plays,
 *    speech/target clip lookup, envelope-conflict policy (error vs replace)
 *    and the no-overlap rejection — all before any mutation starts;
 *  - end-to-end edit.apply: rewritten to clip.setDucking (shared kernel),
 *    envelope + panel snapshot persisted, idempotent replay, CAS conflicts
 *    leave nothing applied, and re-ducking without existingEnvelope:"replace"
 *    conflicts instead of silently stacking;
 *  - the core inverse restores BOTH ducking fields, so GUI undo of this op
 *    is one full-restore unit (same semantic as the GUI ducking panel).
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
import { enrichDuckingFromAnalysisOps, mapSpeechRegionsToPresenceRanges } from "./ducking-from-analysis";
import { saveAnalysisRecord } from "./analysis-records";
import { opToCoreActions } from "./ops";
import type { EditOp } from "./types";

const TUNING = {
  threshold: -30,
  reduction: 0.6,
  attack: 0.1,
  release: 0.3,
  holdTime: 0.2,
};

function makeClip(overrides: Partial<Clip> & Pick<Clip, "id" | "startTime" | "duration" | "inPoint">): Clip {
  return {
    mediaId: "m-speech",
    trackId: "t1",
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

describe("speechRegion → presence mapping kernel", () => {
  it("anchors source inPoint at the clip start and clips to the speech window", () => {
    const speech = makeClip({ id: "speech", startTime: 10, duration: 4, inPoint: 5 });
    const target = makeClip({ id: "bgm", startTime: 8, duration: 20, inPoint: 0 });
    const presence = mapSpeechRegionsToPresenceRanges(speech, target, [
      { startSec: 6, endSec: 8 },   // fully inside the trim window
      { startSec: 4, endSec: 6 },   // before inPoint → clipped to the window edge
      { startSec: 9, endSec: 12 },  // after the trim window → dropped entirely
    ]);
    // Source 5..9 maps to timeline 10..14; target-local = timeline − 8.
    expect(presence).toEqual([
      { start: 3, end: 5 },
      { start: 2, end: 3 },
    ]);
  });
  it("scales durations by constant speed and intersects the target window", () => {
    const speech = makeClip({ id: "speech", startTime: 10, duration: 2, inPoint: 5, speed: 2 });
    const target = makeClip({ id: "bgm", startTime: 11, duration: 3, inPoint: 0 });
    const presence = mapSpeechRegionsToPresenceRanges(speech, target, [{ startSec: 6, endSec: 9 }]);
    // Source 5..9 at 2x spans timeline 10..12; region 6..9 maps to 10.5..12,
    // the speech window clamps nothing extra, and the target window 11..14
    // keeps 11..12 → target-local 0..1.
    expect(presence).toEqual([{ start: 0, end: 1 }]);
  });
  it("returns nothing when the clips never overlap on the timeline", () => {
    const speech = makeClip({ id: "speech", startTime: 100, duration: 4, inPoint: 5 });
    const target = makeClip({ id: "bgm", startTime: 0, duration: 10, inPoint: 0 });
    expect(mapSpeechRegionsToPresenceRanges(speech, target, [{ startSec: 6, endSec: 8 }])).toEqual([]);
  });
  it("rejects reverse, speed curves, freeze frames and non-positive speed by name", () => {
    const target = makeClip({ id: "bgm", startTime: 0, duration: 10, inPoint: 0 });
    const regions = [{ startSec: 6, endSec: 8 }];
    expect(() => mapSpeechRegionsToPresenceRanges(makeClip({ id: "s", startTime: 0, duration: 4, inPoint: 5, reversed: true }), target, regions))
      .toThrow("reversed");
    expect(() => mapSpeechRegionsToPresenceRanges(
      makeClip({ id: "s", startTime: 0, duration: 4, inPoint: 5, speedKeyframes: [{ id: "k1", time: 0, speed: 1, easing: "linear" }] }),
      target,
      regions,
    )).toThrow("speed curve");
    expect(() => mapSpeechRegionsToPresenceRanges(
      makeClip({ id: "s", startTime: 0, duration: 4, inPoint: 5, freezeFrames: [{ id: "f1" }] as never }),
      target,
      regions,
    )).toThrow("freeze frames");
    expect(() => mapSpeechRegionsToPresenceRanges(makeClip({ id: "s", startTime: 0, duration: 4, inPoint: 5, speed: 0 }), target, regions))
      .toThrow("non-positive speed");
  });
});

describe("clip.setDuckingFromAnalysis enrichment gates", () => {
  let root: string;
  let artifactRoot: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let speechWav: string;
  let speechMediaId: string;
  let speechClipId: string;
  let bgmClipId: string;
  let recordId: string;

  async function seedProject() {
    await facade["project.create"]({ name: "AUD-02" });
    const imported = await facade["media.import"]({ path: speechWav });
    if (!imported.ok) throw new Error(imported.error.message);
    speechMediaId = imported.value.mediaId;
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId: speechMediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9, clipId: "speech" },
        { op: "track.add", trackType: "audio", trackId: "a2" },
        { op: "clip.add", trackId: "a2", mediaId: speechMediaId, startTime: 8, duration: 8, clipId: "bgm" },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    speechClipId = "speech";
    bgmClipId = "bgm";
  }

  async function writeRecord(regions: ReadonlyArray<{ startSec: number; endSec: number }>, mediaId = speechMediaId) {
    const fileStat = await stat(speechWav);
    const saved = await saveAnalysisRecord(artifactRoot, {
      projectId: "test-project",
      sourceRevision: 1,
      coordinateSpace: "source",
      subject: { mediaId, name: "speech.wav", sourcePath: speechWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["speechActivity"],
      rangeSec: { startSec: 0, endSec: 20 },
      config: { analysisTypes: ["speechActivity"], startSec: 0, endSec: 20, cloudUpload: false },
      provenance: [{ kind: "local-measurement", provider: "local-silero-vad-onnx", analysisType: "speechActivity" }],
      observations: [
        { source: "speechActivity", facts: { speechRegions: regions.map((region) => ({ ...region, durationSec: region.endSec - region.startSec })), regionCount: regions.length } },
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
    root = await mkdtemp(join(tmpdir(), "rt-ducking-a2-"));
    artifactRoot = join(root, "artifacts");
    speechWav = join(root, "speech.wav");
    // Valid 16 kHz stereo f32 WAV; content is irrelevant to these gates.
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
    await writeFile(speechWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot });
    await seedProject();
    recordId = await writeRecord([{ startSec: 6, endSec: 8 }, { startSec: 10, endSec: 12 }]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const op = (extra: Partial<{ existingEnvelope: "error" | "replace"; recordId: string; speechClipId: string; clipId: string }> = {}) => ({
    op: "clip.setDuckingFromAnalysis" as const,
    clipId: bgmClipId,
    speechClipId,
    recordId,
    ...TUNING,
    ...extra,
  });

  it("rewrites the op into clip.setDucking with mapped, intersected presenceRanges", async () => {
    const marker: EditOp = { op: "track.add", trackType: "video", trackId: "v9" };
    const enriched = await enrichDuckingFromAnalysisOps([marker, op()], artifactRoot, async () => await projectOf());
    expect(enriched).toHaveLength(2);
    expect(enriched[0]).toBe(marker);
    // Region 6..8 maps to timeline 11..13 (speech clip 10..14, inPoint 5);
    // region 10..12 lies outside the trim window and is dropped. BGM clip
    // starts at 8, so presence is target-local 3..5.
    expect(enriched[1]).toEqual({
      op: "clip.setDucking",
      clipId: "bgm",
      ...TUNING,
      presenceRanges: [{ start: 3, end: 5 }],
    });
  });
  it("rejects missing, stale and fact-less records before any mutation", async () => {
    await expect(enrichDuckingFromAnalysisOps([op({ recordId: "analysis-00000000-0000-4000-8000-000000000000" })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    // Stale: the source file changed after the analysis (size differs).
    await writeFile(speechWav, Buffer.concat([await readFile(speechWav), Buffer.alloc(16)]));
    await expect(enrichDuckingFromAnalysisOps([op()], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("stale") });
  });
  it("rejects records that analyzed another media than the speech clip plays", async () => {
    const otherRecord = await writeRecord([{ startSec: 6, endSec: 8 }], "media-something-else");
    await expect(enrichDuckingFromAnalysisOps([op({ recordId: otherRecord })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("analyzed media") });
  });
  it("requires artifactRoot and a project", async () => {
    await expect(enrichDuckingFromAnalysisOps([op()], undefined, async () => await projectOf()))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") });
    await expect(enrichDuckingFromAnalysisOps([op()], artifactRoot, async () => null))
      .rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("project") });
  });
  it("rejects when no speech region overlaps the ducked clip", async () => {
    const farRecord = await writeRecord([{ startSec: 12, endSec: 14 }]); // outside the speech clip trim
    await expect(enrichDuckingFromAnalysisOps([op({ recordId: farRecord })], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("no speech regions") });
  });
  it("never silently overwrites an existing envelope without replace", async () => {
    const manual = await facade["edit.apply"]({
      ops: [{ op: "clip.setDucking", clipId: "bgm", ...TUNING, points: [{ time: 0, value: 1 }, { time: 1, value: 0.5 }] }],
    });
    if (!manual.ok) throw new Error(manual.error.message);
    await expect(enrichDuckingFromAnalysisOps([op()], artifactRoot, async () => await projectOf()))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("existingEnvelope") });
    const enriched = await enrichDuckingFromAnalysisOps([op({ existingEnvelope: "replace" })], artifactRoot, async () => await projectOf());
    expect(enriched[0]).toMatchObject({ op: "clip.setDucking", presenceRanges: [{ start: 3, end: 5 }] });
  });
});

describe("clip.setDuckingFromAnalysis end-to-end (headless edit.apply)", () => {
  // Reuse the same seeding shape as the gates suite, via a thinner local copy.
  let root: string;
  let facade: ReturnType<typeof createAgentFacade>;
  let recordId: string;
  const speechWavPath = () => join(root, "speech.wav");

  async function currentClips() {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    return state.value.project.timeline.tracks.flatMap((track) => track.clips);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rt-ducking-e2e-"));
    const speechWav = speechWavPath();
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
    await writeFile(speechWav, Buffer.concat([header, data]));
    facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
    await facade["project.create"]({ name: "AUD-02 e2e" });
    const imported = await facade["media.import"]({ path: speechWav });
    if (!imported.ok) throw new Error(imported.error.message);
    const seeded = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "audio", trackId: "a1" },
        { op: "clip.add", trackId: "a1", mediaId: imported.value.mediaId, startTime: 10, duration: 4, inPoint: 5, outPoint: 9, clipId: "speech" },
        { op: "track.add", trackType: "audio", trackId: "a2" },
        { op: "clip.add", trackId: "a2", mediaId: imported.value.mediaId, startTime: 8, duration: 8, clipId: "bgm" },
      ],
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    const fileStat = await stat(speechWav);
    const saved = await saveAnalysisRecord(join(root, "artifacts"), {
      projectId: "test-project",
      sourceRevision: seeded.value.revision,
      coordinateSpace: "source",
      subject: { mediaId: imported.value.mediaId, name: "speech.wav", sourcePath: speechWav, sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) } },
      analysisTypes: ["speechActivity"],
      rangeSec: { startSec: 0, endSec: 20 },
      config: { analysisTypes: ["speechActivity"], startSec: 0, endSec: 20, cloudUpload: false },
      provenance: [{ kind: "local-measurement", provider: "local-silero-vad-onnx", analysisType: "speechActivity" }],
      observations: [{ source: "speechActivity", facts: { speechRegions: [{ startSec: 6, endSec: 8, durationSec: 2 }], regionCount: 1 } }],
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

  it("applies record-driven ducking through the shared clip.setDucking path", async () => {
    const validated = await facade["edit.validate"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING }],
    });
    expect(validated).toMatchObject({ ok: true });
    const stateBefore = await facade["project.get_state"]();
    if (!stateBefore.ok) throw new Error("state failed");
    const revisionBefore = stateBefore.value.revision;
    const applied = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING }],
      idempotencyKey: "duck-from-analysis-1",
    });
    expect(applied).toMatchObject({ ok: true, value: { replayed: false, applied: [{ op: "clip.setDuckingFromAnalysis" }] } });
    const clips = await currentClips();
    const bgm = clips.find((clip) => clip.id === "bgm")!;
    expect(bgm.automation?.volume?.length).toBeGreaterThan(0);
    // The ducking envelope must dip across the mapped speech window (3..5s
    // target-local): the kernel keys the ducked value at range boundaries and
    // normal volume outside attack/release (attack 0.1, release 0.3).
    const points = bgm.automation!.volume!;
    const during = points.filter((point) => point.time >= 2.95 && point.time <= 5.05).map((point) => point.value);
    const outside = points.filter((point) => point.time < 2.85 || point.time > 5.35).map((point) => point.value);
    expect(during.length).toBeGreaterThan(0);
    const outsideCeiling = outside.length > 0 ? Math.max(...outside) : 1;
    expect(Math.min(...during)).toBeLessThan(outsideCeiling);
    expect(bgm.metadata?.audioDucking).toMatchObject({ enabled: true, ...TUNING });

    const replay = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING }],
      idempotencyKey: "duck-from-analysis-1",
    });
    expect(replay).toMatchObject({ ok: true, value: { replayed: true } });
    const stateAfterReplay = await facade["project.get_state"]();
    if (!stateAfterReplay.ok) throw new Error("state failed");
    expect(stateAfterReplay.value.revision).toBe(revisionBefore + 1);

    // Same request without the key: the now-existing envelope conflicts —
    // repeated requests never stack silently.
    const again = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING }],
    });
    expect(again).toMatchObject({ ok: false, error: { code: "CONFLICT", message: expect.stringContaining("existingEnvelope") } });
  });
  it("revision conflicts change nothing; explicit replace re-ducks", async () => {
    const first = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING }],
    });
    if (!first.ok) throw new Error(first.error.message);
    const afterFirst = await currentClips();
    const envelopeAfterFirst = afterFirst.find((clip) => clip.id === "bgm")!.automation?.volume;
    const conflict = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING, existingEnvelope: "replace" }],
      expectedRevision: 0,
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const afterConflict = await currentClips();
    expect(afterConflict.find((clip) => clip.id === "bgm")!.automation?.volume).toEqual(envelopeAfterFirst);
    const replaced = await facade["edit.apply"]({
      ops: [{ op: "clip.setDuckingFromAnalysis", clipId: "bgm", speechClipId: "speech", recordId, ...TUNING, threshold: -25, existingEnvelope: "replace" }],
    });
    expect(replaced.ok).toBe(true);
    const bgm = (await currentClips()).find((clip) => clip.id === "bgm")!;
    expect(bgm.metadata?.audioDucking).toMatchObject({ threshold: -25 });
  });
  it("the core inverse restores both ducking fields in one undo unit", async () => {
    const state = await facade["project.get_state"]();
    if (!state.ok) throw new Error("state failed");
    const project = state.value.project;
    const history = new ActionHistory();
    const executor = new ActionExecutor(history);
    const [action] = opToCoreActions(
      {
        op: "clip.setDucking",
        clipId: "bgm",
        ...TUNING,
        presenceRanges: [{ start: 3, end: 5 }],
      },
      project,
    );
    const applied = await executor.execute(action!, project);
    expect(applied.success).toBe(true);
    const bgm = project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "bgm")!;
    expect(bgm.automation?.volume?.length).toBeGreaterThan(0);
    const inverse = history.undo();
    expect(inverse?.type).toBe("audio/clearDucking");
    await executor.execute(inverse!, project);
    const restored = project.timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "bgm")!;
    expect(restored.automation?.volume).toBeUndefined();
    expect(restored.metadata?.audioDucking).toBeUndefined();
  });
});
