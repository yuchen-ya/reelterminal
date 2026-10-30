import { expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { audioStretchAssets } from "./node/audio-stretch-assets.mjs";

it("preserves pitch and aligns preview/export across trim, reverse, seek and speed edits", async () => {
  const audioDirectory = fileURLToPath(new URL("../../core/src/audio/", import.meta.url));
  const shim = fileURLToPath(new URL("./browser/extract-audio-shim.ts", import.meta.url));
  const bundle = await build({
    stdin: { contents: 'export { AudioEngine } from "./audio-engine"; export { RealtimeAudioGraph } from "./realtime-audio-graph";', resolveDir: audioDirectory },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "AudioPitchModule",
    plugins: [audioStretchAssets(), { name: "existing-audio-decode-shim", setup(builder) {
      builder.onResolve({ filter: /(^|\/)extract-audio$/ }, () => ({ path: shim }));
    } }],
  });
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"],
    ...(process.env.REELTERMINAL_TEST_CHROMIUM ? { executablePath: process.env.REELTERMINAL_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.route("http://audio-pitch.test/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Audio pitch regression</title>" }));
    await page.goto("http://audio-pitch.test/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const results = await page.evaluate(async () => {
      const { AudioEngine, RealtimeAudioGraph } = (globalThis as unknown as {
        AudioPitchModule: typeof import("@reelterminal/core/audio/audio-engine") & typeof import("@reelterminal/core/audio/realtime-audio-graph");
      }).AudioPitchModule;
      const rate = 24000;
      const ctx = new OfflineAudioContext(2, rate * 6, rate);
      const input = ctx.createBuffer(2, rate * 6, rate);
      const wav = new ArrayBuffer(44 + input.length * 4);
      const view = new DataView(wav);
      const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      text(36, "data"); view.setUint32(40, input.length * 4, true);
      for (let channel = 0; channel < 2; channel++) {
        const pcm = input.getChannelData(channel);
        for (let frame = 0; frame < input.length; frame++) {
          const time = frame / rate;
          const envelope = 0.3 + 0.1 * Math.cos(2 * Math.PI * time);
          const sample = Math.round(envelope * Math.sin(2 * Math.PI * (channel ? 660 : 440) * time) * 32767);
          view.setInt16(44 + frame * 4 + channel * 2, sample, true);
          pcm[frame] = sample / 32768;
        }
      }
      const blob = new Blob([wav], { type: "audio/wav" });
      const frequency = (buffer: AudioBuffer, channel: number, from: number, to: number) => {
        const data = buffer.getChannelData(channel), crossings: number[] = [];
        for (let i = Math.round(from * rate); i < Math.round(to * rate) - 1; i++) {
          if (data[i] <= 0 && data[i + 1] > 0) crossings.push(i - data[i] / (data[i + 1] - data[i]));
        }
        return (crossings.length - 1) * rate / (crossings[crossings.length - 1] - crossings[0]);
      };
      const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
      const difference = (a: AudioBuffer, b: AudioBuffer, aOffset: number, seconds: number) => {
        let maximum = 0;
        for (let channel = 0; channel < 2; channel++) {
          const left = a.getChannelData(channel), right = b.getChannelData(channel);
          const start = Math.round(aOffset * rate), frames = Math.round(seconds * rate);
          for (let frame = 0; frame < frames; frame++) maximum = Math.max(maximum, Math.abs(left[start + frame] - right[frame]));
        }
        return maximum;
      };
      const engine = new AudioEngine({ sampleRate: rate, channels: 2 });
      await engine.initialize();
      const checks: Array<{ speed: number; reversed: boolean; frequency: number[]; previewDifference: number; chunkDifference: number; tailRms: number }> = [];
      const workers: Worker[] = [];
      const OriginalWorker = globalThis.Worker;
      globalThis.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.push(this); }
      };
      try {
        for (const speed of [0.5, 1.5, 2]) {
          for (const reversed of [false, true]) {
            const duration = 4 / speed;
            const clip = { id: "clip", mediaId: "media", trackId: "track", startTime: 1,
              duration, inPoint: 1, outPoint: 5, speed, reversed, volume: 1, effects: [], audioEffects: [] };
            const project = { settings: { sampleRate: rate, channels: 2 },
              timeline: { tracks: [{ id: "track", type: "audio", muted: false, solo: false, transitions: [], clips: [clip] }] },
              mediaLibrary: { items: [{ id: "media", blob, metadata: { duration: 6 } }] } } as unknown as import("@reelterminal/core/types/project").Project;
            const full = (await engine.renderAudio(project, 0, 1 + duration + 0.2)).buffer;
            const chunk = (await engine.renderAudio(project, 1.75, 0.5)).buffer;
            const graphContext = new OfflineAudioContext(2, Math.ceil(rate * (duration - 0.75 + 0.2)), rate);
            const graph = new RealtimeAudioGraph({ currentTime: 1.75, getAudioContext: () => graphContext } as unknown as import("@reelterminal/core/playback/master-timeline-clock").MasterTimelineClock);
            const schedule = { clipId: "clip", trackId: "track", audioBuffer: input, startTime: 1, endTime: 1 + duration,
              mediaOffset: 1, mediaEnd: 5, speed, reversed, volume: 1, volumeAutomation: [], pan: 0, effects: [] };
            await graph.prepareClip(schedule);
            graph.scheduleClip(schedule);
            const preview = await graphContext.startRendering();
            checks.push({ speed, reversed, frequency: [0, 1].map((channel) => frequency(full, channel, 1.2, 1.6)),
              previewDifference: difference(full, preview, 1.75, 0.5),
              chunkDifference: difference(full, chunk, 1.75, 0.5),
              tailRms: rms(full.getChannelData(0).subarray(Math.round((1 + duration + 0.05) * rate))) });
            graph.dispose();
          }
        }
        return { checks, workers: workers.length };
      } finally {
        globalThis.Worker = OriginalWorker;
        workers.forEach((worker) => worker.terminate());
        await engine.dispose();
      }
    });
    expect(results.workers).toBe(1);
    expect(results.checks).toHaveLength(6);
    for (const result of results.checks) {
      expect(result.frequency[0], JSON.stringify(result)).toBeCloseTo(440, 0);
      expect(result.frequency[1], JSON.stringify(result)).toBeCloseTo(660, 0);
      // The extraction shim re-encodes PCM16, while preview receives original
      // decoded PCM. Allow that quantization through spectral time stretching.
      expect(result.previewDifference, JSON.stringify(result)).toBeLessThan(0.002);
      expect(result.chunkDifference, JSON.stringify(result)).toBeLessThan(0.0001);
      expect(result.tailRms).toBe(0);
    }
  } finally { await browser.close(); }
});
