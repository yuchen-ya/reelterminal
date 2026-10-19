import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReelctl } from "./index";
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "rt-cli-env-")); vi.stubEnv("REELTERMINAL_AUDIO_CONFIG", join(directory, "saved.json")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
it("configures application audio through the CLI without contacting a live project", async () => {
  const output = vi.fn();
  const config = { python: join(directory, "python.exe"), qwenPython: join(directory, "qwen-python.exe"), qwenModelDir: join(directory, "qwen"), qwenAlignerModelDir: join(directory, "aligner") };
  const file = join(directory, "input.json"); writeFileSync(file, JSON.stringify(config));
  expect(await runReelctl(["environment", "set", "--file", file], { stdout: output })).toBe(0);
  expect(await runReelctl(["environment", "get"], { stdout: output })).toBe(0);
  expect(JSON.parse(output.mock.lastCall![0]).value.config).toEqual(config);
  await expect(runReelctl(["environment", "set"], { stdout: output })).rejects.toThrow("--file");
});

it("refuses remote media URLs and invalid ranges before invoking a model", async () => {
  await expect(runReelctl(["environment", "test", "--file", "speech.wav", "--duration", "5", "--engine", "whisper"])).rejects.toThrow("qwen or sensevoice");
  await expect(runReelctl(["environment", "test", "--file", "https://example.invalid/speech.wav", "--duration", "5"])).rejects.toThrow();
  await expect(runReelctl(["environment", "test", "--file", "speech.wav", "--duration", "121"])).rejects.toThrow("120 seconds");
});
