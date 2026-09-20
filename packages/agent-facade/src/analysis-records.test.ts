/**
 * Traceable analysis records (P2 acceptance) — with LOCAL analysis only
 * (no paid cloud service, no real user videos; the cloud-opinion path is
 * covered by video-review.test.ts's network mocks).
 *
 * Covered:
 *  - records persist beyond the job and are queryable (analysis.list/get),
 *  - provenance is per-source (local measurement here), observations vs
 *    inferences vs recommendations stay separated, unknowns are explicit,
 *  - staleness flips when the source file changes (version supersession),
 *  - the recheck flow links records (recheckOf) with the same config,
 *  - a model opinion never becomes a quality pass (status vocabulary),
 *  - analysis.list/get are read-only (no revision bump, no project edits).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentFacadeSession, createAgentFacade, type AgentFacade } from "./index";
import { writeTinyMp4 } from "./media/fixtures/tiny-mp4";
import { createEmptyProject } from "./project-factory";
import type { Project } from "@reelterminal/core/types/project";

async function waitForAnalysis(facade: AgentFacade, jobId: string): Promise<{
  state: string;
  result?: { summary?: Record<string, unknown> };
  error?: { message: string };
}> {
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("status failed");
    const { state } = status.value;
    if (state === "done" || state === "error" || state === "cancelled") {
      return status.value as unknown as { state: string; result?: { summary?: Record<string, unknown> }; error?: { message: string } };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
}

describe("analysis records (P2)", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let facade: AgentFacade;
  let mediaPath: string;
  let mediaId: string;

  beforeEach(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "records-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "records-art-"));
    facade = createAgentFacade({ mediaRoots: [mediaRoot], artifactRoot });
    await facade["project.create"]({ name: "Records" });
    mediaPath = writeTinyMp4(mediaRoot);
    const imported = await facade["media.import"]({ path: mediaPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    mediaId = imported.value.mediaId;
  });

  afterEach(async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  async function runTechnicalQuality(recheckOfRecordId?: string) {
    const started = await facade["media.analyze_start"]({
      mediaId,
      analysisTypes: ["technicalQuality"],
      ...(recheckOfRecordId ? { recheckOfRecordId } : {}),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    return waitForAnalysis(facade, started.value.jobId);
  }

  it("persists a traceable record and exposes it through the query verbs", { timeout: 120_000 }, async () => {
    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const revisionBefore = before.value.revision;
    const job = await runTechnicalQuality();
    expect(job.state).toBe("done");
    const recordRef = (job.result?.summary?.analysisRecord ?? {}) as { id?: string; recordPath?: string };
    expect(recordRef.id).toBeTruthy();
    const recordStat = await stat(recordRef.recordPath!);
    expect(recordStat.isFile()).toBe(true);

    const got = await facade["analysis.get"]({ recordId: recordRef.id! });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const record = got.value as {
      projectId: string;
      subject: { mediaId: string; sourceFingerprint: { size: number } };
      provenance: Array<{ kind: string; provider: string }>;
      observations: unknown[];
      inferences: unknown[];
      recommendations: unknown[];
      unknowns: unknown[];
      stale: { kind: string };
      config: { analysisTypes: string[] };
    };
    expect(record.projectId).toBe(before.value.project.id);
    expect(record.subject.mediaId).toBe(mediaId);
    expect(record.provenance).toEqual([
      { kind: "local-measurement", provider: "built-in-mediabunny-stat+ffprobe-color", analysisType: "technicalQuality" },
    ]);
    // Separation of concerns: facts are observations; nothing masquerades as
    // a verdict; unknowns stay explicit.
    expect(record.observations).toHaveLength(1);
    expect(record.inferences).toHaveLength(0);
    expect(record.recommendations).toHaveLength(0);
    expect(record.stale.kind).toBe("current");
    expect(record.config.analysisTypes).toEqual(["technicalQuality"]);

    const list = await facade["analysis.list"]({ mediaId });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]!.id).toBe(recordRef.id);
    }

    // Read-only: no revision bump, no project mutation.
    const after = await facade["project.get_state"]();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.revision).toBe(revisionBefore);

    const malformed = await facade["analysis.get"]({ recordId: "not-a-record-id" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_PARAMS");
    const missing = await facade["analysis.get"]({ recordId: "analysis-123e4567-e89b-12d3-a456-426614174000" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("pins the starting project identity before the asynchronous analysis completes", { timeout: 120_000 }, async () => {
    const session = new AgentFacadeSession({ mediaRoots: [mediaRoot], artifactRoot });
    const created = await session.projectCreate({ name: "Starting project" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const startingProjectId = created.value.project.id;
    const imported = await session.mediaImport({ path: mediaPath });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const started = await session.mediaAnalyzeStart({
      mediaId: imported.value.mediaId,
      analysisTypes: ["technicalQuality"],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Public headless sessions intentionally own one project. This controlled
    // internal swap models a future lifecycle host replacing the project
    // while the background job is between start and persistence.
    (session as unknown as { project: Project }).project = createEmptyProject("Later project");

    let status = await session.jobStatus({ jobId: started.value.jobId });
    for (let attempt = 0; attempt < 300 && status.ok && !["done", "error", "cancelled"].includes(status.value.state); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      status = await session.jobStatus({ jobId: started.value.jobId });
    }
    expect(status).toMatchObject({ ok: true, value: { state: "done" } });
    if (!status.ok || status.value.state !== "done") return;
    const recordId = (status.value.result?.summary.analysisRecord as { id?: string } | undefined)?.id;
    expect(recordId).toBeTruthy();
    const record = await session.analysisGet({ recordId: recordId! });
    expect(record).toMatchObject({ ok: true, value: { projectId: startingProjectId } });
  });

  it("marks records stale when the source changes (version supersession)", { timeout: 120_000 }, async () => {
    const job = await runTechnicalQuality();
    expect(job.state).toBe("done");
    const recordRef = (job.result?.summary?.analysisRecord ?? {}) as { id?: string };

    // "Regenerate" the source: append bytes + bump mtime.
    await appendFile(mediaPath, Buffer.from([0, 0, 0, 1]));
    const now = new Date();
    await utimes(mediaPath, now, now);

    const got = await facade["analysis.get"]({ recordId: recordRef.id! });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const record = got.value as { stale: { kind: string } };
    expect(record.stale.kind).toBe("source-changed");
  });

  it("links same-config rechecks to their predecessors", { timeout: 180_000 }, async () => {
    const first = await runTechnicalQuality();
    expect(first.state).toBe("done");
    const firstRef = (first.result?.summary?.analysisRecord ?? {}) as { id?: string; config?: unknown };

    // Modify (the fixed material) then re-check with the SAME config,
    // explicitly linking to the first record.
    await appendFile(mediaPath, Buffer.from([0, 0, 0, 2]));
    const second = await runTechnicalQuality(firstRef.id);
    expect(second.state).toBe("done");
    const secondRef = (second.result?.summary?.analysisRecord ?? {}) as { id?: string };

    const got = await facade["analysis.get"]({ recordId: secondRef.id! });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const record = got.value as {
      recheckOf: string | null;
      config: { analysisTypes: string[]; startSec: number; endSec: number };
    };
    expect(record.recheckOf).toBe(firstRef.id);
    // "Same config" is pinned verbatim in the record.
    expect(record.config).toMatchObject({ analysisTypes: ["technicalQuality"] });

    // Before/after evidence in one listing: newest first, linked.
    const list = await facade["analysis.list"]({ mediaId });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(2);
      expect(list.value[0]!.recheckOf).toBe(firstRef.id);
      expect(list.value[1]!.recheckOf).toBeNull();
    }
  });

  it("never turns an opinion into a quality pass (status vocabulary is data)", async () => {
    // Direct store-level check with a synthetic record: the record schema
    // has no "pass" concept at all, and cloud opinions carry explicit
    // unknowns when present.
    const { saveAnalysisRecord, listAnalysisRecords } = await import("./analysis-records");
    const fileStat = await stat(mediaPath);
    const saved = await saveAnalysisRecord(artifactRoot, {
      projectId: "p1",
      subject: {
        mediaId,
        name: "tiny.mp4",
        sourcePath: mediaPath,
        sourceFingerprint: { size: fileStat.size, lastModified: Math.round(fileStat.mtimeMs) },
      },
      analysisTypes: ["videoReview"],
      rangeSec: { startSec: 0, endSec: 6 },
      config: { analysisTypes: ["videoReview"], startSec: 0, endSec: 6, cloudUpload: true },
      provenance: [{ kind: "cloud-opinion", provider: "mock-provider", analysisType: "videoReview" }],
      observations: [],
      inferences: [],
      recommendations: [{ note: "model prose is a recommendation candidate, not a verdict" }],
      unknowns: [{ field: "videoReview.serverSamplingFps", note: "provider does not disclose sampling" }],
      recheckOf: null,
      cloudOpinion: {
        provider: "mock-provider",
        text: "看起来不错", // model text is stored as DATA — never executed
        status: "opinion",
        serverSamplingFps: null,
      },
    });
    expect(saved.cloudOpinion?.status).toBe("opinion");
    expect(saved.cloudOpinion?.serverSamplingFps).toBeNull(); // unknown, not fabricated
    const records = await listAnalysisRecords(artifactRoot, { mediaId });
    expect(records.some((record) => record.id === saved.id)).toBe(true);
  });
});
