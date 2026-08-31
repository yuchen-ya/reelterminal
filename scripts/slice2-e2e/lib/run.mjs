/**
 * Path (a) — the Pi-class `run` path: the runner authors Appendix-B.6 JSONL
 * workflows and invokes the REAL built `agent-video run`. One invocation is
 * one fresh facade session; per Appendix D step 6, deliberately-failing
 * probes are their own run invocations (or one --keep-going run whose
 * nonzero exit is the expected outcome).
 *
 * Every invocation's workflow text, stdout step lines, exit code, and stderr
 * tail land in the recorder transcript.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Execute one workflow. Resolves to { exitCode, lines, stderr } where `lines`
 * are the parsed stdout step records ({index,id,verb|await,result|workflowError}).
 */
export async function runWorkflow({ cliPath, recorder, label, steps, env = {}, flags = [], cwd, scratchDir, onLine }) {
  const workflowPath = path.join(scratchDir ?? "/tmp", `wf-${randomUUID()}.jsonl`);
  const text = steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
  await writeFile(workflowPath, text, "utf8");
  await recorder?.record("run-invocation", { label, workflowPath, workflow: steps });

  const child = spawn(
    process.execPath,
    [cliPath, "run", "--workflow", workflowPath, ...flags],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = [];
  let stdoutBuffer = "";
  const lineWaiters = [];
  let exitResolve;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        lines.push({ raw: line });
        void recorder?.record("run-stdout", { label, nonJsonLine: line });
        continue;
      }
      lines.push(parsed);
      void recorder?.record("run-step", { label, line: parsed });
      const waiter = lineWaiters.shift();
      if (waiter) waiter(parsed);
      if (onLine) onLine(parsed);
    }
  });
  child.on("close", (code) => {
    exitResolve(code);
    const waiter = lineWaiters.shift();
    if (waiter) waiter(null);
  });

  const exitCode = await exitPromise;
  await recorder?.record("run-exit", { label, exitCode, stepCount: lines.length, stderrTail: stderr.slice(-4000) });
  return { exitCode, lines, stderr, workflowPath };
}

/** Wait until a stdout line matching `predicate` appears, or the process exits. */
export function waitForLine(handle, predicate, timeoutMs = 600_000) {
  const existing = handle.lines.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = handle.lineWaiters.indexOf(entry);
      if (index !== -1) handle.lineWaiters.splice(index, 1);
      reject(new Error(`timed out waiting for a matching workflow line`));
    }, timeoutMs);
    const entry = (line) => {
      clearTimeout(timer);
      if (line === null) {
        reject(new Error(`run exited (code ${handle.exitCode}) before the expected line appeared`));
        return;
      }
      if (predicate(line)) resolve(line);
      else handle.lineWaiters.unshift(entry);
    };
    handle.lineWaiters.push(entry);
  });
}

/**
 * Long-running run invocation for scenario 2's kill variants: returns a
 * handle whose stdout lines stream through `waitForLine`.
 */
export function spawnWorkflow({ cliPath, recorder, label, steps, env = {}, flags = [], cwd, scratchDir }) {
  const workflowPath = path.join(scratchDir ?? "/tmp", `wf-${randomUUID()}.jsonl`);
  const text = steps.map((step) => JSON.stringify(step)).join("\n") + "\n";
  void writeFile(workflowPath, text, "utf8");
  void recorder?.record("run-invocation", { label, workflowPath, workflow: steps });

  const child = spawn(
    process.execPath,
    [cliPath, "run", "--workflow", workflowPath, ...flags],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = [];
  const lineWaiters = [];
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        lines.push({ raw: line });
        void recorder?.record("run-step", { label, nonJsonLine: line });
        continue;
      }
      lines.push(parsed);
      void recorder?.record("run-step", { label, line: parsed });
      const waiter = lineWaiters.shift();
      if (waiter) waiter(parsed);
    }
  });
  let exitResolve;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });
  child.on("close", (code, signal) => {
    exitResolve({ code, signal });
    const waiter = lineWaiters.shift();
    if (waiter) waiter(null);
  });
  return {
    child,
    lines,
    lineWaiters,
    stderr: () => stderr,
    exitPromise,
    workflowPath,
  };
}
