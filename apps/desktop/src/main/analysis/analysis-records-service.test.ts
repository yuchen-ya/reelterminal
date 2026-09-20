import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveAnalysisRecord } from "@reelterminal/agent-facade/analysis-records";
import { createAnalysisRecordsService } from "./analysis-records-service";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function fixture(cloudUpload = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-analysis-ui-"));
  dirs.push(root);
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "media");
  const sourceStat = await stat(sourcePath);
  const record = await saveAnalysisRecord(root, {
    projectId: "project-a",
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
      : ["technicalQuality", "audioSummary"],
    rangeSec: { startSec: 1, endSec: 3 },
    config: {
      analysisTypes: cloudUpload
        ? ["technicalQuality", "videoReview"]
        : ["technicalQuality", "audioSummary"],
      startSec: 1,
      endSec: 3,
      cloudUpload,
      ...(cloudUpload ? { reviewQuestion: "Check sync" } : {}),
    },
    provenance: [],
    observations: [],
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
