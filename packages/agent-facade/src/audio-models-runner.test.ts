import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAudioModelProcess, resolveAudioModelsScript } from "./media/audio-models-runner";
import { FacadeError } from "./errors";

const PYTHON = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON
  ?? (process.platform === "win32" ? "python" : "python3");
const PYTHON_AVAILABLE = spawnSync(PYTHON, ["-c", "print(1)"], { windowsHide: true }).status === 0;
if (process.env.EXPECT_AUDIO_MODELS_PYTHON === "1" && !PYTHON_AVAILABLE) {
  throw new Error("The audio worker regressions require a working Python interpreter");
}

const STUBS: Record<string, string> = {
  progress: `
import json, sys, time
request = json.load(sys.stdin)
print(json.dumps({"event": "progress", "percent": 0.25, "phase": "load"}))
sys.stdout.flush()
time.sleep(0.05)
print(json.dumps({"event": "progress", "percent": 0.75, "phase": "work"}))
sys.stdout.flush()
print(json.dumps({"event": "done", "result": {"task": request.get("task"), "text": "ok"}}))
`,
  error: `
import json, sys
json.load(sys.stdin)
print(json.dumps({"event": "error", "error": {"message": "model exploded", "traceback": "trace"}}))
`,
  crash: `
import json, sys
json.load(sys.stdin)
sys.stderr.write("native crash detail")
sys.exit(3)
`,
  cancel: `
import json, sys, time
json.load(sys.stdin)
print(json.dumps({"event": "progress", "percent": 0.1, "phase": "load"}))
sys.stdout.flush()
time.sleep(30)
`,
  invalid: `
import json, sys
json.load(sys.stdin)
print("not json at all")
`,
};

describe.skipIf(!PYTHON_AVAILABLE)("optional audio-model process isolation", () => {
  it("runs the unpacked script when the module lives inside app.asar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-package-"));
    try {
      const scriptDir = join(directory, "app.asar.unpacked", "dist", "python");
      await mkdir(scriptDir, { recursive: true });
      const script = join(scriptDir, "audio_models.py");
      await writeFile(script, STUBS.progress!);
      const resolved = await resolveAudioModelsScript(join(directory, "app.asar", "dist", "main"));
      expect(resolved).toBe(script);
      await expect(runAudioModelProcess(PYTHON, resolved!, { task: "probe" })).resolves.toMatchObject({ text: "ok" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("verifies first-download weights before model loading for all three backends", () => {
    const testScript = fileURLToPath(new URL("../test/audio-model-weights.py", import.meta.url));
    const result = spawnSync(PYTHON, ["-I", testScript], { windowsHide: true, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("preserves caption punctuation and rejects mismatched alignment in the Python helper", () => {
    const testScript = fileURLToPath(new URL("../test/caption-text.py", import.meta.url));
    const result = spawnSync(PYTHON, ["-I", "-B", testScript], { windowsHide: true, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["crash", "hang", "duplicate"])("rejects %s after a done event", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-terminal-"));
    try {
      const script = join(directory, "terminal.py");
      const ending = mode === "crash" ? "sys.exit(3)"
        : mode === "hang" ? "time.sleep(30)"
          : 'print(json.dumps({"event":"done","result":{}}), flush=True)';
      await writeFile(script, `import json, sys, time\njson.load(sys.stdin)\nprint(json.dumps({"event":"done","result":{}}), flush=True)\n${ending}\n`);
      await expect(runAudioModelProcess(PYTHON, script, { task: "probe" }, { timeoutMs: 1000 }))
        .rejects.toMatchObject({ code: "JOB_FAILED", message: expect.stringMatching(mode === "crash" ? /code 3/ : mode === "hang" ? /deadline/ : /duplicate/) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("streams progress and a terminal result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-proc-"));
    try {
      const script = join(directory, "progress.py");
      await writeFile(script, STUBS.progress!);
      const progress: number[] = [];
      const result = await runAudioModelProcess(PYTHON, script, { task: "probe" }, {
        timeoutMs: 30_000,
        onProgress: (percent) => progress.push(percent),
      });
      expect(progress).toEqual([0.25, 0.75]);
      expect(result).toMatchObject({ task: "probe", text: "ok" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("surfaces a worker error event with its traceback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-proc-"));
    try {
      const script = join(directory, "error.py");
      await writeFile(script, STUBS.error!);
      await expect(runAudioModelProcess(PYTHON, script, { task: "probe" }, { timeoutMs: 30_000 }))
        .rejects.toMatchObject({ code: "JOB_FAILED", message: expect.stringContaining("model exploded"), details: { workerTraceback: "trace" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails a crash without a terminal event and keeps stderr for diagnosis", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-proc-"));
    try {
      const script = join(directory, "crash.py");
      await writeFile(script, STUBS.crash!);
      await expect(runAudioModelProcess(PYTHON, script, { task: "probe" }, { timeoutMs: 30_000 }))
        .rejects.toMatchObject({ code: "JOB_FAILED", message: expect.stringContaining("exited (code 3)") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects invalid stdout instead of guessing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-proc-"));
    try {
      const script = join(directory, "invalid.py");
      await writeFile(script, STUBS.invalid!);
      await expect(runAudioModelProcess(PYTHON, script, { task: "probe" }, { timeoutMs: 30_000 }))
        .rejects.toBeInstanceOf(FacadeError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("kills the process on abort and reports cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rt-model-proc-"));
    try {
      const script = join(directory, "cancel.py");
      await writeFile(script, STUBS.cancel!);
      const controller = new AbortController();
      const started = Date.now();
      const running = runAudioModelProcess(PYTHON, script, { task: "probe" }, {
        timeoutMs: 60_000,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });
      await expect(running).rejects.toMatchObject({ code: "JOB_FAILED", message: "Cancelled" });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
