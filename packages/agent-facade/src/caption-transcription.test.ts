import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({
  run: vi.fn(),
  transcript: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./media/audio-models-runner", () => ({
  runAudioModelTask: fixture.run,
  senseVoiceModelDir: () => "sensevoice",
  senseVoiceModelStatus: async () => ({ verified: true }),
}));
vi.mock("./media/audio-environment-config", () => ({
  readAudioEnvironment: () => ({
    qwenModelDir: "qwen",
    qwenAlignerModelDir: "aligner",
  }),
}));
vi.mock("./media/qwen-captions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media/qwen-captions")>()),
  checkQwenCaptions: fixture.status,
}));
vi.mock("./speech-transcript", () => ({
  resolveTranscriptParams: () => ({}),
  transcribeSpeechRegions: fixture.transcript,
}));
vi.mock("./speech-vad", () => ({
  speechVadPreflight: async () => ({ available: true }),
  analyzeSpeechActivity: async () => ({
    speechRegions: [{ startSec: 1, endSec: 2 }],
    parameters: {},
    truncated: false,
  }),
}));
import { transcribeCaptionFile } from "./media/caption-transcription";
let directory: string, path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "caption-routing-"));
  path = join(directory, "speech.wav");
  await writeFile(path, "fixture");
  fixture.status.mockResolvedValue({
    runtime: { available: true },
    model: { available: true },
    aligner: { available: true },
  });
  fixture.run
    .mockReset()
    .mockResolvedValue({
      words: [{ text: "Hello.", startSec: 1, endSec: 2, language: "English" }],
    });
  fixture.transcript.mockResolvedValue({
    segments: [{ text: "Hello.", startSec: 1, endSec: 2, language: "en" }],
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("defaults to offline Qwen recognition and alignment", async () => {
  const result = await transcribeCaptionFile(
    path,
    5,
    "auto",
    new AbortController().signal,
  );
  expect(fixture.run.mock.calls[0]![0]).toMatchObject({
    task: "caption-qwen",
    modelDir: "qwen",
    alignerDir: "aligner",
  });
  expect(result[0]).toMatchObject({
    text: "Hello.",
    source: "qwen-forced-aligner",
  });
});
it("aligns SenseVoice output with the same aligner instead of returning VAD bounds", async () => {
  const result = await transcribeCaptionFile(
    path,
    5,
    "auto",
    new AbortController().signal,
    "sensevoice",
  );
  expect(fixture.run.mock.calls[0]![0]).toMatchObject({
    task: "caption-align",
    segments: [{ text: "Hello." }],
  });
  expect(result[0]!.words).toHaveLength(1);
});
it("fails before transcription when the aligner is unavailable", async () => {
  fixture.status.mockResolvedValue({
    runtime: { available: true },
    model: { available: true },
    aligner: { available: false, reason: "missing aligner" },
  });
  await expect(
    transcribeCaptionFile(path, 5, "auto", new AbortController().signal),
  ).rejects.toThrow("missing aligner");
  expect(fixture.run).not.toHaveBeenCalled();
});
