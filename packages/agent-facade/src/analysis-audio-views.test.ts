import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAnalysisRecordView, loadAnalysisRecord, saveAnalysisRecord } from "./analysis-records";
import { createAgentFacade } from "./index";

describe("durable audio details and compact Agent views", () => {
  let root: string;
  let recordId: string;
  let recordPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "analysis-audio-views-"));
    const sourcePath = join(root, "source.wav");
    await writeFile(sourcePath, "fixture");
    const regions = Array.from({ length: 301 }, (_, index) => ({ startSec: index * .3, endSec: index * .3 + .2, durationSec: .2 }));
    const saved = await saveAnalysisRecord(root, {
      projectId: "project", sourceRevision: 7, coordinateSpace: "source",
      subject: { mediaId: "media", name: "source.wav", sourcePath, sourceFingerprint: { size: 7, lastModified: 0 } },
      analysisTypes: ["audioSummary", "silence", "beatGrid"], rangeSec: { startSec: 0, endSec: 120 },
      config: { analysisTypes: ["audioSummary", "silence", "beatGrid"], startSec: 0, endSec: 120, cloudUpload: false },
      provenance: [], observations: [
        { source: "silence", facts: { silentRegions: regions, regionCount: regions.length, totalSilenceDurationSec: 60.2, truncated: false } },
        { source: "audioSummary", facts: { startSec: 0, durationSec: 120, onsets: [2, 1, 1, 3], onsetCount: 4,
          silence: regions, silenceCount: regions.length, truncated: false,
          waveform: [{ binDurationSec: .2, bins: Array.from({ length: 600 }, (_, index) => ({ rms: index % 2 ? .4 : .2, peak: .8 })) }] } },
        { source: "beatGrid", facts: { beats: [{ timeSec: 3, index: 0, strength: .5 }, { timeSec: 1, index: 1, strength: .7 }, { timeSec: 1, index: 2, strength: .8 }], beatCount: 3, truncated: false } },
      ], inferences: [], recommendations: [], unknowns: [], recheckOf: null, cloudOpinion: null,
    });
    recordId = saved.id;
    recordPath = saved.recordPath;
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("persists every event and pages more than 256 without changing summary totals", async () => {
    const facade = createAgentFacade({ artifactRoot: root });
    const result = await facade["analysis.get"]({ recordId });
    expect(result.ok).toBe(true);
    const summary = await getAnalysisRecordView(root, { recordId });
    expect(summary.view).toBe("summary");
    expect(summary.observations[0]!.facts).toEqual({ regionCount: 301, totalSilenceDurationSec: 60.2, truncated: false });
    expect(JSON.stringify(summary)).not.toMatch(/"(waveform|silentRegions|onsets|beats)":/);
    const full = await loadAnalysisRecord(root, recordId);
    expect((full.observations[0]!.facts as { silentRegions: unknown[] }).silentRegions).toHaveLength(301);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getAnalysisRecordView(root, { recordId, view: "events", series: "silence.silentRegions", limit: 128, ...(cursor ? { cursor } : {}) });
      expect(page.observations).toEqual(summary.observations);
      expect(page.events).toMatchObject({ totalMatched: 301, storedMatched: 301, complete: true });
      ids.push(...page.events!.items.map((event) => event.id));
      cursor = page.events!.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(301);
    expect(new Set(ids).size).toBe(301);
    expect(summary.details).toContainEqual({ series: "silence.silentRegions", totalCount: 301, storedCount: 301, complete: true });
  });

  it("uses half-open windows, original interval boundaries and stable ordering at equal times", async () => {
    const raw = JSON.parse(await readFile(recordPath, "utf8"));
    raw.observations[0].facts.silentRegions = [
      { startSec: 0, endSec: 1 }, { startSec: .5, endSec: 2.5 }, { startSec: 2, endSec: 3 },
    ];
    raw.observations[0].facts.regionCount = 3;
    await writeFile(recordPath, JSON.stringify(raw));
    const intervals = await getAnalysisRecordView(root, { recordId, view: "events", series: "silence.silentRegions", startSec: 1, endSec: 2 });
    expect(intervals.events!.items).toEqual([{ id: `${recordId}/silence.silentRegions/1`, startSec: .5, endSec: 2.5 }]);
    const adjacent = await getAnalysisRecordView(root, { recordId, view: "events", series: "silence.silentRegions", startSec: 2, endSec: 3 });
    expect(adjacent.events!.items[0]!.id).toBe(intervals.events!.items[0]!.id);
    const points = await getAnalysisRecordView(root, { recordId, view: "events", series: "audioSummary.onsets", startSec: 1, endSec: 2, limit: 1 });
    expect(points.events!.items).toEqual([{ id: `${recordId}/audioSummary.onsets/1`, timeSec: 1 }]);
    const next = await getAnalysisRecordView(root, { recordId, view: "events", series: "audioSummary.onsets", startSec: 1, endSec: 2, limit: 1, cursor: points.events!.nextCursor! });
    expect(next.events!.items).toEqual([{ id: `${recordId}/audioSummary.onsets/2`, timeSec: 1 }]);
    expect(next.events!.nextCursor).toBeNull();
    const beats = await getAnalysisRecordView(root, { recordId, view: "events", series: "beatGrid.beats", startSec: 1, endSec: 3 });
    expect(beats.events!.items.map((beat) => beat.index)).toEqual([1, 2]);
  });

  it("rejects cursor reuse with changed query conditions and invalid windows", async () => {
    const query = { recordId, view: "events" as const, series: "silence.silentRegions" as const, limit: 10 };
    const first = await getAnalysisRecordView(root, query);
    const cursor = first.events!.nextCursor!;
    for (const change of [{ limit: 11 }, { startSec: 1 }, { endSec: 100 }, { series: "audioSummary.silence" as const }]) {
      await expect(getAnalysisRecordView(root, { ...query, ...change, cursor })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    decoded[5] = -1;
    await expect(getAnalysisRecordView(root, { ...query, cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url") })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(getAnalysisRecordView(root, { ...query, cursor: "broken" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    for (const window of [{ startSec: 4, endSec: 4 }, { startSec: 4, endSec: 3 }, { endSec: 121 }]) {
      await expect(getAnalysisRecordView(root, { ...query, ...window })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
  });

  it("returns waveform only on request, with bounded weighted RMS and source coordinates", async () => {
    const defaults = await getAnalysisRecordView(root, { recordId, view: "waveform" });
    expect(defaults.waveform!.points).toHaveLength(150);
    const wave = await getAnalysisRecordView(root, { recordId, view: "waveform", startSec: .1, endSec: .7, maxPoints: 2 });
    expect(wave.waveform).toMatchObject({ maxPoints: 2, window: { startSec: .1, endSec: .7 }, complete: true });
    expect(wave.waveform!.points).toHaveLength(2);
    expect(wave.waveform!.points[0]).toMatchObject({ startSec: 0, endSec: .4, peak: .8 });
    expect(wave.waveform!.points[0]!.rms).toBeCloseTo(Math.sqrt(.1));
    const maximum = await getAnalysisRecordView(root, { recordId, view: "waveform", maxPoints: 600 });
    expect(maximum.waveform!.points).toHaveLength(600);
    await expect(getAnalysisRecordView(root, { recordId, view: "waveform", maxPoints: 601 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it.each([1, 2])("reads schema %i previews honestly without reconstructing discarded events", async (schemaVersion) => {
    const raw = JSON.parse(await readFile(recordPath, "utf8"));
    raw.schemaVersion = schemaVersion;
    delete raw.audioDetailsComplete;
    if (schemaVersion === 1) { delete raw.sourceRevision; delete raw.coordinateSpace; }
    raw.observations[0].facts.silentRegions = raw.observations[0].facts.silentRegions.slice(0, 256);
    raw.observations[0].facts.truncated = true;
    await writeFile(recordPath, JSON.stringify(raw));
    const page = await getAnalysisRecordView(root, { recordId, view: "events", series: "silence.silentRegions", limit: 256 });
    expect(page.schemaVersion).toBe(3);
    expect(page.audioDetailsComplete).toBeUndefined();
    expect(page.details).toContainEqual({ series: "silence.silentRegions", totalCount: 301, storedCount: 256, complete: false });
    expect(page.events).toMatchObject({ totalMatched: null, storedMatched: 256, complete: false, nextCursor: null });
    expect(page.events!.items).toHaveLength(256);
    expect(page.observations[0]!.facts).toMatchObject({ regionCount: 301, totalSilenceDurationSec: 60.2 });
    expect(page.sourceRevision).toBe(schemaVersion === 1 ? null : 7);
  });
});
