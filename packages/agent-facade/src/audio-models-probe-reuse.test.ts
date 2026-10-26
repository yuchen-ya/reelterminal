import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAudioModelsProbeCache,
  probeAudioModelsRuntime,
  requiredAudioModelPackages,
} from "./media/audio-models-runner";

const PYTHON = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON
  ?? (process.platform === "win32" ? "python" : "python3");
const PYTHON_AVAILABLE = spawnSync(PYTHON, ["-c", "print(1)"], { windowsHide: true }).status === 0;
// A second spelling of the same interpreter (absolute path) exercises the
// "different interpreter string probes separately" branch without needing a
// second installed environment.
const REAL_PYTHON = PYTHON_AVAILABLE
  ? String(spawnSync(PYTHON, ["-c", "import sys; print(sys.executable)"], { windowsHide: true, encoding: "utf8" }).stdout).trim()
  : "";
const DISTINCT_PYTHON = REAL_PYTHON && REAL_PYTHON.toLowerCase() !== PYTHON.toLowerCase() ? REAL_PYTHON : "";

/**
 * Stub audio_models.py that records every spawn (and the requested task) in
 * spawn-count.txt and reports import availability for every package the
 * facade can ask about.
 */
function stubScript(demucsAvailable = true): string {
  return `
import json, os, sys
request = json.load(sys.stdin)
counter = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spawn-count.txt")
with open(counter, "a", encoding="utf-8") as handle:
    handle.write(str(request.get("task")) + "\\n")
packages = {
    "funasr": True, "modelscope": True, "torch": True, "soundfile": True, "numpy": True,
    "transformers": True, "librosa": True, "deepfilternet": True,
    "demucs": ${demucsAvailable ? "True" : "False"},
}
print(json.dumps({"event": "done", "result": {"task": request.get("task"), "python": "stub", "packages": packages, "versions": {}}}))
`;
}

const ENV_KEYS = [
  "REELTERMINAL_AUDIO_MODELS_PYTHON",
  "REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR",
  "REELTERMINAL_SEPARATION_PYTHON",
  "REELTERMINAL_PYTHON_PATH",
] as const;

describe.skipIf(!PYTHON_AVAILABLE)("audio-model runtime probe reuse", () => {
  const savedEnv = new Map<string, string | undefined>();
  let directory: string;

  const spawnCount = async (): Promise<string[]> => {
    try {
      return (await readFile(join(directory, "spawn-count.txt"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    directory = await mkdtemp(join(tmpdir(), "rt-audio-probe-"));
    await writeFile(join(directory, "audio_models.py"), stubScript(), "utf8");
    process.env.REELTERMINAL_AUDIO_MODELS_PYTHON = PYTHON;
    process.env.REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR = directory;
    delete process.env.REELTERMINAL_SEPARATION_PYTHON;
    clearAudioModelsProbeCache();
  });

  afterEach(async () => {
    clearAudioModelsProbeCache();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("spawns the shared interpreter once for the capabilities audio-domain probe sequence", async () => {
    // Mirrors the three sequential probeAudioModelsRuntime calls in
    // capabilities.ts for an audio-domain request: default transcript
    // packages, diarization packages, separation packages + task.
    const transcript = await probeAudioModelsRuntime();
    const diarize = await probeAudioModelsRuntime(requiredAudioModelPackages("diarize"));
    const separate = await probeAudioModelsRuntime(requiredAudioModelPackages("separate"), "separate");

    expect(transcript).toMatchObject({ available: true });
    expect(diarize).toMatchObject({ available: true });
    expect(separate).toMatchObject({ available: true });
    if (!transcript.available || !diarize.available || !separate.available) return;
    expect(transcript.details.python).toBe(PYTHON);
    expect(diarize.details.python).toBe(PYTHON);
    expect(separate.details.python).toBe(PYTHON);
    const spawns = await spawnCount();
    expect(spawns).toEqual(["probe"]);
  });

  it("keeps per-domain availability honest from the single shared probe", async () => {
    await writeFile(join(directory, "audio_models.py"), stubScript(false), "utf8");

    const transcript = await probeAudioModelsRuntime();
    const diarize = await probeAudioModelsRuntime(requiredAudioModelPackages("diarize"));
    const separate = await probeAudioModelsRuntime(requiredAudioModelPackages("separate"), "separate");

    expect(transcript).toMatchObject({ available: true });
    expect(diarize).toMatchObject({ available: true });
    expect(separate).toMatchObject({ available: false });
    if (separate.available) return;
    expect(separate.reason).toContain("demucs");
    expect(await spawnCount()).toEqual(["probe"]);
  });

  it.skipIf(!DISTINCT_PYTHON)("probes a configured separation interpreter separately", async () => {
    process.env.REELTERMINAL_SEPARATION_PYTHON = DISTINCT_PYTHON;

    const transcript = await probeAudioModelsRuntime();
    const diarize = await probeAudioModelsRuntime(requiredAudioModelPackages("diarize"));
    const separate = await probeAudioModelsRuntime(requiredAudioModelPackages("separate"), "separate");

    expect(transcript).toMatchObject({ available: true });
    expect(diarize).toMatchObject({ available: true });
    expect(separate).toMatchObject({ available: true });
    if (!transcript.available || !separate.available) return;
    expect(transcript.details.python).toBe(PYTHON);
    expect(separate.details.python).toBe(DISTINCT_PYTHON);
    expect(await spawnCount()).toEqual(["probe", "probe"]);
  });
});
