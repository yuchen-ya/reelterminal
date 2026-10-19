import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { afterAll, expect, it, vi } from "vitest";
import { createNativeTestScope } from "../native-test-scope";
import { resolveToolFfmpeg, runToolProcess } from "../../src/media/ffmpeg-bin";

const state = vi.hoisted(() => ({
  label: "", live: new Set<ChildProcess>(), events: [] as string[], lateCompletion: false, timeoutReason: "",
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { scopeNativeSpawn } = await import("../native-test-scope");
  const ownedSpawn = scopeNativeSpawn(actual.spawn);
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(ownedSpawn, actual, args);
    const label = state.label;
    if (label) {
      state.live.add(child);
      state.events.push(`${label}:spawn`);
      child.once("close", () => { state.live.delete(child); state.events.push(`${label}:close`); });
    }
    return child;
  } };
});

const binaries = await resolveToolFfmpeg();
if (!binaries) throw new Error("Real FFmpeg is required for native cleanup probes");
const slowArgs = ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i",
  "anullsrc=r=48000:cl=mono", "-t", "60", "-stats_period", "0.05", "-progress", "pipe:1", "-f", "null", "-"];

it("retains the real Vitest timeout while closing native work", async context => {
  state.label = "timeout";
  context.signal.addEventListener("abort", () => { state.timeoutReason = context.signal.reason?.message ?? ""; }, { once: true });
  const run = createNativeTestScope(context);
  await run(signal => {
    signal.addEventListener("abort", () => state.events.push("timeout:abort"), { once: true });
    // Deliberately omit the tool signal to cover uncancellable version/preflight
    // calls too: test ownership must still kill and await the real child.
    return runToolProcess(binaries.ffmpeg, slowArgs, { onStdoutChunk: () => {
      if (!state.events.includes("timeout:ready")) state.events.push("timeout:ready");
    } });
  });
  state.lateCompletion = true;
}, 2_000);

it("retains an assertion failure while closing owned background work", async context => {
  state.label = "failure";
  const run = createNativeTestScope(context);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const operation = run(signal => {
    signal.addEventListener("abort", () => state.events.push("failure:abort"), { once: true });
    return runToolProcess(binaries.ffmpeg, slowArgs, { signal, onStdoutChunk: () => {
      if (!state.events.includes("failure:ready")) state.events.push("failure:ready");
      ready();
    } });
  });
  await Promise.race([started, operation.then(() => { throw new Error("Native probe ended prematurely"); })]);
  expect(state.live.size).toBe(1);
  expect("deliberate native assertion failure").toBe("must retain the failure");
});

it("starts the next case only after both native processes closed", () => {
  state.label = "";
  expect(state.live.size).toBe(0);
  expect(state.lateCompletion).toBe(false);
  for (const label of ["timeout", "failure"]) {
    expect(state.events).toContain(`${label}:ready`);
    expect(state.events.indexOf(`${label}:abort`)).toBeGreaterThan(state.events.indexOf(`${label}:ready`));
    expect(state.events.indexOf(`${label}:close`)).toBeGreaterThan(state.events.indexOf(`${label}:abort`));
  }
  expect(state.events.indexOf("failure:spawn")).toBeGreaterThan(state.events.indexOf("timeout:close"));
});

afterAll(async () => {
  const leakedBeforeFallback = state.live.size;
  // Even a regression in the scope must not leave this deliberately failing
  // probe's children behind. The outer test rejects any fallback cleanup.
  await Promise.all([...state.live].map(child => new Promise<void>(resolve => {
    child.once("close", resolve);
    child.kill("SIGKILL");
  })));
  const destination = process.env.REELTERMINAL_TEST_SCOPE_EVIDENCE;
  if (!destination) throw new Error("Probe evidence destination is required");
  await writeFile(destination, JSON.stringify({ events: state.events, lateCompletion: state.lateCompletion,
    timeoutReason: state.timeoutReason, leakedBeforeFallback, liveAfterCleanup: state.live.size }));
});
