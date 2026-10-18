import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAudioModelProcess } from "./media/audio-models-runner";
import { FacadeError } from "./errors";

const PYTHON = process.env.REELTERMINAL_AUDIO_MODELS_PYTHON
  ?? (process.platform === "win32" ? "python" : "python3");
const PYTHON_AVAILABLE = spawnSync(PYTHON, ["-c", "print(1)"], { windowsHide: true }).status === 0;

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
