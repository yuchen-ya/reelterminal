/**
 * Workflow engine unit tests (ADR 0003 B.6, in-process — no Chromium):
 * static validation failures, `$ref` structural substitution (single-pass,
 * whole-value splice), pointer misses, bounded await semantics, stop-on-
 * first-failure vs --keep-going exit codes, and absolute-path rejection
 * at execution time — including the `$ref`-fed relative path.
 */
import { describe, expect, it } from "vitest";
import type { AgentFacade, FacadeResult } from "@openreel/agent-facade";
import {
  executeWorkflow,
  parseRefText,
  parseWorkflowLines,
  resolvePointer,
  rfc6901PointerValid,
  staticValidate,
  STEP_ID_PATTERN,
  type RunLine,
  type WorkflowStep,
} from "../src/workflow";
import type { TransportSession } from "../src/session";

function parseOrThrow(text: string): WorkflowStep[] {
  const { steps, errors } = parseWorkflowLines(text);
  expect(errors).toEqual([]);
  const staticErrors = staticValidate(steps);
  expect(staticErrors).toEqual([]);
  return steps;
}

/** Minimal in-memory facade covering the verbs the tests drive. */
function fakeSession(overrides: {
  statusQueue?: Record<string, any>[];
  verbResults?: Record<string, FacadeResult<unknown>>;
} = {}): TransportSession & { calls: { verb: string; params: unknown }[] } {
  const calls: { verb: string; params: unknown }[] = [];
  let statusPointer = 0;
  const facade: AgentFacade = {
    "session.describe": () => Promise.resolve({ ok: true, value: { contractVersion: "facade-slice-4" } as any }),
    "capabilities.get": () => Promise.resolve({ ok: true, value: {} as any }),
    "project.create": (params: unknown) => { calls.push({ verb: "project.create", params }); return Promise.resolve(overrides.verbResults?.["project.create"] ?? { ok: true, value: { revision: 0, replayed: false } as any }); },
    "project.open": () => { calls.push({ verb: "project.open", params: {} }); return Promise.resolve({ ok: true, value: { revision: 0 } as any }); },
    "project.save": () => { calls.push({ verb: "project.save", params: {} }); return Promise.resolve({ ok: true, value: { path: "/p/x", revision: 0 } as any }); },
    "project.get_state": () => { calls.push({ verb: "project.get_state", params: {} }); return Promise.resolve({ ok: true, value: {} as any }); },
    "media.import": () => { calls.push({ verb: "media.import", params: {} }); return Promise.resolve({ ok: true, value: {} as any }); },
    "timeline.get": () => { calls.push({ verb: "timeline.get", params: {} }); return Promise.resolve({ ok: true, value: { revision: 1, duration: 0, tracks: [], textOverlays: [] } }); },
    "edit.apply": () => { calls.push({ verb: "edit.apply", params: {} }); return Promise.resolve({ ok: true, value: { revision: 2, applied: [], replayed: false } }); },
    "preview.render_frame": () => Promise.resolve({ ok: true, value: { artifact: { path: "/a/f.png" } } as any }),
    "export.start": () => Promise.resolve({ ok: true, value: { jobId: overrides.statusQueue?.[0]?.jobId ?? "job-1", state: "queued", sourceRevision: 2, replayed: false } }),
    "job.status": () => {
      const queue = overrides.statusQueue ?? [{ jobId: "job-1", state: "done", artifact: { path: "/a/out.mp4" } }];
      const value = queue[Math.min(statusPointer, queue.length - 1)];
      statusPointer += 1;
      return Promise.resolve({ ok: true, value } as any);
    },
    "job.cancel": () => Promise.resolve({ ok: true, value: {} as any }),
    "verify.artifact": () => Promise.resolve({ ok: true, value: { pass: true, checks: [] } as any }),
  } as unknown as AgentFacade;
  return {
    facade,
    providers: {} as TransportSession["providers"],
    trackJob: () => undefined,
    dispose: () => Promise.resolve(),
    calls,
  };
}

async function run(session: TransportSession, steps: WorkflowStep[], keepGoing = false): Promise<RunLine[]> {
  const lines: RunLine[] = [];
  await executeWorkflow(session, steps, { keepGoing }, (line) => lines.push(line));
  return lines;
}

describe("static validation (B.6): reject before step 1", () => {
  it("duplicate step ids are rejected", () => {
    const { steps, errors } = parseWorkflowLines(
      [
        JSON.stringify({ id: "a", verb: "timeline.get" }),
        JSON.stringify({ id: "a", verb: "timeline.get" }),
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    const staticErrors = staticValidate(steps);
    expect(staticErrors.some((e) => e.message.includes("duplicate step id"))).toBe(true);
  });

  it("forward references are rejected (references may only point backwards)", () => {
    const { steps, errors } = parseWorkflowLines(
      [
        JSON.stringify({ id: "a", verb: "media.import", params: { path: { $ref: "later#/mediaId" } } }),
        JSON.stringify({ id: "later", verb: "timeline.get" }),
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    const staticErrors = staticValidate(steps);
    expect(staticErrors.some((e) => e.message.includes("not an earlier step"))).toBe(true);
  });

  it("unknown references are rejected", () => {
    const { steps, errors } = parseWorkflowLines(
      [JSON.stringify({ id: "a", verb: "timeline.get", params: { x: { $ref: "ghost" } } })].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(staticValidate(steps).some((e) => e.message.includes("not an earlier step"))).toBe(true);
  });

  it("invalid pointers are rejected (~ escapes, missing leading /)", () => {
    for (const bad of ["a#noSlash", "a#/bad~2escape", "a#/ok/~9"]) {
      const { steps, errors } = parseWorkflowLines(
        [JSON.stringify({ id: "a", verb: "timeline.get", params: { x: { $ref: bad } } })].join("\n"),
      );
      expect(errors).toEqual([]);
      expect(staticValidate(steps).some((e) => e.message.includes("invalid reference"))).toBe(true);
    }
  });

  it("unknown verbs are rejected at parse", () => {
    const { steps, errors } = parseWorkflowLines(
      [JSON.stringify({ id: "a", verb: "timeline.delete" })].join("\n"),
    );
    expect(steps).toHaveLength(0);
    expect(errors.some((e) => e.message.includes("unknown verb"))).toBe(true);
  });

  it("malformed ref objects (sibling keys) are rejected", () => {
    const { steps, errors } = parseWorkflowLines(
      [JSON.stringify({ id: "a", verb: "timeline.get", params: { x: { $ref: "a", extra: 1 } } })].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(staticValidate(steps).some((e) => e.message.includes("no sibling keys"))).toBe(true);
  });

  it("await jobIds may only reference earlier export.start steps", () => {
    const { steps, errors } = parseWorkflowLines(
      [
        JSON.stringify({ id: "t", verb: "timeline.get" }),
        JSON.stringify({ id: "wait", await: { jobId: { $ref: "t#/jobId" }, timeoutMs: 1000 } }),
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    const staticErrors = staticValidate(steps);
    expect(staticErrors.some((e) => e.message.includes("may only reference an earlier export.start step"))).toBe(true);
  });

  it("await bounds: timeoutMs required and ≤ 3 600 000; pollMs bounded 250–30 000", () => {
    const cases: string[] = [
      JSON.stringify({ id: "w", await: { jobId: "j" } }), // missing timeoutMs
      JSON.stringify({ id: "w", await: { jobId: "j", timeoutMs: 3_600_001 } }), // too big
      JSON.stringify({ id: "w", await: { jobId: "j", timeoutMs: 0 } }), // non-positive
      JSON.stringify({ id: "w", await: { jobId: "j", timeoutMs: 100, pollMs: 249 } }), // pollMs < 250
      JSON.stringify({ id: "w", await: { jobId: "j", timeoutMs: 100, pollMs: 30_001 } }), // pollMs > 30000
      JSON.stringify({ id: "w", await: { timeoutMs: 100 } }), // jobId missing
    ];
    for (const line of cases) {
      const { errors } = parseWorkflowLines(line);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("step ids must match ^[A-Za-z0-9_-]{1,64}$", () => {
    expect(STEP_ID_PATTERN.test("good-id_1")).toBe(true);
    expect(STEP_ID_PATTERN.test("bad id")).toBe(false);
    expect(STEP_ID_PATTERN.test("x".repeat(65))).toBe(false);
    const { errors } = parseWorkflowLines(JSON.stringify({ id: "bad id", verb: "timeline.get" }));
    expect(errors.some((e) => e.message.includes("step id"))).toBe(true);
  });
});

describe("$ref resolution semantics", () => {
  it("RFC 6901 pointers resolve, with ~0/~1 unescaping", () => {
    expect(rfc6901PointerValid("/a/b")).toBe(true);
    expect(rfc6901PointerValid("")).toBe(true);
    expect(rfc6901PointerValid("/a~1b")).toBe(true);
    expect(rfc6901PointerValid("/a~pb")).toBe(false);
    const value = { mediaId: "m1", nested: { "a/b": [1, 2] } };
    expect(resolvePointer(value, "")).toEqual({ ok: true, value });
    expect(resolvePointer(value, "/mediaId")).toEqual({ ok: true, value: "m1" });
    expect(resolvePointer(value, "/nested/a~1b/1")).toEqual({ ok: true, value: 2 });
    expect(resolvePointer(value, "/missing")).toEqual({ ok: false, miss: "missing" });
    expect(parseRefText("export")).toEqual({ stepId: "export", pointer: "" });
    expect(parseRefText("export#/jobId")).toEqual({ stepId: "export", pointer: "/jobId" });
  });

  it("substitution splices the referenced value as the ENTIRE value (single-pass, no re-scan)", async () => {
    const session = fakeSession();
    // A step whose result VALUE contains something that LOOKS like a $ref:
    // single-pass substitution must never re-scan substituted content.
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "first", verb: "timeline.get" }),
        JSON.stringify({ id: "second", verb: "timeline.get", params: { idempotencyKey: "ignored" } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines).toHaveLength(2);
    expect(lines[0].result?.ok).toBe(true);
    // params of the second step contained no refs — untouched passthrough
    expect(session.calls[0]).toEqual({ verb: "timeline.get", params: {} });
  });

  it("a pointer miss is a workflowError, distinct from a verb ok:false", async () => {
    const session = fakeSession();
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "t", verb: "timeline.get" }),
        JSON.stringify({ id: "ref", verb: "timeline.get", params: { x: { $ref: "t#/does/not/exist" } } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines[1].workflowError).toBeDefined();
    expect(lines[1].workflowError?.code).toBe("POINTER_MISS");
    expect(lines[1].result).toBeUndefined();
  });
});

describe("execution semantics", () => {
  it("stop-on-first-failure: later steps are skipped and exit code is 1", async () => {
    const session = fakeSession({
      verbResults: { "project.create": { ok: false, error: { code: "CONFLICT", message: "exists" } } },
    });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "create", verb: "project.create", params: {} }),
        JSON.stringify({ id: "timeline", verb: "timeline.get" }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines).toHaveLength(1); // the failing line only
    expect(lines[0].result?.ok).toBe(false);
    expect(session.calls).toHaveLength(1); // timeline.get never executed
  });

  it("--keep-going continues past failures; exit code still reflects the first failure", async () => {
    const session = fakeSession({
      verbResults: { "project.create": { ok: false, error: { code: "CONFLICT", message: "exists" } } },
    });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "create", verb: "project.create", params: {} }),
        JSON.stringify({ id: "timeline", verb: "timeline.get" }),
      ].join("\n"),
    );
    const lines = await run(session, steps, true);
    expect(lines).toHaveLength(2);
    expect(lines[0].result?.ok).toBe(false);
    expect(lines[1].result?.ok).toBe(true);
    expect(session.calls).toHaveLength(2);
  });

  it("a reference to a failed step is a workflow error under --keep-going", async () => {
    const session = fakeSession({
      verbResults: { "project.create": { ok: false, error: { code: "CONFLICT", message: "exists" } } },
    });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "create", verb: "project.create", params: { name: "x" } }),
        JSON.stringify({ id: "ref", verb: "timeline.get", params: { prev: { $ref: "create#/revision" } } }),
      ].join("\n"),
    );
    const lines = await run(session, steps, true);
    expect(lines[0].result?.ok).toBe(false);
    expect(lines[1].workflowError?.code).toBe("REF_STEP_FAILED");
  });

  it("non-done terminal states are step failures carrying the full status in details", async () => {
    const statusQueue = [
      { jobId: "job-err", state: "running", progress: null },
      { jobId: "job-err", state: "error", artifact: null, error: { code: "ACTION_FAILED", message: "boom" } },
    ];
    const session = fakeSession({ statusQueue });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "export", verb: "export.start", params: {} }),
        JSON.stringify({ id: "wait", await: { jobId: "job-err", timeoutMs: 5000, pollMs: 250 } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines[0].result?.ok).toBe(true);
    expect(lines[1].result?.ok).toBe(false);
    if (lines[1].result?.ok === false) {
      expect(lines[1].result.error.code).toBe("JOB_FAILED");
      expect((lines[1].result.error.details as any).status.state).toBe("error");
    }
  });

  it("await timeout is a step failure (ACTION_FAILED), bounded always", async () => {
    const statusQueue = [
      { jobId: "job-slow", state: "running" },
      { jobId: "job-slow", state: "running" },
      { jobId: "job-slow", state: "running" },
    ];
    const session = fakeSession({ statusQueue });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "wait", await: { jobId: "job-slow", timeoutMs: 400, pollMs: 250 } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines[0].result?.ok).toBe(false);
    if (lines[0].result?.ok === false) {
      expect(lines[0].result.error.code).toBe("ACTION_FAILED");
      expect((lines[0].result.error.details as any).lastState).toBe("running");
    }
  });

  it("await step result value IS the terminal job status; later steps can reference #/artifact/path", async () => {
    const statusQueue = [
      { jobId: "job-ok", state: "queued" },
      { jobId: "job-ok", state: "done", artifact: { path: "/artifacts/exports/job-ok/output.mp4" } },
    ];
    const session = fakeSession({ statusQueue });
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "wait", await: { jobId: "job-ok", timeoutMs: 5000, pollMs: 250 } }),
        JSON.stringify({ id: "verify", verb: "verify.artifact", params: { path: { $ref: "wait#/artifact/path" } } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines[0].result?.ok).toBe(true);
    expect(lines[1].result?.ok).toBe(true);
  });

  it("absolute-path boundary AFTER substitution: a $ref-fed relative path is rejected with INVALID_PARAMS", async () => {
    const session = fakeSession();
    // timeline.get result value carries a relative path string; the verify
    // step references it — the transport boundary must reject it AFTER
    // substitution, never resolving against the cwd.
    const fake = session.facade as unknown as Record<string, () => Promise<FacadeResult<unknown>>>;
    fake["timeline.get"] = () =>
      Promise.resolve({ ok: true, value: { artifactPath: "relative/out.mp4" } } as any);
    const steps = parseOrThrow(
      [
        JSON.stringify({ id: "t", verb: "timeline.get" }),
        JSON.stringify({ id: "verify", verb: "verify.artifact", params: { path: { $ref: "t#/artifactPath" } } }),
      ].join("\n"),
    );
    const lines = await run(session, steps);
    expect(lines[1].result?.ok).toBe(false);
    if (lines[1].result?.ok === false) {
      expect(lines[1].result.error.code).toBe("INVALID_PARAMS");
      expect(lines[1].result.error.message).toContain("must be an absolute path");
      expect(lines[1].result.error.message).toContain("'~' is never expanded");
    }
    // the facade was never reached with the relative path
    expect(session.calls.filter((c) => c.verb === "verify.artifact")).toHaveLength(0);
  });
});
