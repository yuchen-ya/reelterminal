import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_SPEECH_VAD_PARAMS,
  SILERO_VAD_MODEL,
  SPEECH_VAD_CHUNK_SEC,
  analyzeSpeechActivity,
  downloadVadModelForTests,
  resolveSpeechVadParams,
  segmentsFromProbabilities,
  setSpeechVadModelFactoryForTests,
  speechVadModelPath,
  speechVadPreflight,
} from "./speech-vad";
import { createAgentFacade } from "./index";
import type { VadInferenceModel } from "./speech-vad";

afterEach(() => {
  setSpeechVadModelFactoryForTests(null);
  delete process.env.REELTERMINAL_VAD_MODEL;
});

/** Deterministic stand-in for the Silero session: loud chunk ⇒ speech. */
function amplitudeFakeModel(rmsThreshold = 0.02): () => Promise<VadInferenceModel> {
  return async () => ({
    async detect(chunk) {
      let sum = 0;
      for (const sample of chunk) sum += sample * sample;
      return Math.sqrt(sum / chunk.length) > rmsThreshold ? 0.9 : 0.05;
    },
  });
}

/** 16 kHz stereo f32 WAV with sine windows per channel spec. */
function vadWav(windows: Array<{ startSec: number; endSec: number; channel?: 0 | 1; invert?: boolean }>, durationSec: number) {
  const rate = 16000;
  const data = Buffer.alloc(rate * durationSec * 8);
  for (const window of windows) {
    for (let i = Math.round(window.startSec * rate); i < Math.round(window.endSec * rate); i++) {
      const sample = 0.5 * Math.sin(i * 0.07);
      const offset = i * 8;
      const value = window.invert ? -sample : sample;
      if (window.channel === undefined || window.channel === 0) data.writeFloatLE(value, offset);
      if (window.channel === undefined || window.channel === 1) data.writeFloatLE(value, offset + 4);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28); header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("speechActivity parameter validation", () => {
  it("defaults to the Silero-reference tuning", () => {
    expect(resolveSpeechVadParams(undefined)).toEqual({ ...DEFAULT_SPEECH_VAD_PARAMS });
    expect(resolveSpeechVadParams({})).toEqual({ ...DEFAULT_SPEECH_VAD_PARAMS });
  });
  it("rejects out-of-range and degenerate hysteresis tuning", () => {
    expect(() => resolveSpeechVadParams({ threshold: 0.99 })).toThrow("threshold");
    expect(() => resolveSpeechVadParams({ threshold: 0.05 })).toThrow("exit threshold");
    expect(() => resolveSpeechVadParams({ minSpeechSec: 6 })).toThrow("minSpeechSec");
    expect(() => resolveSpeechVadParams({ minSilenceSec: -1 })).toThrow("minSilenceSec");
    expect(() => resolveSpeechVadParams({ padSec: 2 })).toThrow("padSec");
  });
});

describe("speechActivity segmentation kernel", () => {
  const params = { ...DEFAULT_SPEECH_VAD_PARAMS };
  const range = { startSec: 100, endSec: 110 };
  const chunkOf = (timeSec: number) => Math.round(timeSec / SPEECH_VAD_CHUNK_SEC);
  it("opens above the enter threshold and closes only after the closing silence", () => {
    const chunkCount = Math.round(10 / SPEECH_VAD_CHUNK_SEC);
    const probs = new Array<number>(chunkCount).fill(0.05);
    // Speech 1.0–2.0s, then a 0.05s dip, more speech 2.05–3.0s: one region.
    for (let i = chunkOf(1); i < chunkOf(3); i++) probs[i] = 0.9;
    for (let i = 0; i < Math.round(0.05 / SPEECH_VAD_CHUNK_SEC); i++) probs[chunkOf(2) + i] = 0.1;
    const regions = segmentsFromProbabilities(probs, params, range);
    expect(regions).toHaveLength(1);
    // Boundaries land on the 32ms chunk grid, then pad and clamp.
    expect(regions[0]!.startSec).toBeCloseTo(100 + chunkOf(1) * SPEECH_VAD_CHUNK_SEC - params.padSec, 5);
    expect(regions[0]!.endSec).toBeCloseTo(100 + chunkOf(3) * SPEECH_VAD_CHUNK_SEC + params.padSec, 5);
  });
  it("splits two utterances separated by a real pause and drops short blips", () => {
    const probs = new Array<number>(Math.round(10 / SPEECH_VAD_CHUNK_SEC)).fill(0.05);
    const mark = (from: number, to: number) => { for (let i = chunkOf(from); i < chunkOf(to); i++) probs[i] = 0.9; };
    mark(1, 2); mark(4, 5); mark(7, 7.1); // last one is below minSpeechSec
    const regions = segmentsFromProbabilities(probs, params, range);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.startSec - 100).toBeCloseTo(chunkOf(1) * SPEECH_VAD_CHUNK_SEC - params.padSec, 5);
    expect(regions[0]!.endSec - 100).toBeCloseTo(chunkOf(2) * SPEECH_VAD_CHUNK_SEC + params.padSec, 5);
    expect(regions[1]!.startSec - 100).toBeCloseTo(chunkOf(4) * SPEECH_VAD_CHUNK_SEC - params.padSec, 5);
    expect(regions[1]!.endSec - 100).toBeCloseTo(chunkOf(5) * SPEECH_VAD_CHUNK_SEC + params.padSec, 5);
  });
  it("keeps speech that runs into the range end and clamps padding to the range", () => {
    const probs = new Array<number>(Math.round(10 / SPEECH_VAD_CHUNK_SEC)).fill(0.05);
    for (let i = 0; i < probs.length; i++) probs[i] = 0.9;
    const regions = segmentsFromProbabilities(probs, params, range);
    expect(regions).toEqual([{ startSec: 100, endSec: 110 }]);
  });
  it("reports nothing for consistently non-speech audio", () => {
    const probs = new Array<number>(300).fill(0.2); // above exit, below enter
    expect(segmentsFromProbabilities(probs, params, range)).toEqual([]);
  });
});

describe("speechActivity model management", () => {
  it("honors REELTERMINAL_VAD_MODEL for the expected path", () => {
    const previous = process.env.REELTERMINAL_VAD_MODEL;
    try {
      process.env.REELTERMINAL_VAD_MODEL = join("local", "silero_vad.onnx");
      expect(speechVadModelPath().endsWith(join("local", "silero_vad.onnx"))).toBe(true);
      process.env.REELTERMINAL_VAD_MODEL = "C:\\models\\silero_vad.onnx";
      expect(speechVadModelPath()).toContain("models");
    } finally {
      if (previous === undefined) delete process.env.REELTERMINAL_VAD_MODEL;
      else process.env.REELTERMINAL_VAD_MODEL = previous;
    }
  });
  it("reports the pinned model contract honestly when no model is present", async () => {
    process.env.REELTERMINAL_VAD_MODEL = join(tmpdir(), "definitely-missing-vad.onnx");
    const preflight = await speechVadPreflight();
    expect(preflight.available).toBe(false);
    if (!preflight.available) {
      expect(preflight.reason).toContain(SILERO_VAD_MODEL.url);
      expect(preflight.reason).toContain("REELTERMINAL_VAD_MODEL");
      expect(preflight.requires).toContain(SILERO_VAD_MODEL.sha256);
    }
  });
  it("verifies size and sha before an env-provided model is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-env-"));
    try {
      const wrongBytes = join(root, "wrong-size.onnx");
      await writeFile(wrongBytes, Buffer.alloc(64));
      process.env.REELTERMINAL_VAD_MODEL = wrongBytes;
      const preflight = await speechVadPreflight();
      expect(preflight.available).toBe(false);
      if (!preflight.available) expect(preflight.reason).toContain("expected 2327524");

      const wrongSha = join(root, "wrong-sha.onnx");
      await writeFile(wrongSha, Buffer.alloc(SILERO_VAD_MODEL.bytes));
      process.env.REELTERMINAL_VAD_MODEL = wrongSha;
      const shaPreflight = await speechVadPreflight();
      expect(shaPreflight.available).toBe(false);
      if (!shaPreflight.available) expect(shaPreflight.reason).toContain("does not match the pinned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("speechActivity model download mechanics", () => {
  const modelBytes = Buffer.alloc(SILERO_VAD_MODEL.bytes, 7);
  let server: Server | null = null;
  afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); });

  function serve(handler: (url: string, respond: (status: number, body: Buffer | string, headers?: Record<string, string>) => void) => void): Promise<string> {
    return new Promise((resolveListen) => {
      server = createServer((request, response) => {
        const respond = (status: number, body: Buffer | string, headers: Record<string, string> = {}) => {
          response.writeHead(status, headers); response.end(body);
        };
        handler(request.url ?? "", respond);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server!.address() as { port: number };
        resolveListen(`http://127.0.0.1:${address.port}/`);
      });
    });
  }

  it("follows a redirect and publishes the real pinned bytes atomically", async () => {
    const realModel = await locateRealModel();
    if (!realModel) {
      console.warn("[speech-vad] real Silero model not present — skipping redirect happy-path (sha pinning needs the actual bytes)");
      return;
    }
    const pinned = await readFile(realModel);
    const root = await mkdtemp(join(tmpdir(), "rt-vad-dl-"));
    try {
      const base = await serve((url, respond) => {
        if (url === "/redirect") respond(302, "", { location: "/model" });
        else respond(200, pinned);
      });
      const destination = join(root, "silero_vad.onnx");
      await downloadVadModelForTests(`${base}redirect`, destination, new AbortController().signal);
      expect((await stat(destination)).size).toBe(SILERO_VAD_MODEL.bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects wrong content and leaves no destination or staging file behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-dl-"));
    try {
      const base = await serve((_url, respond) => respond(200, Buffer.alloc(SILERO_VAD_MODEL.bytes, 9)));
      const destination = join(root, "silero_vad.onnx");
      await expect(downloadVadModelForTests(base, destination, new AbortController().signal)).rejects.toThrow("does not match the pinned");
      expect(await stat(destination).catch(() => null)).toBeNull();
      expect((await readdirSafe(root)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("fails on HTTP errors instead of publishing anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-dl-"));
    try {
      const base = await serve((_url, respond) => respond(404, "gone"));
      await expect(downloadVadModelForTests(base, join(root, "silero_vad.onnx"), new AbortController().signal)).rejects.toThrow("HTTP 404");
      expect((await readdirSafe(root)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("stops promptly when the analysis is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-dl-"));
    try {
      const base = await serve((_url, respond) => respond(200, modelBytes));
      const controller = new AbortController();
      controller.abort();
      await expect(downloadVadModelForTests(base, join(root, "silero_vad.onnx"), controller.signal)).rejects.toThrow();
      expect((await readdirSafe(root)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir).catch(() => []);
}

describe("speechActivity analysis kernel (fake model + real FFmpeg)", () => {
  it("maps left-only, right-only and anti-phase speech to source regions", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-kernel-"));
    try {
      const path = join(root, "speech.wav");
      await writeFile(path, vadWav([
        { startSec: 1, endSec: 2 },                          // both channels
        { startSec: 3, endSec: 4, channel: 1 },              // right only
        { startSec: 5, endSec: 6, channel: 0, invert: true }, // left only, negative
      ], 7));
      setSpeechVadModelFactoryForTests(amplitudeFakeModel());
      const result = await analyzeSpeechActivity(path, { startSec: 0, endSec: 7 }, undefined, new AbortController().signal);
      expect(result.coordinateSpace).toBe("source");
      expect(result.analysisSampleRate).toBe(16000);
      expect(result.parameters).toEqual({ threshold: 0.5, exitThreshold: 0.35, minSpeechSec: 0.25, minSilenceSec: 0.1, padSec: 0.03 });
      expect(result.model.name).toBe("silero-vad");
      expect(result.model.path).toBeNull(); // fake factory: no local file claim
      expect(result.regionCount).toBe(3);
      const tolerance = SPEECH_VAD_CHUNK_SEC * 2 + 0.05;
      for (const [index, expected] of [[0, [1, 2]], [1, [3, 4]], [2, [5, 6]]] as const) {
        expect(result.speechRegions[index]!.startSec).toBeGreaterThan(expected[0] - tolerance);
        expect(result.speechRegions[index]!.startSec).toBeLessThan(expected[0] + tolerance);
        expect(result.speechRegions[index]!.endSec).toBeGreaterThan(expected[1] - tolerance);
        expect(result.speechRegions[index]!.endSec).toBeLessThan(expected[1] + tolerance);
      }
      expect(result.totalSpeechDurationSec).toBeGreaterThan(2.5);
      expect(result.granularitySec).toBe(SPEECH_VAD_CHUNK_SEC);
      expect(result.limitations.join(" ")).toContain("not automatically deletable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
  it("analyzes a sub-range in source coordinates and records effective tuning", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-kernel-"));
    try {
      const path = join(root, "speech.wav");
      await writeFile(path, vadWav([{ startSec: 0.5, endSec: 1.5 }, { startSec: 3, endSec: 3.5 }], 5));
      setSpeechVadModelFactoryForTests(amplitudeFakeModel());
      const result = await analyzeSpeechActivity(path, { startSec: 2, endSec: 5 }, { threshold: 0.6, padSec: 0.1 }, new AbortController().signal);
      expect(result.regionCount).toBe(1);
      expect(result.speechRegions[0]!.startSec).toBeGreaterThanOrEqual(2);
      expect(result.parameters).toMatchObject({ threshold: 0.6, exitThreshold: 0.45, padSec: 0.1 });
      // Only the 3.0–3.5s window lies inside the analyzed [2, 5) range; the
      // 0.5s window clears the 0.25s minimum and survives as one region.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
  it("enforces the shared 120-second range bound and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-kernel-"));
    try {
      const path = join(root, "speech.wav");
      await writeFile(path, vadWav([{ startSec: 0, endSec: 1 }], 2));
      setSpeechVadModelFactoryForTests(amplitudeFakeModel());
      await expect(analyzeSpeechActivity(path, { startSec: 0, endSec: 121 }, undefined, new AbortController().signal)).rejects.toThrow("120");
      const controller = new AbortController();
      controller.abort();
      await expect(analyzeSpeechActivity(path, { startSec: 0, endSec: 2 }, undefined, controller.signal)).rejects.toThrow("Cancelled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe("speechActivity headless session integration", () => {
  it("runs the job, persists full regions, pages the series and keeps status compact", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-session-"));
    try {
      const path = join(root, "speech.wav");
      await writeFile(path, vadWav([{ startSec: 1, endSec: 2 }, { startSec: 3, endSec: 4 }], 5));
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "VAD session test" });
      const imported = await facade["media.import"]({ path });
      if (!imported.ok) throw new Error(imported.error.message);
      setSpeechVadModelFactoryForTests(amplitudeFakeModel());
      const vadParamsWithoutType = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["silence"], vadParams: { threshold: 0.5 } });
      expect(vadParamsWithoutType).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("speechActivity") } });
      const started = await facade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["speechActivity"], vadParams: { threshold: 0.45 }, startSec: 0, endSec: 5 });
      if (!started.ok) throw new Error(started.error.message);
      let status;
      for (let i = 0; i < 200; i++) {
        status = await facade["job.status"]({ jobId: started.value.jobId });
        if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toMatchObject({ ok: true, value: { state: "done" } });
      if (!status?.ok) throw new Error("speechActivity job did not finish");
      const result = status.value.result;
      if (!result || !("summary" in result)) throw new Error("no analysis result");
      const summary = result.summary as Record<string, any>;
      expect(summary.speechActivity).toMatchObject({ coordinateSpace: "source", regionCount: 2, parameters: { threshold: 0.45 } });
      expect(summary.speechActivity).not.toHaveProperty("speechRegions");
      const recordId = summary.analysisRecord.id as string;
      expect(recordId).toMatch(/^analysis-/);
      const view = await facade["analysis.get"]({ recordId, view: "events", series: "speechActivity.speechRegions", startSec: 0, endSec: 5, limit: 1 });
      expect(view).toMatchObject({ ok: true });
      if (!view.ok) throw new Error(view.error.message);
      const events = (view.value as import("./analysis-records").AnalysisAgentView).events!;
      expect(events.totalMatched).toBe(2);
      expect(events.items).toHaveLength(1);
      expect(events.items[0]).toMatchObject({ startSec: expect.any(Number), endSec: expect.any(Number) });
      expect(events.nextCursor).toBeTruthy();
      const secondPage = await facade["analysis.get"]({ recordId, view: "events", series: "speechActivity.speechRegions", startSec: 0, endSec: 5, limit: 1, cursor: events.nextCursor! });
      if (!secondPage.ok) throw new Error(secondPage.error.message);
      const secondEvents = (secondPage.value as import("./analysis-records").AnalysisAgentView).events!;
      expect(secondEvents.items).toHaveLength(1);
      expect(secondEvents.nextCursor).toBeNull();
      const record = await facade["analysis.get"]({ recordId });
      if (!record.ok) throw new Error(record.error.message);
      const recordView = record.value as import("./analysis-records").AnalysisAgentView;
      expect(recordView.config.vadParams).toMatchObject({ threshold: 0.45 });
      expect(recordView.provenance).toContainEqual(expect.objectContaining({ provider: "local-silero-vad-onnx", analysisType: "speechActivity" }));
      expect(recordView.inferences).toContainEqual(expect.objectContaining({ source: "speechActivity" }));
      const stored = JSON.parse(await readFile(recordView.recordPath, "utf8")) as { observations: Array<{ source: string; facts: { speechRegions?: unknown[] } }> };
      const facts = stored.observations.find((observation) => observation.source === "speechActivity")!.facts;
      expect(facts.speechRegions).toHaveLength(2);
    } finally {
      setSpeechVadModelFactoryForTests(null);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it("gates the request like other audio types", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-vad-gate-"));
    try {
      const path = join(root, "speech.wav");
      await writeFile(path, vadWav([{ startSec: 0, endSec: 1 }], 2));
      const noRootFacade = createAgentFacade({ mediaRoots: [root] });
      await noRootFacade["project.create"]({ name: "VAD gate test" });
      const imported = await noRootFacade["media.import"]({ path });
      if (!imported.ok) throw new Error(imported.error.message);
      expect(await noRootFacade["media.analyze_start"]({ mediaId: imported.value.mediaId, analysisTypes: ["speechActivity"] }))
        .toMatchObject({ ok: false, error: { code: "UNSUPPORTED", message: expect.stringContaining("artifactRoot") } });
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "VAD range test" });
      const rangeImport = await facade["media.import"]({ path });
      if (!rangeImport.ok) throw new Error(rangeImport.error.message);
      expect(await facade["media.analyze_start"]({ mediaId: rangeImport.value.mediaId, analysisTypes: ["speechActivity"], startSec: 0, endSec: 3 }))
        .toMatchObject({ ok: false, error: { code: "INVALID_PARAMS", message: expect.stringContaining("source duration") } });
      const unavailable = await facade["media.analyze_start"]({ mediaId: rangeImport.value.mediaId, analysisTypes: ["speechTranscript"] });
      expect(unavailable).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
      if (!unavailable.ok) expect(JSON.stringify(unavailable.error.details)).toContain("speechActivity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

/* ------------------------------------------------------------------ */
/* Real-model acceptance (AUD-01): runs when the pinned Silero model   */
/* is reachable locally; otherwise skipped with the reason disclosed.  */
/* ------------------------------------------------------------------ */

async function locateRealModel(): Promise<string | null> {
  if (process.env.REELTERMINAL_VAD_MODEL) return process.env.REELTERMINAL_VAD_MODEL;
  const defaultPath = join(homedir(), ".reelterminal", "models", `${SILERO_VAD_MODEL.name}-${SILERO_VAD_MODEL.version}`, SILERO_VAD_MODEL.file);
  const fileStat = await stat(defaultPath).catch(() => null);
  return fileStat?.isFile() ? defaultPath : null;
}

function ffmpegFliteAvailable(): boolean {
  try {
    const filters = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8", windowsHide: true });
    return filters.includes("flite");
  } catch {
    return false;
  }
}

describe("speechActivity real-model acceptance (AUD-01)", () => {
  it("preflight reports ready with the pinned model", async () => {
    const modelPath = await locateRealModel();
    if (!modelPath) {
      console.warn("[speech-vad] real Silero model not present — skipping preflight acceptance (set REELTERMINAL_VAD_MODEL or place the pinned file in ~/.reelterminal/models/)");
      return;
    }
    process.env.REELTERMINAL_VAD_MODEL = modelPath;
    const preflight = await speechVadPreflight();
    expect(preflight.available).toBe(true);
    if (preflight.available) {
      expect(preflight.details.model).toMatchObject({ version: "5.1.2", sha256: SILERO_VAD_MODEL.sha256 });
    }
  }, 30000);

  it.skipIf(!ffmpegFliteAvailable() || process.env.REELTERMINAL_VAD_SKIP_REAL === "1")("separates flite speech from noise, silence, tone music and stereo gaps", async () => {
    const modelPath = await locateRealModel();
    if (!modelPath) {
      console.warn("[speech-vad] real Silero model not present — skipping real-model acceptance (set REELTERMINAL_VAD_MODEL or run once with network to populate the cache)");
      return;
    }
    process.env.REELTERMINAL_VAD_MODEL = modelPath;
    const root = await mkdtemp(join(tmpdir(), "rt-vad-real-"));
    const ffmpeg = (output: string, args: string[]) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, output], { windowsHide: true });
    try {
      ffmpeg(join(root, "noise.wav"), ["-f", "lavfi", "-i", "anoisesrc=color=pink:duration=8:amplitude=0.2", "-ar", "16000", "-ac", "1"]);
      ffmpeg(join(root, "silence.wav"), ["-f", "lavfi", "-i", "anullsrc=duration=8:r=16000:cl=mono", "-acodec", "pcm_s16le"]);
      ffmpeg(join(root, "music.wav"), ["-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=16000", "-ac", "2"]);
      ffmpeg(join(root, "stereo-speech.wav"), [
        "-f", "lavfi", "-i", "flite=text='Voice only on the right channel.':voice=slt",
        "-af", "pan=stereo|c0=0*c0|c1=c0", "-ar", "16000",
      ]);
      ffmpeg(join(root, "mixed.wav"), [
        "-f", "lavfi", "-i", "anullsrc=duration=1.5:r=16000:cl=mono",
        "-f", "lavfi", "-i", "flite=text='Hello, this is a voice activity detection test.':voice=slt",
        "-f", "lavfi", "-i", "anullsrc=duration=2:r=16000:cl=mono",
        "-f", "lavfi", "-i", "flite=text='Second spoken sentence after a pause.':voice=slt",
        "-filter_complex", "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1", "-ar", "16000",
      ]);
      const signal = new AbortController().signal;
      const noise = await analyzeSpeechActivity(join(root, "noise.wav"), { startSec: 0, endSec: 8 }, undefined, signal);
      expect(noise.regionCount).toBe(0);
      const silence = await analyzeSpeechActivity(join(root, "silence.wav"), { startSec: 0, endSec: 8 }, undefined, signal);
      expect(silence.regionCount).toBe(0);
      const music = await analyzeSpeechActivity(join(root, "music.wav"), { startSec: 0, endSec: 8 }, undefined, signal);
      expect(music.regionCount).toBe(0);
      const stereo = await analyzeSpeechActivity(join(root, "stereo-speech.wav"), { startSec: 0, endSec: 3 }, undefined, signal);
      expect(stereo.regionCount).toBeGreaterThanOrEqual(1); // right-only speech survives the strongest-sample mix
      const mixed = await analyzeSpeechActivity(join(root, "mixed.wav"), { startSec: 0, endSec: 11 }, undefined, signal);
      // The model may split words inside an utterance; the structural truth is
      // speech exists, starts at the 1.5s leading-silence edge within one
      // chunk+padding error budget, and the 2s sentence pause survives.
      expect(mixed.regionCount).toBeGreaterThanOrEqual(2);
      expect(Math.abs(mixed.speechRegions[0]!.startSec - 1.5)).toBeLessThan(0.3);
      let largestGap = 0;
      for (let i = 1; i < mixed.speechRegions.length; i++) {
        largestGap = Math.max(largestGap, mixed.speechRegions[i]!.startSec - mixed.speechRegions[i - 1]!.endSec);
      }
      expect(largestGap).toBeGreaterThan(1);
      expect(mixed.speechRegions.at(-1)!.endSec).toBeLessThan(11);
      expect(mixed.granularitySec).toBeCloseTo(0.032, 3);
    } finally {
      delete process.env.REELTERMINAL_VAD_MODEL;
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
