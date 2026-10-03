/**
 * Tests for the OpenCV worker plumbing. The JSON protocol, script lookup and
 * abort/timeout behavior run against Node stubs (no Python needed); the real
 * interpreter probe is skipped honestly when no cv2-capable interpreter is
 * configured on the machine.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runToolProcess } from "./ffmpeg-bin";
import {
  opencvToolPreflight,
  resolveOpenCvRuntime,
  resolveOpenCvScript,
  runWorkerProtocol,
} from "./opencv-runner";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stub "worker" in Node with the same stdin/stdout JSON protocol. */
async function writeStubWorker(dir: string): Promise<string> {
  const stub = join(dir, "stub-worker.js");
  await writeFile(stub, `
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  const req = JSON.parse(data);
  if (req.mode === "ok") {
    process.stdout.write(JSON.stringify({ ok: true, result: { echo: req } }));
  } else if (req.mode === "scriptfail") {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "bad", message: "estimation boom" } }));
  } else if (req.mode === "garbage") {
    process.stdout.write("definitely not json");
  } else if (req.mode === "slow") {
    setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, result: {} })), 30000);
  } else {
    process.exit(3);
  }
});
`, "utf8");
  return stub;
}

describe("stdin plumbing (runToolProcess input)", () => {
  it("feeds the input string to the child's stdin and captures stdout", async () => {
    const { stdout } = await runToolProcess(
      process.execPath,
      ["-e", 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("got:"+d));'],
      { input: "hello stdin" },
    );
    expect(stdout.toString("utf8")).toBe("got:hello stdin");
  });

  it("keeps the real spawn path working end-to-end for the worker protocol", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-worker-"));
    dirs.push(dir);
    const stub = await writeStubWorker(dir);
    // Same code path runWorkerProtocol uses, invoked with the Node stub in
    // place of `python -I script`: stdin JSON in, stdout JSON out.
    const { stdout } = await runToolProcess(
      process.execPath, [stub],
      { input: JSON.stringify({ mode: "ok" }) },
    );
    expect(JSON.parse(stdout.toString("utf8"))).toEqual({ ok: true, result: { echo: { mode: "ok" } } });
  });
});

describe("worker protocol", () => {
  it("invokes the injectable spawn with the request and returns its parsed result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-worker-"));
    dirs.push(dir);
    const seen: { exe: string; script: string; request: Record<string, unknown> }[] = [];
    const response = await runWorkerProtocol(
      process.execPath,
      join(dir, "worker.js"),
      { mode: "ok", n: 7 },
      {},
      async (exe, script, request) => {
        seen.push({ exe, script, request });
        return { stdout: Buffer.from(JSON.stringify({ ok: true, result: { got: request.mode, n: request.n } })), stderr: "" };
      },
    );
    expect(seen).toEqual([{ exe: process.execPath, script: join(dir, "worker.js"), request: { mode: "ok", n: 7 } }]);
    expect(response.result).toEqual({ got: "ok", n: 7 });
    expect(response.stderr).toBe("");
  });

  it("surfaces a script-reported failure as JOB_FAILED with the script's message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-worker-"));
    dirs.push(dir);
    const promise = runWorkerProtocol(
      process.execPath, join(dir, "w.js"), { mode: "scriptfail" }, {},
      async () => ({ stdout: Buffer.from(JSON.stringify({ ok: false, error: { code: "bad", message: "estimation boom" } })), stderr: "some stderr" }),
    );
    await expect(promise).rejects.toThrow(/estimation boom/);
  });

  it("surfaces invalid JSON as JOB_FAILED with a stderr tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-worker-"));
    dirs.push(dir);
    const promise = runWorkerProtocol(
      process.execPath, join(dir, "w.js"), { mode: "garbage" }, {},
      async () => ({ stdout: Buffer.from("definitely not json"), stderr: "traceback tail" }),
    );
    await expect(promise).rejects.toThrow(/invalid JSON/);
  });

  it("kills the worker on abort and rejects with the cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-worker-"));
    dirs.push(dir);
    const stub = await writeStubWorker(dir);
    const controller = new AbortController();
    // Injectable spawn running the Node stub without python's -I flag —
    // the abort/kill behavior under test lives in runToolProcess either way.
    const promise = runWorkerProtocol(
      process.execPath, stub, { mode: "slow" }, { signal: controller.signal },
      (exe, script, request, options) => runToolProcess(exe, [script], { ...options, input: JSON.stringify(request) }),
    ).then(() => "resolved", (error: Error) => error.message);
    setTimeout(() => controller.abort(), 150);
    const message = await promise;
    expect(message).toMatch(/[Cc]ancelled|timed out/);
  });
});

describe("script + runtime resolution", () => {
  it("locates the bundled align.py in the package source tree", async () => {
    const script = await resolveOpenCvScript("align.py");
    expect(script).toBeTruthy();
    expect(script!).toMatch(/[\\/]python[\\/]align\.py$/);
    expect(await resolveOpenCvScript("does-not-exist.py")).toBeNull();
  });

  it("prefers an explicit REELTERMINAL_OPENCV_SCRIPT_DIR override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencv-scripts-"));
    dirs.push(dir);
    const override = join(dir, "align.py");
    await writeFile(override, "# override\n", "utf8");
    const previous = process.env.REELTERMINAL_OPENCV_SCRIPT_DIR;
    process.env.REELTERMINAL_OPENCV_SCRIPT_DIR = dir;
    try {
      expect(await resolveOpenCvScript("align.py")).toBe(override);
    } finally {
      if (previous === undefined) delete process.env.REELTERMINAL_OPENCV_SCRIPT_DIR;
      else process.env.REELTERMINAL_OPENCV_SCRIPT_DIR = previous;
    }
  });

  it("does not claim a tool is available when its requested worker is missing", async () => {
    const result = await opencvToolPreflight(["missing-tool-worker.py"]);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("probes the real interpreter only when one can import cv2+numpy", async () => {
    const pre = await opencvToolPreflight();
    if (!pre.available) {
      expect(pre.reason).toMatch(/cv2|opencv-python|REELTERMINAL_OPENCV_PYTHON/i);
      expect(await resolveOpenCvRuntime()).toBeNull();
      return;
    }
    expect(pre.details.python.length).toBeGreaterThan(0);
    expect(pre.details.cv2Version).toMatch(/^\d+\.\d+/);
    expect(pre.details.scriptDir).toMatch(/[\\/]python$/);
  });
});
