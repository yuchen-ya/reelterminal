import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudioEnvironment, writeAudioEnvironment } from "./media/audio-environment-config";
import { senseVoiceModelDir, speakerDiarizationModelDir, demucsCacheDir } from "./media/audio-models-runner";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "rt-environment-test-"));
  vi.stubEnv("REELTERMINAL_AUDIO_CONFIG", join(directory, "audio.json"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
describe("application audio configuration", () => {
  it("persists configuration and immediately updates model resolution without process restart", () => {
    expect(readAudioEnvironment()).toEqual({});
    const first = { python: join(directory, "python.exe"), senseVoiceModelDir: join(directory, "sensevoice"), speakerModelDir: join(directory, "speaker"), demucsCache: join(directory, "demucs") };
    writeAudioEnvironment(first);
    expect(readAudioEnvironment()).toEqual(first);
    expect(senseVoiceModelDir()).toBe(first.senseVoiceModelDir);
    expect(speakerDiarizationModelDir()).toBe(first.speakerModelDir);
    expect(demucsCacheDir()).toBe(first.demucsCache);
    writeAudioEnvironment({ senseVoiceModelDir: join(directory, "new-model") });
    expect(senseVoiceModelDir()).toBe(join(directory, "new-model"));
    expect(readAudioEnvironment().python).toBeUndefined();
  });
  it("rejects unknown fields and relative paths without changing the saved configuration", () => {
    writeAudioEnvironment({ python: join(directory, "python.exe") });
    expect(() => writeAudioEnvironment({ python: "python" })).toThrow("absolute path");
    expect(() => writeAudioEnvironment({ shell: "run me" })).toThrow("Unknown");
    expect(readAudioEnvironment().python).toBe(join(directory, "python.exe"));
  });
  it("surfaces corrupted configuration instead of silently using another environment", () => {
    writeFileSync(join(directory, "audio.json"), "{bad json");
    expect(() => readAudioEnvironment()).toThrow();
  });
});
