/**
 * `agent-video run` — the B.6 executable workflow format (ADR 0003
 * Decision 3 / Appendix B.6).
 *
 * JSONL, one step per line, two step kinds:
 *   {"id","verb","params"}                     — a facade verb call
 *   {"id","await":{jobId,timeoutMs,pollMs?}}   — a bounded job wait
 *
 * `$ref` structural substitution: `{"$ref":"stepId"}` / `{"$ref":"stepId#/
 * <RFC6901 pointer>"}` splices that step's `result.value` in — a reference
 * object IS the entire value at its position. Single-pass by construction
 * (substituted values are never re-scanned); no string interpolation, no
 * expression language, no eval. Everything is statically validated BEFORE
 * step 1 runs (exit 2 on any violation, no steps executed).
 *
 * Output: one JSON line per executed step on stdout —
 *   {index, id, verb|await, result}      — verb result or await result
 *   {index, id, workflowError}           — pointer miss / ref to a
 *                                          failed/skipped step (distinct
 *                                          from a verb's ok:false)
 * Exit codes: 0 all ok · 1 first step failure (default stop-on-first-
 * failure AND --keep-going) · 2 invocation/static error.
 */
import { isAbsolute } from "node:path";

import type { AgentFacade, FacadeResult } from "@openreel/agent-facade";

import { parseArgv, resolveConfig, refuseStartup, type TransportConfig } from "./config";
import { logError, logInfo, setLogLevel } from "./log";
import { findRelativePathViolations, relativePathMessage } from "./paths";
import { createTransportSession, isTerminalJobState, type TransportSession } from "./session";

/* ------------------------------------------------------------------ */
/* Limits (B.6)                                                        */
/* ------------------------------------------------------------------ */

export const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_AWAIT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_POLL_MS = 2000;
export const MIN_POLL_MS = 250;
export const MAX_POLL_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Workflow shape                                                      */
/* ------------------------------------------------------------------ */

export interface AwaitSpec {
  readonly jobId: unknown;
  readonly timeoutMs?: unknown;
  readonly pollMs?: unknown;
}

export type WorkflowStep =
  | {
      readonly index: number;
      readonly line: number;
      readonly id: string;
      readonly kind: "verb";
      readonly verb: string;
      readonly params: unknown;
    }
  | {
      readonly index: number;
      readonly line: number;
      readonly id: string;
      readonly kind: "await";
      readonly spec: AwaitSpec;
    };

export interface StaticError {
  readonly line: number;
  readonly message: string;
}

/* ------------------------------------------------------------------ */
/* $ref parsing (RFC 6901 pointers, single-hop)                        */
/* ------------------------------------------------------------------ */

/** A `{"$ref": "<stepId>"|"<stepId>#/<pointer>"}` object — exactly this. */
export interface RefObject {
  readonly $ref: string;
}

export function isRefObject(value: unknown): value is RefObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>).$ref === "string"
  );
}

/** Object containing a $ref key mixed with other keys — a static error. */
export function hasStrayRefKey(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "$ref" in value &&
    Object.keys(value).length > 1
  );
}

export interface ParsedRef {
  readonly stepId: string;
  /** RFC 6901 pointer; "" = the whole result.value. */
  readonly pointer: string;
}

export function parseRefText(refText: string): ParsedRef | null {
  const hash = refText.indexOf("#");
  const stepId = hash === -1 ? refText : refText.slice(0, hash);
  if (!STEP_ID_PATTERN.test(stepId)) return null;
  const pointer = hash === -1 ? "" : refText.slice(hash + 1);
  if (pointer !== "" && !pointer.startsWith("/")) return null;
  if (!rfc6901PointerValid(pointer)) return null;
  return { stepId, pointer };
}

/** Every `~` must introduce a valid escape (~0 or ~1). */
export function rfc6901PointerValid(pointer: string): boolean {
  if (pointer === "") return true;
  for (let i = 0; i < pointer.length; i += 1) {
    if (pointer[i] === "~") {
      const next = pointer[i + 1];
      if (next !== "0" && next !== "1") return false;
      i += 1;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Static validation (before step 1 runs)                              */
/* ------------------------------------------------------------------ */

/** Collect every $ref text at or under `value`; false when a malformed
 * ref object (a $ref key with sibling keys) was seen. Refs are leaves —
 * their string value is never scanned (single-pass by construction). */
function collectRefs(value: unknown, out: string[]): boolean {
  if (hasStrayRefKey(value)) return false;
  if (isRefObject(value)) {
    out.push(value.$ref);
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!collectRefs(item, out)) return false;
    }
    return true;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (!collectRefs(item, out)) return false;
    }
  }
  return true;
}

export function parseWorkflowLines(text: string): {
  steps: WorkflowStep[];
  errors: StaticError[];
} {
  const steps: WorkflowStep[] = [];
  const errors: StaticError[] = [];
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex].trim();
    if (raw.length === 0) continue;
    const lineNo = lineIndex + 1;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(raw);
    } catch (error) {
      errors.push({
        line: lineNo,
        message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (typeof parsedLine !== "object" || parsedLine === null || Array.isArray(parsedLine)) {
      errors.push({ line: lineNo, message: "step must be a JSON object" });
      continue;
    }
    const record = parsedLine as Record<string, unknown>;
    let unknownField = false;
    for (const key of Object.keys(record)) {
      if (key !== "id" && key !== "verb" && key !== "params" && key !== "await") {
        errors.push({ line: lineNo, message: `unknown step field "${key}"` });
        unknownField = true;
      }
    }
    if (unknownField) continue;
    const id = record.id;
    if (typeof id !== "string" || !STEP_ID_PATTERN.test(id)) {
      errors.push({
        line: lineNo,
        message: `step id must match ^[A-Za-z0-9_-]{1,64}$ (got ${JSON.stringify(id)})`,
      });
      continue;
    }
    const hasVerb = record.verb !== undefined;
    const hasAwait = record.await !== undefined;
    if (hasVerb === hasAwait) {
      errors.push({
        line: lineNo,
        message: `step "${id}" must carry exactly one of "verb" or "await"`,
      });
      continue;
    }
    if (hasVerb) {
      const verb = record.verb;
      if (
        typeof verb !== "string" ||
        !(FACADE_CALL_KEYS as readonly string[]).includes(verb)
      ) {
        errors.push({
          line: lineNo,
          message: `step "${id}": unknown verb ${JSON.stringify(verb)} — expected one of the 14 facade verbs`,
        });
        continue;
      }
      let params: unknown = {};
      if (record.params !== undefined) {
        params = record.params;
        if (typeof params !== "object" || params === null || Array.isArray(params)) {
          errors.push({ line: lineNo, message: `step "${id}": params must be an object` });
          continue;
        }
      }
      steps.push({ index: steps.length, line: lineNo, id, kind: "verb", verb, params });
      continue;
    }
    // await step
    const specRaw = record.await;
    if (typeof specRaw !== "object" || specRaw === null || Array.isArray(specRaw)) {
      errors.push({ line: lineNo, message: `step "${id}": await must be an object` });
      continue;
    }
    const spec = specRaw as Record<string, unknown>;
    let unknownAwaitField = false;
    for (const key of Object.keys(spec)) {
      if (key !== "jobId" && key !== "timeoutMs" && key !== "pollMs") {
        errors.push({
          line: lineNo,
          message: `step "${id}": unknown await field "${key}"`,
        });
        unknownAwaitField = true;
      }
    }
    if (unknownAwaitField) continue;
    if (spec.jobId === undefined) {
      errors.push({ line: lineNo, message: `step "${id}": await.jobId is required` });
      continue;
    }
    if (hasStrayRefKey(spec.jobId)) {
      errors.push({
        line: lineNo,
        message: `step "${id}": await.jobId reference object must be exactly {"$ref": "..."}`,
      });
      continue;
    }
    if (typeof spec.jobId !== "string" && !isRefObject(spec.jobId)) {
      errors.push({
        line: lineNo,
        message: `step "${id}": await.jobId must be a literal string or a single {"$ref"} into an earlier export.start step`,
      });
      continue;
    }
    if (spec.timeoutMs === undefined) {
      errors.push({
        line: lineNo,
        message: `step "${id}": await.timeoutMs is required (bounded, always)`,
      });
      continue;
    }
    if (
      typeof spec.timeoutMs !== "number" ||
      !Number.isFinite(spec.timeoutMs) ||
      !Number.isInteger(spec.timeoutMs) ||
      spec.timeoutMs <= 0
    ) {
      errors.push({
        line: lineNo,
        message: `step "${id}": await.timeoutMs must be a positive integer number of ms`,
      });
      continue;
    }
    if (spec.timeoutMs > MAX_AWAIT_TIMEOUT_MS) {
      errors.push({
        line: lineNo,
        message: `step "${id}": await.timeoutMs must be <= ${MAX_AWAIT_TIMEOUT_MS} ms (got ${spec.timeoutMs})`,
      });
      continue;
    }
    if (spec.pollMs !== undefined) {
      if (
        typeof spec.pollMs !== "number" ||
        !Number.isInteger(spec.pollMs) ||
        spec.pollMs < MIN_POLL_MS ||
        spec.pollMs > MAX_POLL_MS
      ) {
        errors.push({
          line: lineNo,
          message: `step "${id}": await.pollMs must be an integer in [${MIN_POLL_MS}, ${MAX_POLL_MS}] (got ${JSON.stringify(spec.pollMs)})`,
        });
        continue;
      }
    }
    steps.push({
      index: steps.length,
      line: lineNo,
      id,
      kind: "await",
      spec: spec as unknown as AwaitSpec,
    });
  }
  return { steps, errors };
}

/**
 * Full static validation (B.6): IDs unique; every $ref names an existing
 * EARLIER step; pointers syntactically valid; every verb known; every
 * await.jobId a literal string or a single-hop $ref into an EARLIER
 * export.start step's result. (Verb knowledge and await bounds are
 * enforced during parse; this pass adds ordering + reference structure.)
 */
export function staticValidate(steps: readonly WorkflowStep[]): readonly StaticError[] {
  const errors: StaticError[] = [];
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) {
      errors.push({
        line: step.line,
        message: `duplicate step id "${step.id}" — ids are unique within a workflow`,
      });
    }
    seenIds.add(step.id);
  }
  for (const step of steps) {
    const earlierIds = new Set(
      steps.filter((s) => s.index < step.index).map((s) => s.id),
    );
    const refTexts: string[] = [];
    let malformed = false;
    if (step.kind === "verb") {
      malformed = !collectRefs(step.params, refTexts);
    } else if (isRefObject(step.spec.jobId)) {
      refTexts.push(step.spec.jobId.$ref);
    }
    if (malformed) {
      errors.push({
        line: step.line,
        message: `step "${step.id}": a $ref object must be exactly {"$ref": "..."} — no sibling keys`,
      });
    }
    for (const refText of refTexts) {
      const parsed = parseRefText(refText);
      if (parsed === null) {
        errors.push({
          line: step.line,
          message: `step "${step.id}": invalid reference "${refText}" — expected "<stepId>" or "<stepId>#/<rfc6901-pointer>"`,
        });
        continue;
      }
      if (!earlierIds.has(parsed.stepId)) {
        errors.push({
          line: step.line,
          message: `step "${step.id}": reference "${parsed.stepId}" is not an earlier step — references may only point backwards`,
        });
        continue;
      }
      // await.jobId must target an export.start step, single-hop.
      if (step.kind === "await") {
        const target = steps.find((s) => s.id === parsed.stepId);
        if (target !== undefined && (target.kind !== "verb" || target.verb !== "export.start")) {
          errors.push({
            line: step.line,
            message: `step "${step.id}": await.jobId may only reference an earlier export.start step (got "${parsed.stepId}", which is a ${target.kind === "verb" ? `"${target.verb}" step` : '"await" step'})`,
          });
        }
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

type StepStatus =
  | { readonly state: "ok"; readonly value: unknown }
  | { readonly state: "failed" }
  | { readonly state: "workflow-error" }
  | { readonly state: "skipped" };

export interface RunLine {
  readonly index: number;
  readonly id: string;
  readonly verb?: string;
  readonly await?: unknown;
  readonly result?: FacadeResult<unknown>;
  readonly workflowError?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

type WorkflowErrorBody = NonNullable<RunLine["workflowError"]>;

function workflowError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): WorkflowErrorBody {
  return { code, message, ...(details !== undefined ? { details } : {}) };
}

/** RFC 6901 pointer resolution into a plain-JSON value. */
export function resolvePointer(
  value: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false; miss: string } {
  if (pointer === "") return { ok: true, value };
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = value;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      const idx = /^\d+$/.test(part) ? Number(part) : -1;
      if (idx < 0 || idx >= cursor.length) {
        return { ok: false, miss: part };
      }
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor === "object" && cursor !== null) {
      const record = cursor as Record<string, unknown>;
      if (!(part in record)) {
        return { ok: false, miss: part };
      }
      cursor = record[part];
      continue;
    }
    return { ok: false, miss: part };
  }
  return { ok: true, value: cursor };
}

function resolveRefText(
  refText: string,
  results: ReadonlyMap<string, StepStatus>,
): { ok: true; value: unknown } | { ok: false; error: WorkflowErrorBody } {
  const parsed = parseRefText(refText);
  if (parsed === null) {
    return {
      ok: false,
      error: workflowError("REF_INVALID", `invalid reference "${refText}"`),
    };
  }
  const status = results.get(parsed.stepId);
  if (status === undefined) {
    return {
      ok: false,
      error: workflowError(
        "REF_UNKNOWN_STEP",
        `reference to unknown step "${parsed.stepId}"`,
      ),
    };
  }
  if (status.state === "skipped") {
    return {
      ok: false,
      error: workflowError(
        "REF_STEP_SKIPPED",
        `step "${parsed.stepId}" was skipped and has no result to reference`,
      ),
    };
  }
  if (status.state === "failed") {
    return {
      ok: false,
      error: workflowError(
        "REF_STEP_FAILED",
        `step "${parsed.stepId}" failed; its result cannot be referenced`,
      ),
    };
  }
  if (status.state === "workflow-error") {
    return {
      ok: false,
      error: workflowError(
        "REF_STEP_WORKFLOW_ERROR",
        `step "${parsed.stepId}" failed with a workflow error; its result cannot be referenced`,
      ),
    };
  }
  const resolved = resolvePointer(status.value, parsed.pointer);
  if (!resolved.ok) {
    return {
      ok: false,
      error: workflowError(
        "POINTER_MISS",
        `pointer "${parsed.pointer}" misses step "${parsed.stepId}"'s result value (at "${resolved.miss}")`,
      ),
    };
  }
  return { ok: true, value: resolved.value };
}

/**
 * Single-pass structural substitution: walk the caller params; every ref
 * object is replaced by the referenced value — which is NOT re-scanned
 * (reference chaining is not a feature; it is how data-injection bugs
 * would arrive).
 */
function substitute(
  node: unknown,
  results: ReadonlyMap<string, StepStatus>,
): { ok: true; value: unknown } | { ok: false; error: WorkflowErrorBody } {
  if (isRefObject(node)) {
    return resolveRefText(node.$ref, results);
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const resolved = substitute(item, results);
      if (!resolved.ok) return resolved;
      out.push(resolved.value);
    }
    return { ok: true, value: out };
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const resolved = substitute(item, results);
      if (!resolved.ok) return resolved;
      out[key] = resolved.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value: node };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function runAwaitStep(
  session: TransportSession,
  step: Extract<WorkflowStep, { kind: "await" }>,
  jobId: string,
): Promise<FacadeResult<unknown>> {
  const timeoutMs = step.spec.timeoutMs as number;
  const pollMs = (step.spec.pollMs as number | undefined) ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await session.facade["job.status"]({ jobId });
    if (!status.ok) {
      // job.status itself failed (e.g. NOT_FOUND) — polling cannot continue.
      return status;
    }
    if (isTerminalJobState(status.value.state)) {
      if (status.value.state === "done") {
        // The await step's result value IS the terminal job status value.
        return { ok: true, value: status.value };
      }
      return {
        ok: false,
        error: {
          code: "JOB_FAILED",
          message: `await: job "${jobId}" reached terminal state "${status.value.state}" instead of "done"`,
          details: { jobId, state: status.value.state, status: status.value },
        },
      };
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        error: {
          code: "ACTION_FAILED",
          message: `await: timed out after ${timeoutMs} ms waiting for job "${jobId}" to reach a terminal state (last state "${status.value.state}")`,
          details: { jobId, timeoutMs, lastState: status.value.state },
        },
      };
    }
    await sleep(pollMs);
  }
}

export interface RunWorkflowResult {
  readonly exitCode: 0 | 1;
}

export async function executeWorkflow(
  session: TransportSession,
  steps: readonly WorkflowStep[],
  options: { readonly keepGoing: boolean },
  emit: (line: RunLine) => void,
): Promise<RunWorkflowResult> {
  const results = new Map<string, StepStatus>();
  let firstFailure = false;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (firstFailure && !options.keepGoing) {
      results.set(step.id, { state: "skipped" });
      continue;
    }

    if (step.kind === "verb") {
      // 1. $ref substitution (single pass).
      const substituted = substitute(step.params, results);
      if (!substituted.ok) {
        firstFailure = true;
        results.set(step.id, { state: "workflow-error" });
        emit({ index, id: step.id, verb: step.verb, workflowError: substituted.error });
        continue;
      }
      // 2. Absolute-path boundary AFTER substitution (Decision 6).
      const violations = findRelativePathViolations(step.verb, substituted.value);
      if (violations.length > 0) {
        firstFailure = true;
        results.set(step.id, { state: "failed" });
        emit({
          index,
          id: step.id,
          verb: step.verb,
          result: {
            ok: false,
            error: {
              code: "INVALID_PARAMS",
              message: relativePathMessage(step.verb, violations[0]),
              details: {
                violations: violations.map((v) => ({ field: v.field, value: v.value })),
              },
            },
          },
        });
        continue;
      }
      // 3. Facade call — verbatim passthrough (Decision 5). Param-less
      //    verbs ignore the (possibly empty) params argument.
      const verb = step.verb as keyof AgentFacade;
      const call = session.facade[verb] as unknown as (
        p: unknown,
      ) => Promise<FacadeResult<unknown>>;
      const result = await call(substituted.value);
      if (step.verb === "export.start" && result.ok) {
        const value = result.value as { readonly jobId?: unknown };
        if (typeof value?.jobId === "string") session.trackJob(value.jobId);
      }
      results.set(
        step.id,
        result.ok ? { state: "ok", value: result.value } : { state: "failed" },
      );
      if (!result.ok) firstFailure = true;
      emit({ index, id: step.id, verb: step.verb, result });
      continue;
    }

    // await step: jobId literal or single-hop ref into an export.start result
    let jobId: string;
    if (typeof step.spec.jobId === "string") {
      jobId = step.spec.jobId;
    } else if (isRefObject(step.spec.jobId)) {
      const resolved = resolveRefText(step.spec.jobId.$ref, results);
      if (!resolved.ok) {
        firstFailure = true;
        results.set(step.id, { state: "workflow-error" });
        emit({ index, id: step.id, await: step.spec, workflowError: resolved.error });
        continue;
      }
      if (typeof resolved.value !== "string" || resolved.value.length === 0) {
        firstFailure = true;
        results.set(step.id, { state: "workflow-error" });
        emit({
          index,
          id: step.id,
          await: step.spec,
          workflowError: workflowError(
            "POINTER_MISS",
            `await.jobId reference resolved to a non-string (${JSON.stringify(resolved.value)})`,
          ),
        });
        continue;
      }
      jobId = resolved.value;
    } else {
      // Unreachable: static validation rejects this shape earlier.
      firstFailure = true;
      results.set(step.id, { state: "workflow-error" });
      emit({
        index,
        id: step.id,
        await: step.spec,
        workflowError: workflowError(
          "REF_INVALID",
          "await.jobId must be a string or a single $ref",
        ),
      });
      continue;
    }
    const result = await runAwaitStep(session, step, jobId);
    results.set(
      step.id,
      result.ok ? { state: "ok", value: result.value } : { state: "failed" },
    );
    if (!result.ok) firstFailure = true;
    emit({ index, id: step.id, await: step.spec, result });
  }

  return { exitCode: firstFailure ? 1 : 0 };
}

/* ------------------------------------------------------------------ */
/* CLI driver                                                          */
/* ------------------------------------------------------------------ */

const FACADE_CALL_KEYS = [
  "session.describe",
  "capabilities.get",
  "project.create",
  "project.open",
  "project.save",
  "project.get_state",
  "media.import",
  "timeline.get",
  "edit.apply",
  "preview.render_frame",
  "export.start",
  "job.status",
  "job.cancel",
  "verify.artifact",
] as const;

export async function runCommand(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    refuseStartup(error, "run");
  }
  if (parsed.workflowPath === undefined) {
    refuseStartup(
      new Error("run requires --workflow <absolute path to a JSONL workflow file>"),
      "run",
    );
  }
  if (!isAbsolute(parsed.workflowPath)) {
    refuseStartup(
      new Error(
        `--workflow "${parsed.workflowPath}" is not an absolute path — path inputs are absolute-only (Decision 6)`,
      ),
      "run",
    );
  }
  let config: TransportConfig;
  try {
    config = await resolveConfig(parsed.roots, parsed.logLevel);
  } catch (error) {
    refuseStartup(error, "run");
  }
  setLogLevel(config.logLevel);

  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(parsed.workflowPath, "utf8");
  } catch (error) {
    refuseStartup(
      new Error(
        `workflow file "${parsed.workflowPath}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      ),
      "run",
    );
  }
  logInfo("run", "workflow loaded", {
    workflow: parsed.workflowPath,
    keepGoing: parsed.keepGoing,
  });

  const { steps, errors: parseErrors } = parseWorkflowLines(text);
  const staticErrors = [...parseErrors, ...staticValidate(steps)];
  if (staticErrors.length > 0) {
    // Static failure: exit 2, no steps executed, nothing on stdout.
    for (const error of staticErrors) {
      logError("run", `static validation: line ${error.line}: ${error.message}`, {
        line: error.line,
      });
    }
    logError("run", "workflow rejected statically — no steps executed", {
      errorCount: staticErrors.length,
      exitCode: 2,
    });
    return 2;
  }

  const session = createTransportSession(config);

  // Signal ownership for the runner process too (Decision 7): first signal
  // ⇒ bounded disposal (cancel tracked jobs → dispose providers) ⇒ exit
  // 130/143/129; second signal ⇒ immediate hard exit.
  let disposalStarted = false;
  const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      const exitCode = SIGNAL_EXIT_CODES[signal];
      if (disposalStarted) {
        logError("signal", "second signal — immediate hard exit", { signal });
        process.exit(exitCode);
        return;
      }
      disposalStarted = true;
      logInfo("signal", "first signal — bounded disposal begins", { signal });
      void session
        .dispose(signal)
        .catch(() => undefined)
        .finally(() => {
          process.exit(exitCode);
        });
    });
  }

  try {
    const outcome = await executeWorkflow(
      session,
      steps,
      { keepGoing: parsed.keepGoing },
      (line) => {
        process.stdout.write(`${JSON.stringify(line)}\n`);
      },
    );
    logInfo("run", "workflow finished", { exitCode: outcome.exitCode });
    await session.dispose("run-finished");
    return outcome.exitCode;
  } catch (error) {
    // An unexpected crash mid-run: still bounded-dispose, exit 1.
    logError("run", "workflow crashed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await session.dispose("run-crashed").catch(() => undefined);
    return 1;
  }
}
