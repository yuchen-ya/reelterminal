import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAudioStreams, produceNormalizedAudio } from "./audio-normalize";
import { resolveToolFfmpeg, runToolProcess } from "./media/ffmpeg-bin";

it("uses the selected Matroska track end, not the longer video or its offset twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-coverage-"));
  try {
    const tools = (await resolveToolFfmpeg())!;
    const path = join(root, "offset.mkv");
    await runToolProcess(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=1:duration=8",
      "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-y", path]);
    const stream = await probeAudioStreams(tools.ffprobe, path, 0, undefined, { allowStreamOffset: true });
    expect(stream.streamOffsetSec).toBe(2);
    expect(stream.durationSec).toBeCloseTo(2, 2);
    const input = { sourcePath: path, mediaRoots: [root], sourceProjectId: "p", sourceRevision: 1, artifactId: "coverage",
      params: { mediaId: "m", audioStream: 0, startSec: 0, endSec: 5, targetLufs: -20, truePeakDbtp: -1.5, loudnessRangeLu: 11, sampleRate: 48000 as const, channels: 1 as const } };
    await expect(produceNormalizedAudio(input)).rejects.toThrow(/ends after the selected audio stream/);
    const artifact = await produceNormalizedAudio({ ...input, params: { ...input.params, endSec: 3.5 } });
    expect(artifact.timing.leadSilenceSamples).toBe(96000);
    expect(artifact.timing.sampleCount).toBe(168000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
