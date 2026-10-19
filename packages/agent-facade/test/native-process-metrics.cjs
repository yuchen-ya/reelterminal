// Opt-in test diagnostics. Forward the real spawn unchanged; record no argv,
// media paths, stdout/stderr or credentials. Never loaded by the application.
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { channel } = require("node:diagnostics_channel");

const prefix = process.env.REELTERMINAL_TEST_NATIVE_METRICS_FILE;
if (prefix) {
  const file = `${prefix}.${process.pid}.jsonl`;
  const originalSpawn = childProcess.spawn;
  let traced = 0;
  let writeMs = 0;
  let setupMs = 0;
  let normalizationObserved = false;
  function record(data) {
    const started = performance.now();
    try {
      appendFileSync(file, JSON.stringify({ label: process.env.REELTERMINAL_TEST_NATIVE_METRICS_LABEL ?? "native", ownerPid: process.pid, ...data }) + "\n");
    } catch {
      process.stderr.write("Native process diagnostic write failed\n");
    }
    writeMs += performance.now() - started;
  }
  channel("reelterminal.test.native-normalize").subscribe(data => record({ event: "checkpoint", ...data }));
  childProcess.spawn = function (...parameters) {
    const entered = performance.now();
    const args = Array.isArray(parameters[1]) ? parameters[1] : [];
    const executable = path.basename(String(parameters[0])).toLowerCase();
    const fixtureCall = args.some(arg => typeof arg === "string" && /audio-normalize-[^\\/]+/.test(arg));
    // Do not let unrelated earlier suites exhaust the trace cap with their
    // version probes before the normalization fixture has even started.
    normalizationObserved ||= fixtureCall;
    const selected = /^(ffmpeg|ffprobe)(\.exe)?$/.test(executable)
      && (fixtureCall || (normalizationObserved && args.includes("-version")));
    if (!selected || traced >= 128) return Reflect.apply(originalSpawn, this, parameters);
    traced++;
    const filter = args.find(arg => typeof arg === "string" && arg.includes("loudnorm="));
    const normalizedInput = String(args[args.indexOf("-i") + 1] ?? "").endsWith("normalized.wav");
    const stage = args.includes("-version") ? "version-probe" : executable.startsWith("ffprobe") ? "probe"
      : filter ? (normalizedInput ? "verify-loudness" : args.at(-1) === "-" ? "measure-loudness" : "normalize-second-pass")
      : args.includes("f32le") ? (normalizedInput ? "decode-output" : "decode-reference")
      : "fixture-or-format";
    const start = performance.now();
    setupMs += start - entered;
    const child = Reflect.apply(originalSpawn, this, parameters);
    const id = traced;
    let spawnedAt;
    let exitedAt;
    record({ event: "invoked", id, executable, stage, childPid: child.pid ?? null,
      startedUtc: new Date().toISOString(), spawnCallMs: performance.now() - start });
    child.once("spawn", () => {
      spawnedAt = performance.now();
      record({ event: "spawned", id, stage, childPid: child.pid, startupMs: spawnedAt - start });
    });
    child.once("error", error => record({ event: "spawn-error", id, stage, code: error.code ?? "unknown" }));
    child.once("exit", (code, signal) => {
      exitedAt = performance.now();
      record({ event: "exited", id, stage, code, signal,
        nativeLifetimeMs: spawnedAt === undefined ? null : exitedAt - spawnedAt,
        elapsedMs: exitedAt - start });
    });
    child.once("close", () => record({ event: "closed", id, stage,
      elapsedMs: performance.now() - start,
      drainAfterExitMs: exitedAt === undefined ? null : performance.now() - exitedAt,
      processesObserved: traced, recordWriteMsBeforeEvent: writeMs, wrapperSetupMs: setupMs, processCap: 128 }));
    return child;
  };
  syncBuiltinESMExports();
  process.once("exit", () => {
    if (traced) record({ event: "recorder-summary", processes: traced, recordWriteMs: writeMs, wrapperSetupMs: setupMs, processCap: 128 });
  });
}
