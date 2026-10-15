import { test, expect } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import type { Page, Browser } from "playwright-core";
import { ChromiumRuntime, PartFileWriter } from "./node/runtime";

// Manual attribution only: snapshots pause the producer, so these are never
// latency scores. Reuses retained synthetic media; never opens a desktop profile.
const enabled = process.env.REELTERMINAL_EXPORT_MEMORY_DIAGNOSTIC === "1";
(enabled ? test : test.skip)("attributes two real exports at resource lifecycle boundaries", async () => {
  const repo = resolve(import.meta.dirname, "../../..");
  const sourceRoot = resolve(process.env.REELTERMINAL_EXPORT_MEMORY_SOURCE!);
  const evidence = resolve(process.env.REELTERMINAL_EXPORT_MEMORY_EVIDENCE!);
  if (!sourceRoot.startsWith(join(repo, "apps/desktop/e2e/.artifacts/performance/real-media-"))) {
    throw new Error("diagnostic source must be a retained synthetic real-media fixture");
  }
  if (!evidence.startsWith(join(repo, "apps/desktop/e2e/.artifacts/"))) {
    throw new Error("diagnostic evidence must stay in existing harness artifacts");
  }
  await mkdir(evidence, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "reelterminal-e2e-export-attribution-"));
  const original = JSON.parse(await readFile(join(sourceRoot, "result.json"), "utf8"));
  expect(original.scale).toMatchObject({ width: 1920, height: 1080, duration_seconds: 12, independent_sources: 3 });
  const mediaFiles: Record<string, string> = {};
  for (const [i, media] of original.project.mediaLibrary.items.entries()) {
    const file = join(sourceRoot, `source-${i}.mp4`);
    expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(original.sources[i].sha256);
    mediaFiles[media.id] = file;
  }
  const entry = resolve(repo, "packages/runtime-chromium/src/browser/entry.ts");
  const shim = resolve(repo, "packages/runtime-chromium/src/browser/extract-audio-shim.ts");
  const instrumentation = `
import { WebCodecsBackend as DiagnosticBackend } from "@reelterminal/core/export/webcodecs-backend";
import { getMediaEngine as diagnosticMedia, ExportFrameDecoder as DiagnosticFrameDecoder } from "@reelterminal/core/media/mediabunny-engine";
const diagCounts: Record<string, number> = {};
const diagRefs: Array<{kind: string, ref: WeakRef<any>}> = [];
for (const kind of ["VideoEncoder", "VideoDecoder", "AudioEncoder", "AudioDecoder", "OffscreenCanvas"]) {
  const original = (globalThis as any)[kind];
  if (!original) continue;
  (globalThis as any)[kind] = new Proxy(original, {construct(target, args) {
    const value = Reflect.construct(target, args);
    diagCounts[kind + ".created"] = (diagCounts[kind + ".created"] ?? 0) + 1;
    diagRefs.push({kind, ref: new WeakRef(value)});
    if (typeof value.close === "function") {
      const close = value.close.bind(value);
      value.close = (...args: any[]) => { const r = close(...args); diagCounts[kind + ".close"] = (diagCounts[kind + ".close"] ?? 0) + 1; return r; };
    }
    return value;
  }});
}
const originalBitmap = globalThis.createImageBitmap.bind(globalThis);
globalThis.createImageBitmap = async (...args: any[]) => {
  const b = await (originalBitmap as any)(...args);
  diagCounts["ImageBitmap.created"] = (diagCounts["ImageBitmap.created"] ?? 0) + 1;
  return b;
};
const originalBitmapClose = ImageBitmap.prototype.close;
ImageBitmap.prototype.close = function() {
  diagCounts["ImageBitmap.close"] = (diagCounts["ImageBitmap.close"] ?? 0) + 1;
  return originalBitmapClose.call(this);
};
let diagRound = 0, diagFrames = 0;
const diagnosticResetSamples: unknown[] = [];
const diagnosticDecoderProto = DiagnosticFrameDecoder.prototype as any;
const originalResetIterator = diagnosticDecoderProto.resetCanvasIterator;
diagnosticDecoderProto.resetCanvasIterator = async function(timestamp: number) {
  const previous = this.currentFrame?.timestamp ?? null;
  const reason = previous === null ? "initial" : "backwards";
  diagCounts["exportDecoder.reset." + reason] = (diagCounts["exportDecoder.reset." + reason] ?? 0) + 1;
  if (diagnosticResetSamples.length < 16) diagnosticResetSamples.push({round: diagRound, file: this.file?.name, previous, requested: timestamp, reason});
  return originalResetIterator.call(this, timestamp);
};
async function diagnosticPoint(phase: string) {
  const live: Record<string, number> = {};
  for (const r of diagRefs) {
    const o = r.ref.deref(); if (!o) continue;
    const key = r.kind + "." + (o.state ?? "wrapperAlive"); live[key] = (live[key] ?? 0) + 1;
  }
  const video = getVideoEngine() as any, media = diagnosticMedia() as any;
  const resources = Object.fromEntries(["exportDecoders", "frameCache"].map(k => [k, media[k]?.size ?? null]));
  resources.exportDecoderStreams = [...media.exportDecoders.values()].reduce((n: number, d: any) => n + 1 + (d.streamDecoders?.size ?? 0), 0);
  for (const k of ["videoElementCache", "staticImageCache", "interpFrameCache", "gifFrameCache"]) resources[k] = video[k]?.size ?? null;
  await (window as any).__exportDiagnosticPoint({phase, round: diagRound, frames: diagFrames, counts: {...diagCounts}, weak_live: live, resources, reset_samples: diagnosticResetSamples});
}
(window as any).__exportDiagnosticSnapshot = diagnosticPoint;
const diagnosticApi = window.__openreelRender;
const originalHydrate = diagnosticApi.hydrate.bind(api);
diagnosticApi.hydrate = async (...args: any[]) => { const r = await (originalHydrate as any)(...args); await diagnosticPoint("after_hydrate"); return r; };
for (const name of ["start", "addAudioBuffer", "closeAudio", "finalize"]) {
  const proto = DiagnosticBackend.prototype as any, original = proto[name];
  proto[name] = async function(...args: any[]) {
    if (name === "start") { diagRound++; diagFrames = 0; }
    await diagnosticPoint("before_backend_" + name);
    const r = await original.apply(this, args);
    await diagnosticPoint("after_backend_" + name);
    return r;
  };
}
const ve = getVideoEngine() as any, render = ve.renderFrame.bind(ve);
ve.renderFrame = async (...args: any[]) => {
  const r = await render(...args); diagFrames++;
  if ([1, 90, 180, 270, 360].includes(diagFrames)) await diagnosticPoint("after_render_before_encode");
  return r;
};
const originalExport = diagnosticApi.exportToMp4Webcodecs.bind(api);
diagnosticApi.exportToMp4Webcodecs = async (...args: any[]) => {
  const r = await (originalExport as any)(...args);
  await diagnosticPoint("after_export_finally"); return r;
};
`;
  const bundle = await build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "browser",
    target: "es2022", write: false, minify: true, define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "diagnostic-boundaries", setup(b) {
      b.onResolve({ filter: /(^|\/)extract-audio$/ }, () => ({ path: shim }));
      b.onLoad({ filter: /\/browser\/entry\.ts$/ }, async args => ({
        contents: await readFile(args.path, "utf8") + instrumentation,
        loader: "ts", resolveDir: resolve(entry, ".."),
      }));
    } }],
  }).catch(async error => { await rm(temp, { recursive: true, force: true }); throw error; });
  const bundlePath = join(temp, "diagnostic-browser-entry.mjs");
  await writeFile(bundlePath, bundle.outputFiles[0].text);
  await writeFile(join(evidence, "instrumentation.json"), JSON.stringify({
    source_test_sha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"),
    browser_bundle_sha256: createHash("sha256").update(bundle.outputFiles[0].text).digest("hex"),
    source_fixture_sha256: original.sources.map((s: any) => s.sha256),
    awaited_stage_observation: true, weak_reference_wrapper_counters: true,
    modified_production_settings: false, forced_gc: false,
  }, null, 2));
  await writeFile(join(evidence, "diagnostic-browser-entry.mjs"), bundle.outputFiles[0].text);
  await writeFile(join(evidence, "diagnostic-test-source.ts"), await readFile(import.meta.filename));
  const sourceDigests = await Promise.all([
    "packages/core/src/export/export-engine.ts", "packages/core/src/media/mediabunny-engine.ts", "packages/core/src/video/video-engine.ts",
  ].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(repo, path))).digest("hex") })));
  await writeFile(join(evidence, "runtime-source-digests.json"), JSON.stringify(sourceDigests, null, 2));
  const oldBundle = process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE;
  process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE = bundlePath;
  const consoleLines: string[] = [];
  const runtime = new ChromiumRuntime({ onConsole: line => consoleLines.push(line) });
  const results: unknown[] = [];
  let checkpoint = 0;
  try {
    // Launch only our runtime. This lock callback exposes the recording binding
    // before the production probe/hydrate/export paths call the instrumented API.
    await (runtime as any).withPageLock(async (page: Page) => {
      const browser = (runtime as any).browser as Browser;
      const bcdp = await browser.newBrowserCDPSession();
      const cdp = await page.context().newCDPSession(page);
      await page.exposeFunction("__exportDiagnosticPoint", async (point: any) => {
        const seq = checkpoint++;
        const processes = (await bcdp.send("SystemInfo.getProcessInfo")).processInfo.map(p => ({ pid: p.id, type: p.type }));
        const pids = new Set(processes.map(p => p.pid));
        const heap = await cdp.send("Runtime.getHeapUsage");
        const dom = await cdp.send("Memory.getDOMCounters");
        const rss = execFileSync("ps", ["-axo", "pid,ppid,rss"], { encoding: "utf8" }).split("\n").filter(l => pids.has(Number(l.trim().split(/\s+/)[0])));
        const top = execFileSync("top", ["-l", "1", "-n", "80", "-o", "mem", "-stats", "pid,command,mem"], { encoding: "utf8" }).split("\n").filter(l => pids.has(Number(l.trim().split(/\s+/)[0])));
        await appendFile(join(evidence, "phase-memory.jsonl"), JSON.stringify({ seq, epoch_ms: Date.now(), ...point, processes, heap, dom, rss, top, forced_gc: false }) + "\n");
        if (["after_hydrate", "after_backend_addAudioBuffer", "before_backend_finalize", "after_backend_finalize", "after_export_finally", "idle_30s"].includes(point.phase)) {
          for (const p of processes.filter(p => p.type === "renderer")) {
            const mapped = spawnSync("vmmap", ["-summary", String(p.pid)], {
              encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
            });
            const text = String(mapped.stdout ?? "") + String(mapped.stderr ?? "")
              + "\nvmmap_status=" + mapped.status;
            await writeFile(join(evidence, `vmmap-${seq}-${p.pid}-${point.phase}.txt`), text);
          }
        }
        console.log(JSON.stringify({ checkpoint: seq, round: point.round, phase: point.phase, frames: point.frames }));
      });
      await page.evaluate(() => (window as any).__exportDiagnosticSnapshot("launched_before_probe"));
    });
    await runtime.probeOnPage(mediaFiles[original.project.mediaLibrary.items[0].id]);
    for (let round = 0; round < 2; round++) {
      const writer = await PartFileWriter.open(join(evidence, `output-${round}.mp4`));
      const outcome = await runtime.exportWebcodecsStreaming(original.project, mediaFiles, original.settings, writer, () => {});
      results.push(outcome);
      await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "running", source_run: sourceRoot.split("/").at(-1), completed: results, diagnostic_only: true, forced_gc: false }, null, 2));
      expect(outcome.success).toBe(true);
      expect(outcome.framesRendered).toBe(360);
      const output = join(evidence, `output-${round}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"], { timeout: 60_000 });
      const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], { encoding: "utf8" })).streams;
      expect(streams.find((s: any) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1920, height: 1080, nb_frames: "360" });
      expect(streams.find((s: any) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
      const markers: unknown[] = [];
      for (const time of [2, 8]) {
        for (const layer of ["background", "blue", "green"]) {
          const scale = layer === "background" ? 1 : .3;
          const w = layer === "background" ? 280 : 84, h = layer === "background" ? 24 : 8;
          const x = layer === "green" ? 1184 : layer === "blue" ? 184 : 40;
          const y = layer === "background" ? 960 : 416;
          const bytes = execFileSync("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
          let frame = 0;
          for (let bit = 0; bit < 10; bit++) {
            const offset = (Math.floor(12 * scale) * w + Math.floor((bit * 28 + 12) * scale)) * 3;
            if (bytes[offset] + bytes[offset + 1] + bytes[offset + 2] > 384) frame += 2 ** bit;
          }
          const expected = layer === "green" ? time * 45 : layer === "background" && time >= 6 ? (time - 6) * 30 : time * 30;
          markers.push({ time, layer, frame, expected });
          expect(Math.abs(frame - expected)).toBeLessThanOrEqual(1);
        }
      }
      await writeFile(join(evidence, `output-${round}-verification.json`), JSON.stringify({ streams, markers, full_decode_passed: true }, null, 2));
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 30_000));
    await (runtime as any).withPageLock((page: Page) => page.evaluate(() => (window as any).__exportDiagnosticSnapshot("idle_30s")));
    await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "complete", source_run: sourceRoot.split("/").at(-1), completed: results, diagnostic_only: true, forced_gc: false, real_business_methods_not_simulated: true, note: "awaited lifecycle snapshots and WeakRef counters perturb execution; attribution only, never a performance score" }, null, 2));
  } finally {
    await writeFile(join(evidence, "worker-console.log"), consoleLines.join("\n"));
    await runtime.close();
    if (oldBundle === undefined) delete process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE;
    else process.env.REELTERMINAL_BROWSER_ENTRY_BUNDLE = oldBundle;
    await rm(temp, { recursive: true, force: true });
  }
}, 600_000);
