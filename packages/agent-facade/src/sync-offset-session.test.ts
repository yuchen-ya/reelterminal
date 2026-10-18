import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade } from "./index";
import type { AnalysisAgentView } from "./analysis-records";

const RATE = 16000;

function noise(length: number, seed: number): Float32Array {
  let state = seed >>> 0;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[index] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

function monoWav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    data.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function delayed(signal: Float32Array, offsetSamples: number): Float32Array {
  const out = new Float32Array(signal.length);
  if (offsetSamples > 0) out.set(signal.subarray(0, signal.length - offsetSamples), offsetSamples);
  else out.set(signal.subarray(-offsetSamples), 0);
  return out;
}

async function waitForAnalysis(facade: ReturnType<typeof createAgentFacade>, jobId: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await facade["job.status"]({ jobId });
    if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("analysis job did not finish");
}

describe("syncOffset headless session integration", () => {
  it("measures a known +350 ms target delay, persists the record and keeps the summary compact", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-sync-session-"));
    try {
      const referencePath = join(root, "reference.wav");
      const targetPath = join(root, "target.wav");
      const reference = noise(6 * RATE, 11);
      await writeFile(referencePath, monoWav(reference));
      await writeFile(targetPath, monoWav(delayed(reference, Math.round(0.35 * RATE))));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "sync offset" });
      const referenceImport = await facade["media.import"]({ path: referencePath });
      const targetImport = await facade["media.import"]({ path: targetPath });
      if (!referenceImport.ok || !targetImport.ok) throw new Error("import failed");
      const started = await facade["media.analyze_start"]({
        mediaId: targetImport.value.mediaId,
        analysisTypes: ["syncOffset"],
        startSec: 0,
        endSec: 5,
        syncOffsetParams: { referenceMediaId: referenceImport.value.mediaId, searchRangeSec: 1, windowSec: 10 },
      });
      if (!started.ok) throw new Error(started.error.message);
      const status = await waitForAnalysis(facade, started.value.jobId);
      if (!status.ok || status.value.state !== "done") throw new Error(`job did not finish: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = result.summary as Record<string, any>;
      expect(summary.syncOffset).toMatchObject({
        coordinateSpace: "source",
        verdict: "ok",
        fixedOffsetSupported: true,
        reference: { mediaId: referenceImport.value.mediaId },
      });
      expect(Math.abs(summary.syncOffset.offsetMs - 350)).toBeLessThan(1);
      // Windows stay on the compact summary (bounded ≤12), so they are not omitted.
      expect(Array.isArray(summary.syncOffset.windows)).toBe(true);
      const recordId = summary.analysisRecord.id as string;
      const record = await facade["analysis.get"]({ recordId });
      if (!record.ok) throw new Error(record.error.message);
      const view = record.value as AnalysisAgentView;
      expect(view.config.syncOffsetParams).toMatchObject({ searchRangeSec: 1, windowSec: 10 });
      expect(view.provenance).toContainEqual(expect.objectContaining({ provider: "local-ffmpeg-pcm-gcc-phat", analysisType: "syncOffset" }));
      expect(view.inferences).toContainEqual(expect.objectContaining({ source: "syncOffset", driftDetected: false }));
      const stored = view.observations.find((observation) => observation.source === "syncOffset");
      expect(stored?.facts).toMatchObject({ verdict: "ok" });
      expect(Math.abs((stored?.facts as { offsetSec: number }).offsetSec - 0.35)).toBeLessThan(0.001);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it("refuses unrelated content and gates missing references before any mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-sync-gate-"));
    try {
      const referencePath = join(root, "reference.wav");
      const targetPath = join(root, "target.wav");
      await writeFile(referencePath, monoWav(noise(6 * RATE, 21)));
      await writeFile(targetPath, monoWav(noise(6 * RATE, 22)));
      const noRootFacade = createAgentFacade({ mediaRoots: [root] });
      await noRootFacade["project.create"]({ name: "sync gate" });
      const referenceImport = await noRootFacade["media.import"]({ path: referencePath });
      const targetImport = await noRootFacade["media.import"]({ path: targetPath });
      if (!referenceImport.ok || !targetImport.ok) throw new Error("import failed");
      expect(await noRootFacade["media.analyze_start"]({
        mediaId: targetImport.value.mediaId,
        analysisTypes: ["syncOffset"],
        syncOffsetParams: { referenceMediaId: referenceImport.value.mediaId },
      })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") } });

      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "sync gate" });
      const importedReference = await facade["media.import"]({ path: referencePath });
      const importedTarget = await facade["media.import"]({ path: targetPath });
      if (!importedReference.ok || !importedTarget.ok) throw new Error("import failed");
      expect(await facade["media.analyze_start"]({
        mediaId: importedTarget.value.mediaId,
        analysisTypes: ["silence"],
        syncOffsetParams: { referenceMediaId: importedReference.value.mediaId },
      })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("syncOffset") } });
      expect(await facade["media.analyze_start"]({
        mediaId: importedTarget.value.mediaId,
        analysisTypes: ["syncOffset"],
      })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("syncOffsetParams") } });
      expect(await facade["media.analyze_start"]({
        mediaId: importedTarget.value.mediaId,
        analysisTypes: ["syncOffset"],
        syncOffsetParams: { referenceMediaId: "missing-media" },
      })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(await facade["media.analyze_start"]({
        mediaId: importedTarget.value.mediaId,
        analysisTypes: ["syncOffset"],
        startSec: 0,
        endSec: 6,
        syncOffsetParams: { referenceMediaId: importedReference.value.mediaId, referenceStartSec: 1 },
      })).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("exceeds reference media duration") } });

      const started = await facade["media.analyze_start"]({
        mediaId: importedTarget.value.mediaId,
        analysisTypes: ["syncOffset"],
        startSec: 0,
        endSec: 5,
        syncOffsetParams: { referenceMediaId: importedReference.value.mediaId, searchRangeSec: 1, windowSec: 10 },
      });
      if (!started.ok) throw new Error(started.error.message);
      const status = await waitForAnalysis(facade, started.value.jobId);
      if (!status.ok || status.value.state !== "done") throw new Error(`job did not finish: ${JSON.stringify(status)}`);
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const sync = (result.summary as Record<string, any>).syncOffset;
      expect(sync.verdict).not.toBe("ok");
      expect(sync.fixedOffsetSupported).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
