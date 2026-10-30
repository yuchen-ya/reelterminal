import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent, value } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";
import { ARTIFACTS_DIR } from "./harness/paths";

type ScheduledPcm = { id: number; duration: number; sampleRate: number; playbackRate: number; offset: number; frequencies: number[] };

function frequency(samples: number[], rate: number): number {
  const crossings: number[] = [];
  for (let i = Math.round(samples.length * 0.2); i < Math.round(samples.length * 0.8) - 1; i++) {
    if (samples[i] <= 0 && samples[i + 1] > 0) crossings.push(i - samples[i] / (samples[i + 1] - samples[i]));
  }
  return (crossings.length - 1) * rate / (crossings[crossings.length - 1] - crossings[0]);
}

test("packaged pitch-preserving playback, seek, speed edits and encoded export use real WASM PCM", async () => {
  const launched = await launchApp();
  let agent: ExternalAgent | undefined;
  const workers: string[] = [];
  launched.page.on("worker", (worker) => workers.push(worker.url()));
  try {
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const context = value(await agent.callCommand<any>("editor.get_context"));
    const target = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    await agent.schema("edit.apply");
    value(await agent.callCommand("capabilities.get"));
    const call = async (name: string, args: Record<string, unknown> = {}) => value(await agent!.callCommand<any>(name, args));
    const state = () => call("project.get_state", target);
    const edit = async (ops: unknown[]) => call("edit.apply", { ...target, expectedRevision: (await state()).revision, ops });

    // Observe real scheduled source PCM. The original native start() still
    // receives the exact same arguments and nodes; no store or DSP is mocked.
    await launched.page.evaluate(() => {
      const observed = globalThis as unknown as { pitchScheduled: ScheduledPcm[] };
      observed.pitchScheduled = [];
      const ids = new WeakMap<AudioBuffer, number>();
      let nextId = 0;
      const original = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof original>) {
        if (this.buffer) {
          const buffer = this.buffer;
          if (!ids.has(buffer)) ids.set(buffer, ++nextId);
          const frequencies = Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
            const samples = buffer.getChannelData(channel), crossings: number[] = [];
            const from = Math.round(buffer.length * 0.2), to = Math.round(buffer.length * 0.8);
            for (let i = from; i < to - 1; i++) {
              if (samples[i] <= 0 && samples[i + 1] > 0) crossings.push(i - samples[i] / (samples[i + 1] - samples[i]));
            }
            return (crossings.length - 1) * buffer.sampleRate / (crossings[crossings.length - 1] - crossings[0]);
          });
          observed.pitchScheduled.push({ id: ids.get(buffer)!, duration: buffer.duration, sampleRate: buffer.sampleRate,
            playbackRate: this.playbackRate.value, offset: args[1] ?? 0, frequencies });
        }
        Reflect.apply(original, this, args);
      };
    });

    const rate = 24000, frames = rate * 6;
    const wav = Buffer.alloc(44 + frames * 4);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(frames * 4, 40);
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < 2; channel++) wav.writeInt16LE(Math.round(0.4 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * frame / rate) * 32767), 44 + frame * 4 + channel * 2);
    }
    const fixture = path.join(launched.runDir, "stereo-pitch.wav");
    writeFileSync(fixture, wav);
    const imported = await call("media.import", { ...target, path: fixture });
    await edit([{ op: "track.add", trackType: "audio", trackId: "pitch-track" }]);
    await edit([{ op: "clip.add", trackId: "pitch-track", mediaId: imported.mediaId, startTime: 0, inPoint: 1, outPoint: 5, duration: 4 }]);
    const clipId = (await state()).project.timeline.tracks.find((track: any) => track.id === "pitch-track").clips[0].id;
    const records: ScheduledPcm[] = [];
    const scheduled = () => launched.page.evaluate(() => (globalThis as unknown as { pitchScheduled: ScheduledPcm[] }).pitchScheduled);
    const control = (action: string, timeSeconds?: number) => call("editor.control", { ...target, action, ...(timeSeconds === undefined ? {} : { timeSeconds }) });
    for (const speed of [1.5, 2]) {
      await edit([{ op: "clip.setSpeedConfig", clipId, speed, reversed: false, pitchCorrection: true, keyframes: [], freezeFrames: [] }]);
      await control("seek", 0);
      await launched.page.getByRole("button", { name: "Play", exact: true }).click();
      let first!: ScheduledPcm;
      await vi.waitFor(async () => {
        first = (await scheduled()).filter((row) => Math.abs(row.duration - 4 / speed) < 0.0001).at(-1)!;
        expect(first).toBeDefined();
      }, { timeout: 30000, interval: 100 });
      await control("pause");
      expect(first.playbackRate).toBe(1);
      expect(first.frequencies[0]).toBeCloseTo(440, 0);
      expect(first.frequencies[1]).toBeCloseTo(660, 0);
      records.push(first);
      const beforeSeek = (await scheduled()).length;
      await control("seek", 1.25);
      await control("play");
      await vi.waitFor(async () => expect((await scheduled()).length).toBeGreaterThan(beforeSeek), { timeout: 15000, interval: 100 });
      await control("pause");
      const seek = (await scheduled()).filter((row) => Math.abs(row.duration - 4 / speed) < 0.0001).at(-1)!;
      expect(seek.duration).toBeCloseTo(4 / speed, 4);
      expect(seek.frequencies[0]).toBeCloseTo(440, 0);
      expect(seek.frequencies[1]).toBeCloseTo(660, 0);
      expect(seek.offset).toBeCloseTo(1.25, 1);
      expect(seek.playbackRate).toBe(1);
    }
    expect(records[0].id).not.toBe(records[1].id);
    expect(workers.some((url) => url.includes("signalsmith-stretch.worker"))).toBe(true);

    await edit([{ op: "clip.setSpeedConfig", clipId, speed: 1.5, reversed: false, pitchCorrection: true, keyframes: [], freezeFrames: [] }]);
    const outputDirectory = path.join(launched.runDir, "agent-workspace", "jobs", "audio-pitch", "output");
    mkdirSync(outputDirectory, { recursive: true });
    const destination = path.join(outputDirectory, "pitch-export.mp4");
    const job = await call("export.start", { ...target, expectedRevision: (await state()).revision,
      settings: { width: 320, height: 180, frameRate: 24, videoBitrateKbps: 500 }, destinationPath: destination });
    let completed: any;
    await vi.waitFor(async () => {
      completed = await call("job.status", { jobId: job.jobId });
      expect(["done", "error", "cancelled"]).toContain(completed.state);
    }, { timeout: 180000, interval: 500 });
    expect(completed.state, JSON.stringify(completed.error)).toBe("done");
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
    const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
    const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", destination], { encoding: "utf8", windowsHide: true }));
    expect(Number(probe.format.duration)).toBeCloseTo(4 / 1.5, 1);
    const pcm = execFileSync(ffmpeg, ["-v", "error", "-i", destination, "-map", "0:a:0", "-f", "f32le", "-ar", String(rate), "-ac", "2", "pipe:1"], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const frequencies = [0, 1].map((channel) => frequency(Array.from({ length: pcm.length / 8 }, (_, frame) => pcm.readFloatLE(frame * 8 + channel * 4)), rate));
    expect(frequencies[0]).toBeCloseTo(440, 0);
    expect(frequencies[1]).toBeCloseTo(660, 0);
    expect(launched.output.rendererConsole.filter((line) => /startPlayback error|Audio playback failed|Unable to load signalsmith|worker initialization failed/i.test(line))).toEqual([]);
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    copyFileSync(destination, path.join(ARTIFACTS_DIR, "audio-pitch-export.mp4"));
    writeFileSync(path.join(ARTIFACTS_DIR, "audio-pitch-result.json"), JSON.stringify({ packaged: Boolean(process.env.REELTERMINAL_E2E_APP_EXECUTABLE), scheduled: records, workers,
      export: { duration: Number(probe.format.duration), frequencies, audioCodec: probe.streams.find((stream: any) => stream.codec_type === "audio")?.codec_name } }, null, 2));
  } finally {
    await agent?.close();
    await launched.close();
  }
});
