import { expect, it } from "vitest";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { audioStretchAssets } from "./node/audio-stretch-assets.mjs";

// Real OfflineAudioContext rendering. Synthetic PCM only, isolated Chromium;
// no desktop project, endpoint, external service, speakers or export jobs.
it("renders constant and curved trim/seek/chunk boundaries in real Chromium audio", async () => {
  const audioDirectory = fileURLToPath(new URL("../../core/src/audio/", import.meta.url));
  const shim = fileURLToPath(new URL("./browser/extract-audio-shim.ts", import.meta.url));
  const bundle = await build({
    stdin: { contents: 'export { AudioEngine } from "./audio-engine"; export { RealtimeAudioGraph } from "./realtime-audio-graph";', resolveDir: audioDirectory },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "AudioTimingModule",
    plugins: [audioStretchAssets(), { name: "existing-audio-decode-shim", setup(builder) {
      builder.onResolve({ filter: /(^|\/)extract-audio$/ }, () => ({ path: shim }));
    } }],
  });
  const browser = await chromium.launch({ headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
    ...(process.env.REELTERMINAL_TEST_CHROMIUM ? { executablePath: process.env.REELTERMINAL_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const { AudioEngine, RealtimeAudioGraph } = (globalThis as unknown as {
        AudioTimingModule: typeof import("@reelterminal/core/audio/audio-engine") & typeof import("@reelterminal/core/audio/realtime-audio-graph");
      }).AudioTimingModule;
      const rate = 48000;
      const context = new OfflineAudioContext(2, rate * 12, rate);
      const input = context.createBuffer(2, rate * 12, rate);
      const pcm = input.getChannelData(0);
      // Each source second has a distinct mean amplitude; a low tone also
      // checks real resampling. Values remain well below clipping.
      for (let i = 0; i < pcm.length; i++) {
        const time = i / rate;
        pcm[i] = 0.1 + Math.floor(time) * 0.025 + Math.sin(time * Math.PI * 160) * 0.01;
      }
      input.getChannelData(1).set(pcm);
      const wav = new ArrayBuffer(44 + pcm.length * 4);
      const view = new DataView(wav);
      const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      text(36, "data"); view.setUint32(40, pcm.length * 4, true);
      for (let i = 0; i < pcm.length; i++) {
        view.setInt16(44 + i * 4, Math.round(pcm[i] * 32767), true);
        view.setInt16(46 + i * 4, Math.round(pcm[i] * 32767), true);
      }
      const blob = new Blob([wav], { type: "audio/wav" });
      const mean = (buffer: AudioBuffer, time: number) => {
        const samples = buffer.getChannelData(0);
        const begin = Math.round(time * rate), end = Math.round((time + 0.05) * rate);
        let sum = 0;
        for (let i = begin; i < end; i++) sum += samples[i] ?? 0;
        return sum / (end - begin);
      };
      const expected = (sourceTime: number) => 0.1 + Math.floor(sourceTime) * 0.025;
      const engine = new AudioEngine({ sampleRate: rate, channels: 2 });
      await engine.initialize();
      const checks: Array<{ kind: string; speed: number; actual: number; expected: number }> = [];
      try {
        for (const speed of [0.5, 1, 2]) {
          for (const reversed of [false, true]) {
            const clip = { id: "clip", mediaId: "media", trackId: "track", startTime: 1,
              duration: 8 / speed, inPoint: 2, outPoint: 10, speed, reversed, pitchCorrection: false, volume: 1, effects: [] };
            const project = { settings: { sampleRate: rate, channels: 2 },
              timeline: { tracks: [{ id: "track", type: "audio", muted: false, solo: false, transitions: [], clips: [clip] }] },
              mediaLibrary: { items: [{ id: "media", blob, metadata: { duration: 12 } }] } } as unknown as import("@reelterminal/core/types/project").Project;
            const full = (await engine.renderAudio(project, 0, 1 + 8 / speed + 0.2)).buffer;
            checks.push({ kind: `full-${reversed ? "reverse" : "forward"}`, speed,
              actual: mean(full, 1.15), expected: expected(reversed ? 10 - 0.15 * speed - 0.001 : 2 + 0.15 * speed) });
            checks.push({ kind: "tail", speed, actual: mean(full, 1 + 8 / speed + 0.05), expected: 0 });
            checks.push({ kind: "last-audible", speed, actual: mean(full, 1 + 8 / speed - 0.1),
              expected: expected(reversed ? 2 + 0.1 * speed : 10 - 0.1 * speed) });
            const mid = (await engine.renderAudio(project, 2, 1)).buffer;
            checks.push({ kind: `mid-${reversed ? "reverse" : "forward"}`, speed, actual: mean(mid, 0.15),
              expected: expected(reversed ? 10 - 1.15 * speed - 0.001 : 2 + 1.15 * speed) });
            const chunk = (await engine.renderAudio(project, 3, 1)).buffer;
            checks.push({ kind: "chunk-continuity", speed, actual: mean(chunk, 0.15), expected: mean(full, 3.15) });

            const graphContext = new OfflineAudioContext(2, Math.ceil(rate * (clip.duration - 1 + 0.2)), rate);
            const graph = new RealtimeAudioGraph({ currentTime: 2, getAudioContext: () => graphContext } as unknown as import("@reelterminal/core/playback/master-timeline-clock").MasterTimelineClock);
            graph.scheduleClip({ clipId: clip.id, trackId: "track", audioBuffer: input,
              startTime: clip.startTime, endTime: 1 + clip.duration, mediaOffset: 2, mediaEnd: 10,
              speed, reversed, pitchCorrection: false, volume: 1, volumeAutomation: [], pan: 0, effects: [] });
            const graphAudio = await graphContext.startRendering();
            checks.push({ kind: `preview-${reversed ? "reverse" : "forward"}`, speed, actual: mean(graphAudio, 0.15),
              expected: expected(reversed ? 10 - 1.15 * speed - 0.001 : 2 + 1.15 * speed) });
            checks.push({ kind: "preview-tail", speed, actual: mean(graphAudio, clip.duration - 1 + 0.05), expected: 0 });
            graph.dispose();
          }
        }
        for (const reversed of [false, true]) {
          const duration = 4 * Math.log(3);
          const clip = { id: "curved", mediaId: "media", trackId: "track", startTime: 1,
            duration, inPoint: 2, outPoint: 10, speed: 17, reversed, pitchCorrection: false,
            volume: 1, effects: [], speedKeyframes: [
              { id: "a", time: 0, speed: 1, easing: "linear" as const },
              { id: "b", time: 8, speed: 3, easing: "linear" as const },
            ] };
          const project = { settings: { sampleRate: rate, channels: 2 },
            timeline: { tracks: [{ id: "track", type: "audio", muted: false, solo: false, transitions: [], clips: [clip] }] },
            mediaLibrary: { items: [{ id: "media", blob, metadata: { duration: 12 } }] } } as unknown as import("@reelterminal/core/types/project").Project;
          const full = (await engine.renderAudio(project, 0, 1 + duration + 0.2)).buffer;
          const analyticalCurveMean = (time: number) => {
            let sum = 0;
            const first = Math.round(time * rate);
            const count = Math.round(0.05 * rate);
            for (let frame = first; frame < first + count; frame++) {
              const movingSource = 4 * (Math.exp(frame / rate / 4) - 1);
              const sourceTime = reversed ? 10 - movingSource - 1 / rate : 2 + movingSource;
              const value = 0.1 + Math.floor(sourceTime) * 0.025 + Math.sin(sourceTime * Math.PI * 160) * 0.01;
              sum += Math.round(value * 32767) / 32768;
            }
            return sum / count;
          };
          for (const time of [0.15, 0.9, 1.3, 2.25, 3.5, 4.2]) {
            checks.push({ kind: `curve-map-${reversed ? "reverse" : "forward"}`, speed: 17,
              actual: mean(full, 1 + time), expected: analyticalCurveMean(time) });
          }
          for (const offset of [0, 1.3, 2.25]) {
            const range = (await engine.renderAudio(project, 1 + offset, 0.5)).buffer;
            checks.push({ kind: "curve-offline-range", speed: 17, actual: mean(range, 0.15), expected: mean(full, 1 + offset + 0.15) });
            const graphContext = new OfflineAudioContext(2, Math.ceil(rate * (duration - offset + 0.2)), rate);
            const graph = new RealtimeAudioGraph({ currentTime: 1 + offset, getAudioContext: () => graphContext } as unknown as import("@reelterminal/core/playback/master-timeline-clock").MasterTimelineClock);
            const schedule = { clipId: clip.id, trackId: "track", audioBuffer: input,
              startTime: 1, endTime: 1 + duration, mediaOffset: 2, mediaEnd: 10,
              speed: clip.speed, reversed, speedKeyframes: clip.speedKeyframes, pitchCorrection: false,
              volume: 1, volumeAutomation: [], pan: 0, effects: [] };
            await graph.prepareClip(schedule);
            graph.scheduleClip(schedule);
            const output = await graphContext.startRendering();
            checks.push({ kind: "curve-preview-range", speed: 17, actual: mean(output, 0.15), expected: mean(full, 1 + offset + 0.15) });
            checks.push({ kind: "curve-preview-end", speed: 17, actual: mean(output, duration - offset + 0.05), expected: 0 });
            graph.dispose();
          }
          checks.push({ kind: "curve-end", speed: 17, actual: mean(full, 1 + duration + 0.05), expected: 0 });
          const errorCode = async (overrides: Partial<typeof clip>) => {
            const invalid = { ...project, timeline: { ...project.timeline, tracks: project.timeline.tracks.map((track) => ({ ...track, clips: [{ ...track.clips[0], ...overrides }] })) } };
            try { await engine.renderAudio(invalid, 1, 0.5); return "no error"; }
            catch (error) { return (error as { code: string }).code; }
          };
          if (await errorCode({ pitchCorrection: true }) !== "AUDIO_PITCH_CORRECTION_UNAVAILABLE") throw new Error("Pitch correction was silently ignored");
          const frozen = { ...project, timeline: { ...project.timeline, tracks: project.timeline.tracks.map((track) => ({ ...track, clips: [{ ...track.clips[0], freezeFrames: [{ id: "f", clipId: clip.id, startTime: 0.2, sourceTime: 2, duration: 1 }] }] })) } };
          try { await engine.renderAudio(frozen, 1, 0.5); throw new Error("Freeze audio was silently rendered"); }
          catch (error) { if ((error as { code: string }).code !== "AUDIO_FREEZE_UNDEFINED") throw error; }
        }
      } finally { engine.dispose(); }
      return checks;
    });
    for (const check of result) {
      expect(check.actual, `${check.kind} at ${check.speed}x`).toBeCloseTo(check.expected, 3);
    }
    expect(result).toHaveLength(74);
  } finally { await browser.close(); }
});
