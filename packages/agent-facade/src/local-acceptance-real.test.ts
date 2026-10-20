/** Opt-in local acceptance, real models only; evidence stays outside source. */
import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transcribeCaptionFile } from "./media/caption-transcription";
import { runAudioModelTask } from "./media/audio-models-runner";
import { readAudioEnvironment } from "./media/audio-environment-config";

const evidence = process.env.REELTERMINAL_LOCAL_ACCEPTANCE_DIR;
const engine = process.env.REELTERMINAL_LOCAL_ACCEPTANCE_ENGINE;
const language = process.env.REELTERMINAL_LOCAL_ACCEPTANCE_LANGUAGE ?? "zh";
const enabled = Boolean(evidence) && (engine === "qwen" || engine === "sensevoice");

test.skipIf(!enabled)("real captions: initial and repeat run", async () => {
  const root = evidence!;
  const wav = join(root, "speech-19s.wav");
  const results: unknown[] = [];
  const save = () => writeFile(join(root, `${engine}-${language}-captions.json`), JSON.stringify(results, null, 2));
  for (const label of ["initial", "repeat"]) {
    const started = performance.now();
    const captions = await transcribeCaptionFile(wav, 19, language, new AbortController().signal, engine as "qwen" | "sensevoice");
    const text = captions.map(caption => caption.text).join("");
    results.push({ label, seconds: (performance.now() - started) / 1000, captions, text });
    await save();
    expect(captions.length).toBeGreaterThan(0);
    expect(text).toContain("圆周率");
    expect(text).toContain("直径");
    let previous = 0;
    for (const caption of captions) {
      expect(caption.startSec).toBeGreaterThanOrEqual(previous);
      expect(caption.endSec).toBeGreaterThan(caption.startSec);
      expect(caption.endSec).toBeLessThanOrEqual(19);
      previous = caption.endSec;
    }
  }
  expect(JSON.parse(await readFile(join(root, `${engine}-${language}-captions.json`), "utf8"))).toHaveLength(2);
}, 600_000);

test.skipIf(!enabled || engine !== "qwen")("real worker cancellation and failure cleanup", async () => {
    const root = evidence!;
    const results: unknown[] = [];
    const wav = join(root, "speech-19s.wav");
    const config = readAudioEnvironment();
    const request = {
      task: "caption-qwen", wavPath: wav, duration: 19, language: "zh",
      modelDir: config.qwenModelDir, alignerDir: config.qwenAlignerModelDir,
    };
    const controller = new AbortController();
    const cancelledAt = performance.now();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await expect(runAudioModelTask(request, { signal: controller.signal })).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    results.push({ label: "cancel", seconds: (performance.now() - cancelledAt) / 1000, aborted: controller.signal.aborted });
    expect(controller.signal.aborted).toBe(true);
    await expect(runAudioModelTask({ ...request, wavPath: join(root, "deliberately-missing.wav") })).rejects.toThrow();
    results.push({ label: "missing-input-worker-failure", rejected: true });
    await writeFile(join(root, "qwen-cancel-failure.json"), JSON.stringify(results, null, 2));
}, 120_000);

test.skipIf(!evidence || !["sensevoice-lifecycle", "demucs"].includes(engine ?? ""))("real loaded model cancels, fails and then recovers", async () => {
  const root = evidence!;
  const config = readAudioEnvironment();
  const demucs = engine === "demucs";
  const phase = demucs ? "separate" : "transcribe";
  const request = demucs
    ? { task: "separate", wavPath: join(root, "demucs-mixture.wav"), cacheDir: config.demucsCache,
        offline: true, outputDir: join(root, "demucs-recovery") }
    : { task: "transcribe", wavPath: join(root, "speech-19s.wav"), modelDir: config.senseVoiceModelDir,
        segments: [{ startSec: 0, endSec: 5.544 }], language: "zh", useItn: true };
  const controller = new AbortController();
  const observed: unknown[] = [];
  await expect(runAudioModelTask(request, {
    signal: controller.signal,
    onProgress: (percent, currentPhase) => {
      observed.push({ percent, phase: currentPhase });
      if (currentPhase === phase) controller.abort();
    },
  })).rejects.toThrow("Cancelled");
  expect(controller.signal.aborted).toBe(true);
  await expect(runAudioModelTask({ ...request, wavPath: join(root, "deliberately-missing.wav") })).rejects.toThrow();
  const recovered = await runAudioModelTask(request);
  if (demucs) expect(recovered.stems).toHaveLength(4);
  else expect((recovered.texts as string[]).join("")).toContain("圆周率");
  await writeFile(join(root, `${engine}-lifecycle.json`), JSON.stringify({
    cancelledAfterModelLoad: true, observed, missingInputRejected: true, recovered,
  }, null, 2));
}, 300_000);
