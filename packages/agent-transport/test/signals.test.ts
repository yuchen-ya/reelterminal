/** Signal disposal and stdout contracts of the real headless CLI. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromiumAvailable, ffmpegAvailable, makeRoots, spawnCli, type CliHandle, type Roots } from "./helpers";

let roots: Roots;
const runtimeHealthy = chromiumAvailable() && ffmpegAvailable();
beforeAll(async () => { roots = await makeRoots(); });
afterAll(async () => { await roots.cleanup(); });

function parseJsonLines(stdout: string): { ok: any[]; bad: string[] } {
  const ok: any[] = [];
  const bad: string[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    try { ok.push(JSON.parse(line)); } catch { bad.push(line); }
  }
  return { ok, bad };
}

async function waitFor(handle: CliHandle, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!ready()) {
    if (handle.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`workflow did not reach the signal checkpoint: ${handle.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function exportingWorkflow(): Promise<CliHandle> {
  const workflow = path.join(roots.projectRoot, "signal.jsonl");
  const steps = [
    { id: "create", verb: "project.create", params: { name: "Signal", settings: { width: 1280, height: 720, frameRate: 30 } } },
    { id: "edit", verb: "edit.apply", params: { expectedRevision: 0, ops: [
      { op: "track.add", trackType: "text", trackId: "t1" },
      { op: "text.create", trackId: "t1", text: "Signal disposal", startTime: 0, duration: 300 },
    ] } },
    { id: "preview", verb: "preview.render_frame", params: { timeSec: 1 } },
    { id: "export", verb: "export.start", params: {} },
    { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 600_000, pollMs: 1000 } },
  ];
  await writeFile(workflow, steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
  const handle = spawnCli(["run", "--workflow", workflow, "--artifact-root", roots.artifactRoot, "--log-level", "debug"]);
  await waitFor(handle, () => parseJsonLines(handle.stdout).ok.some((line) => line.id === "export" && line.result.ok));
  return handle;
}

// Windows terminates processes directly rather than delivering POSIX signals.
describe.skipIf(process.platform === "win32" || !runtimeHealthy)("run signal ownership", () => {
  it.each([["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const)("%s disposes the active session and exits %s", async (signal, code) => {
    const handle = await exportingWorkflow();
    try {
      handle.child.kill(signal);
      expect(await handle.exitCode).toBe(code);
      expect(handle.stderr).toContain("first signal — bounded disposal begins");
      expect(handle.stderr).toContain("provider runtime closed");
    } finally {
      if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    }
  }, 240_000);

  it("a second signal exits during disposal", async () => {
    const handle = await exportingWorkflow();
    try {
      handle.child.kill("SIGTERM");
      await waitFor(handle, () => handle.stderr.includes("bounded disposal begins"));
      handle.child.kill("SIGTERM");
      expect(await handle.exitCode).toBe(143);
      expect(handle.stderr).toContain("second signal — immediate hard exit");
    } finally {
      if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    }
  }, 240_000);
});

describe("CLI stdout purity", () => {
  it("run: stdout carries only step JSON lines with the documented shape", async () => {
    const workflow = path.join(roots.projectRoot, "purity.jsonl");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      workflow,
      [
        JSON.stringify({ id: "create", verb: "project.create", params: { name: "Purity", idempotencyKey: "purity-1" } }),
        JSON.stringify({ id: "timeline", verb: "timeline.get" }),
      ].join("\n") + "\n",
    );
    const handle = spawnCli([
      "run", "--workflow", workflow,
      "--media-root", roots.mediaRoot,
      "--artifact-root", roots.artifactRoot,
      "--project-root", roots.projectRoot,
      "--log-level", "debug",
    ]);
    const exitCode = await handle.exitCode;
    expect(exitCode).toBe(0);
    const { ok, bad } = parseJsonLines(handle.stdout);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(2);
    for (const line of ok as any[]) {
      expect(typeof line.index).toBe("number");
      expect(typeof line.id).toBe("string");
      expect(line.verb ?? line.await).toBeTruthy();
      expect(line.result).toBeDefined();
    }
    for (const line of handle.stderr.split("\n")) {
      if (line.trim().length === 0) continue;
      if (/^\[console\.(info|warn|error|log)\]/.test(line)) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 240_000);

  it("doctor: stdout is exactly one machine-readable JSON document", async () => {
    const handle = spawnCli(["doctor", "--log-level", "error"]);
    const exitCode = await handle.exitCode;
    expect([0, 1, 2]).toContain(exitCode);
    const { ok, bad } = parseJsonLines(handle.stdout);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(1);
    const report = ok[0] as any;
    expect(report.command).toBe("doctor");
    expect(report.verdict).toBeDefined();
    // stderr logs remain single-line JSON
    for (const line of handle.stderr.split("\n")) {
      if (line.trim().length === 0) continue;
      if (/^\[console\.(info|warn|error|log)\]/.test(line)) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 300_000);
});
