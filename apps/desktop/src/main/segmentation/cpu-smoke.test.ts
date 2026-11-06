import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { PromptableSegmentationBackend } from "./backend";
import type { SegmentationPoint, SegmentationRequest } from "./types";

const modelDirectory = resolve(process.env.REEL_SEGMENTATION_MODEL_DIR ?? ".cache/mobilesam-validation-2026-11-07");
const fixtureDirectory = resolve(process.env.REEL_SEGMENTATION_FIXTURE_DIR ?? join(modelDirectory, "native-fixtures"));
const encoderPath = join(modelDirectory, "mobilesam-encoder-fp32.onnx");
const decoderPath = join(modelDirectory, "mobilesam-decoder-dynamic-fp32.onnx");

it.skipIf(!existsSync(encoderPath) || !existsSync(decoderPath) || !existsSync(join(fixtureDirectory, "manifest.json")))(
  "runs production RGBA preprocessing and eight-token prior refinement on both public images", async () => {
    await mkdir(".cache", { recursive: true });
    const directory = await mkdtemp(resolve(".cache/segmentation-native-smoke-"));
    const workerPath = join(directory, "worker.cjs");
    await build({ entryPoints: [resolve("src/main/segmentation/worker.ts")], outfile: workerPath,
      bundle: true, platform: "node", format: "cjs", target: "node18", external: ["onnxruntime-node"] });
    const backend = new PromptableSegmentationBackend({ workerPath, encoderPath, decoderPath });
    const fixtures: { id: string; width: number; height: number; rotation: 0 }[] = JSON.parse(
      await readFile(join(fixtureDirectory, "manifest.json"), "utf8"));
    const evidenceDirectory = resolve(".cache/mobilesam-native-smoke");
    await mkdir(evidenceDirectory, { recursive: true });
    const cases = [
      { id: "dogs", points: [[675,395,1],[525,400,0],[620,280,1],[550,550,0],[670,320,0],[630,500,1]], box: [570,220,790,600] },
      { id: "image2", points: [[2010,1290,1],[1665,1575,0],[2420,1500,1],[1600,1550,0],[1700,1180,1],[2100,1450,1]], box: [1530,1005,2610,1665] },
    ];
    const samples = [];
    try {
      for (const item of cases) {
        const fixture = fixtures.find(value => value.id === item.id)!;
        const rgba = await readFile(join(fixtureDirectory, `${item.id}.rgba`));
        const points: SegmentationPoint[] = item.points.map(([x,y,label]) => ({ x: x / fixture.width, y: y / fixture.height, foreground: label === 1 }));
        const request: SegmentationRequest = { frame: { ...fixture, revision: "public-original", rgba }, refinementId: `edit-${item.id}`, prompts: { points: points.slice(0,1) } };
        const baselineRssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const coldStart = performance.now();
        const initial = await backend.segment(request);
        const initialWallMs = Math.round(performance.now() - coldStart);
        expect(initial.embeddingReused).toBe(false);
        expect(initial.priorMaskUsed).toBe(false);
        expect(initial.candidateIndex).toBeGreaterThanOrEqual(1);
        await writeFile(join(evidenceDirectory, `${item.id}-initial.alpha`), initial.alpha);
        const initialRssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const [left,top,right,bottom] = item.box;
        request.prompts = { points, box: { left: left / fixture.width, top: top / fixture.height, right: right / fixture.width, bottom: bottom / fixture.height } };
        const warmStart = performance.now();
        const corrected = await backend.segment(request);
        const warmWallMs = Math.round(performance.now() - warmStart);
        expect(corrected).toMatchObject({ frameId: item.id, frameRevision: "public-original", refinementId: request.refinementId,
          width: fixture.width, height: fixture.height, embeddingReused: true, priorMaskUsed: true, candidateIndex: 0 });
        expect(corrected.alpha).toHaveLength(fixture.width * fixture.height);
        for (const [x,y,label] of item.points) expect(corrected.alpha[y * fixture.width + x], `${item.id} (${x},${y})`).toBe(label ? 255 : 0);
        await writeFile(join(evidenceDirectory, `${item.id}-corrected.alpha`), corrected.alpha);
        samples.push({ id: item.id, width: fixture.width, height: fixture.height, points: item.points, box: item.box,
          baselineRssMiB, initialRssMiB, correctedRssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          initialWallMs, warmWallMs, initial: { ...initial, alpha: undefined }, corrected: { ...corrected, alpha: undefined } });
      }
      await writeFile(join(evidenceDirectory, "report.json"), JSON.stringify({
        machine: `${platform()} ${arch()} ${cpus()[0].model.trim()}`, cpuThreads: 2,
        boundary: "segment wall time includes first lazy worker start, RGBA transfer, worker rotation/resize/normalize/pad, model loading, inference, threshold and response; excludes JPEG decoding/report rendering",
        memory: "whole Node RSS including worker/test runner; not peak or model-only memory", samples,
      }, null, 2));
    } finally {
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
