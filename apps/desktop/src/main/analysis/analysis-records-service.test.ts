import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobRegistry, jobStatusView } from "@reelterminal/agent-facade";
import { saveAnalysisRecord, type AnalysisRecord } from "@reelterminal/agent-facade/analysis-records";
import { createAnalysisRecordsService } from "./analysis-records-service";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function fixture(
  cloudUpload = false,
  silenceParams?: AnalysisRecord["config"]["silenceParams"],
  overrides: {
    observations?: readonly Record<string, unknown>[];
    sourceRevision?: number;
    vadParams?: AnalysisRecord["config"]["vadParams"];
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-analysis-ui-"));
  dirs.push(root);
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "media");
  const sourceStat = await stat(sourcePath);
  const vadParams = overrides.vadParams;
  const localTypes = vadParams ? ["speechActivity"] : silenceParams ? ["silence"] : ["technicalQuality", "audioSummary"];
  const record = await saveAnalysisRecord(root, {
    projectId: "project-a",
    sourceRevision: overrides.sourceRevision ?? 1,
    coordinateSpace: "source",
    subject: {
      mediaId: "media-a",
      name: "Source A",
      sourcePath,
      sourceFingerprint: {
        size: sourceStat.size,
        lastModified: Math.round(sourceStat.mtimeMs),
      },
    },
    analysisTypes: cloudUpload
      ? ["technicalQuality", "videoReview"]
      : localTypes,
    rangeSec: { startSec: 1, endSec: 3 },
    config: {
      analysisTypes: cloudUpload
        ? ["technicalQuality", "videoReview"]
        : localTypes,
      startSec: 1,
      endSec: 3,
      cloudUpload,
      ...(silenceParams ? { silenceParams } : {}),
      ...(vadParams ? { vadParams } : {}),
      ...(cloudUpload ? { reviewQuestion: "Check sync" } : {}),
    },
    provenance: [],
    observations: overrides.observations ?? [],
    inferences: [],
    recommendations: [],
    unknowns: [],
    recheckOf: null,
    cloudOpinion: null,
  });
  return { root, record };
}

describe("analysis records desktop service", () => {
  it("lists and loads only records belonging to the open project", async () => {
    const { root, record } = await fixture();
    const host = { isEnabled: false, callExternal: vi.fn() };
    const service = createAnalysisRecordsService(root, host);

    expect(await service.list({ projectId: "project-a" })).toMatchObject({
      records: [
        { id: record.id, projectId: "project-a", stale: { kind: "current" } },
      ],
      legacyUnscopedCount: 0,
    });
    expect(await service.list({ projectId: "project-b" })).toMatchObject({ records: [] });
    await expect(
      service.get({ projectId: "project-b", recordId: record.id }),
    ).rejects.toThrow("does not belong to the open project");
  });

  it("rechecks local records without any cloud upload field", async () => {
    const { root, record } = await fixture();
    const callExternal = vi.fn(async () => ({
      ok: true as const,
      value: {
        jobId: "job-12345678",
        kind: "analysis" as const,
        state: "queued" as const,
        sourceRevision: 2,
        analysisTypes: record.analysisTypes,
        replayed: false,
      },
    }));
    const service = createAnalysisRecordsService(root, {
      isEnabled: true,
      callExternal,
    });

    await service.recheck({ projectId: "project-a", recordId: record.id });

    const call = callExternal.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const params = call[1];
    expect(call[0]).toBe("media.analyze_start");
    expect(params).toMatchObject({
      mediaId: "media-a",
      analysisTypes: ["technicalQuality", "audioSummary"],
      startSec: 1,
      endSec: 3,
      recheckOfRecordId: record.id,
    });
    expect(params).not.toHaveProperty("cloudUpload");
    expect(params).not.toHaveProperty("reviewQuestion");
    expect(params).not.toHaveProperty("silenceParams");
  });

  it("rechecks silence with the effective tuning saved in its record", async () => {
    const silenceParams = { thresholdDb: -32, minDurationSec: 0.3, paddingSec: 0.05 };
    const { root, record } = await fixture(false, silenceParams);
    const host = { isEnabled: true, callExternal: vi.fn().mockResolvedValue({ ok: true }) };
    const service = createAnalysisRecordsService(root, host);

    await service.recheck({ projectId: "project-a", recordId: record.id });

    expect(host.callExternal).toHaveBeenCalledWith("media.analyze_start", expect.objectContaining({
      mediaId: record.subject.mediaId,
      analysisTypes: ["silence"],
      startSec: 1,
      endSec: 3,
      silenceParams,
      recheckOfRecordId: record.id,
    }));
  });

  it("rechecks speech activity with the input tuning only, not the derived exit threshold", async () => {
    const stored = {
      threshold: 0.45,
      exitThreshold: 0.3,
      minSpeechSec: 0.3,
      minSilenceSec: 0.2,
      padSec: 0.05,
    };
    const { root, record } = await fixture(false, undefined, { vadParams: stored });
    const host = { isEnabled: true, callExternal: vi.fn().mockResolvedValue({ ok: true }) };
    const service = createAnalysisRecordsService(root, host);

    await service.recheck({ projectId: "project-a", recordId: record.id });

    const call = host.callExternal.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1]).toMatchObject({
      mediaId: record.subject.mediaId,
      analysisTypes: ["speechActivity"],
      startSec: 1,
      endSec: 3,
      vadParams: {
        threshold: 0.45,
        minSpeechSec: 0.3,
        minSilenceSec: 0.2,
        padSec: 0.05,
      },
      recheckOfRecordId: record.id,
    });
    expect(call[1].vadParams).not.toHaveProperty("exitThreshold");
  });

  it("loads complete GUI audio records while job status stays compact", async () => {
    const silenceParams = { thresholdDb: -32, minDurationSec: 0.3, paddingSec: 0.05 };
    const silentRegions = Array.from({ length: 300 }, (_, index) => ({
      id: `silence-${index}`,
      startSec: index * 0.25,
      endSec: index * 0.25 + 0.1,
      durationSec: 0.1,
    }));
    const silenceFacts = {
      silentRegions,
      regionCount: silentRegions.length,
      totalSilenceDurationSec: 30,
      truncated: false,
    };
    const { root, record } = await fixture(false, silenceParams, {
      sourceRevision: 27,
      observations: [{ source: "silence", facts: silenceFacts }],
    });

    const registry = new JobRegistry();
    registry.create("audio-job-compact", 27, "analysis");
    registry.markAnalysisDone("audio-job-compact", {
      analysisTypes: ["silence"],
      summary: { silence: { ...silenceFacts, mediaId: "media-a" } },
      artifacts: [],
    });
    const jobView = jobStatusView(registry.get("audio-job-compact")!);
    const callExternal = vi.fn(async () => ({ ok: true as const, value: jobView }));
    const service = createAnalysisRecordsService(root, { isEnabled: true, callExternal });

    const guiRecord = await service.get({ projectId: "project-a", recordId: record.id });
    expect(guiRecord).toMatchObject({
      sourceRevision: 27,
      coordinateSpace: "source",
      audioDetailsComplete: true,
      config: { silenceParams },
    });
    expect((guiRecord.observations[0]!.facts as typeof silenceFacts).silentRegions).toHaveLength(300);
    expect((guiRecord.observations[0]!.facts as typeof silenceFacts).silentRegions[299]).toEqual(silentRegions[299]);

    const status = await service.jobStatus("audio-job-compact");
    expect(status).toMatchObject({ ok: true, value: { state: "done" } });
    if (!status.ok) throw new Error(status.error.message);
    const result = status.value.result;
    if (!result || !("summary" in result)) throw new Error("analysis job returned no analysis result");
    expect((result.summary.silence as Record<string, unknown>)).not.toHaveProperty("silentRegions");
    expect(callExternal).toHaveBeenCalledWith("job.status", { jobId: "audio-job-compact" });
  });

  it("requires fresh per-run authorization before repeating cloud review", async () => {
    const { root, record } = await fixture(true);
    const callExternal = vi.fn(async () => ({
      ok: true as const,
      value: {
        jobId: "job-12345678",
        kind: "analysis" as const,
        state: "queued" as const,
        sourceRevision: 2,
        analysisTypes: record.analysisTypes,
        replayed: false,
      },
    }));
    const service = createAnalysisRecordsService(root, {
      isEnabled: true,
      callExternal,
    });

    const denied = await service.recheck({
      projectId: "project-a",
      recordId: record.id,
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED" },
    });
    expect(callExternal).not.toHaveBeenCalled();

    await service.recheck({
      projectId: "project-a",
      recordId: record.id,
      allowCloudUpload: true,
    });
    expect(callExternal).toHaveBeenCalledTimes(1);
    const call = callExternal.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[1]).toMatchObject({
      cloudUpload: true,
      reviewQuestion: "Check sync",
      recheckOfRecordId: record.id,
    });
  });
});
