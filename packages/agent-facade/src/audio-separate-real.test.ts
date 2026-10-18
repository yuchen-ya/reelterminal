/**
 * AUD-09 real Demucs separation acceptance. Skips unless an explicit Python
 * interpreter and the pinned htdemucs weights are available:
 *   REELTERMINAL_SEPARATION_PYTHON=<python with demucs 4.1>
 *   REELTERMINAL_DEMUCS_CACHE=<populated Hugging Face cache root>
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentFacade } from "./index";
import type { SeparatedAudioArtifact } from "./audio-separate";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

const PYTHON = process.env.REELTERMINAL_SEPARATION_PYTHON ?? "";
const CACHE = process.env.REELTERMINAL_DEMUCS_CACHE ?? "";
const MODEL_PRESENT = CACHE.length > 0 && existsSync(join(CACHE, "hub", "models--adefossez--HTDemucs"));
const ENABLED = PYTHON.length > 0 && MODEL_PRESENT;
let previous: { python?: string; cache?: string } = {};

beforeAll(() => {
  if (!ENABLED) return;
  previous = { python: process.env.REELTERMINAL_SEPARATION_PYTHON, cache: process.env.REELTERMINAL_DEMUCS_CACHE };
  process.env.REELTERMINAL_SEPARATION_PYTHON = PYTHON;
  process.env.REELTERMINAL_DEMUCS_CACHE = CACHE;
});

afterAll(() => {
  if (!ENABLED) return;
  if (previous.python === undefined) delete process.env.REELTERMINAL_SEPARATION_PYTHON;
  else process.env.REELTERMINAL_SEPARATION_PYTHON = previous.python;
  if (previous.cache === undefined) delete process.env.REELTERMINAL_DEMUCS_CACHE;
  else process.env.REELTERMINAL_DEMUCS_CACHE = previous.cache;
});

describe.skipIf(!ENABLED)("AUD-09 real Demucs separation", () => {
  it("separates vocals and the instrumental into aligned 48 kHz windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "rt-separate-real-"));
    try {
      const tools = await resolveToolFfmpeg();
      if (!tools) throw new Error("FFmpeg required");
      const source = join(root, "music.wav");
      await runToolProcess(tools.ffmpeg, [
        "-hide_banner", "-v", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=44100",
        "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:a=0.05:seed=3",
        "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo",
        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", source,
      ]);
      const facade = createAgentFacade({ mediaRoots: [root], artifactRoot: join(root, "artifacts") });
      await facade["project.create"]({ name: "Real separation" });
      const imported = await facade["media.import"]({ path: source });
      if (!imported.ok) throw new Error(imported.error.message);
      for (const target of ["vocals", "instrumental"] as const) {
        const started = await facade["audio.process.separate"]({
          mediaId: imported.value.mediaId,
          audioStream: 0,
          startSec: 0,
          endSec: 5,
          sampleRate: 48000,
          channels: 2,
          target,
          idempotencyKey: `real-separate-${target}`,
        });
        if (!started.ok) throw new Error(started.error.message);
        let status;
        for (let attempt = 0; attempt < 1200; attempt++) {
          status = await facade["job.status"]({ jobId: started.value.jobId });
          if (status.ok && ["done", "error", "cancelled"].includes(status.value.state)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!status?.ok || status.value.state !== "done") throw new Error(`real separation failed: ${JSON.stringify(status)}`);
        const artifact = status.value.result as SeparatedAudioArtifact;
        expect(artifact).toMatchObject({
          target,
          timing: { sampleRate: 48000, channels: 2, sampleCount: 240000 },
          processing: { model: "htdemucs", modelRepo: "adefossez/HTDemucs" },
        });
        expect(artifact.processing.device).toMatch(/cuda|cpu/);
        expect(artifact.processing.inferenceSeconds).toBeGreaterThan(0);
        expect(artifact.processing.realtimeFactor).toBeGreaterThan(0);
        expect(artifact.processing.peakGpuMemoryMb === null || artifact.processing.peakGpuMemoryMb > 0).toBe(true);
        expect(artifact.after === null || artifact.after.integratedLufs < 0).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});
