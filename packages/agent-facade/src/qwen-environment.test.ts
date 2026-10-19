import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("./media/audio-models-runner", () => ({ probeAudioModelsRuntime: async () => ({ available: true, details: {} }), requiredAudioModelPackages: () => [] }));
import { checkQwenCaptions } from "./media/qwen-captions";
import { writeAudioEnvironment } from "./media/audio-environment-config";
let directory: string, model: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "qwen-environment-"));
  model = join(directory, "model"); await mkdir(model);
  vi.stubEnv("REELTERMINAL_AUDIO_CONFIG", join(directory, "audio.json"));
  writeAudioEnvironment({ qwenPython: join(directory, "python.exe"), qwenModelDir: model, qwenAlignerModelDir: model });
  await writeFile(join(model, "config.json"), JSON.stringify({ architectures: ["Qwen3ASRForConditionalGeneration"] }));
  for (const file of ["tokenizer.json", "tokenizer_config.json", "processor_config.json", "chat_template.jinja"]) await writeFile(join(model, file), "{}");
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  await writeFile(join(model, "model.safetensors"), Buffer.concat([prefix, header, Buffer.alloc(4)]));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
it("accepts complete weight data but rejects an ASR directory used as an aligner", async () => {
  const report = await checkQwenCaptions();
  expect(report.model.available).toBe(true);
  expect(report.aligner.available).toBe(false);
});
it("does not report a partially downloaded model as available", async () => {
  await writeFile(join(model, "model.safetensors"), "partial");
  expect((await checkQwenCaptions()).model).toMatchObject({ available: false, reason: expect.stringContaining("Incomplete") });
});
