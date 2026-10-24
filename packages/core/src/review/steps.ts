import type { ReviewJson, ReviewStep, ReviewStepReference } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: "INVALID_PARAMS" }); };
const label = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);

export function reviewReferenceKey(reference: ReviewStepReference): string {
  return "resourceId" in reference ? `resource:${reference.resourceId}` : `item:${reference.nodeId}:${reference.itemId}:${reference.version}`;
}

export function validateReviewParameters(value: ReviewJson, depth = 0): void {
  if (depth > 8) invalid("Review parameters exceed depth 8");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid("Review parameters require finite numbers"); return; }
  if (typeof value !== "object") invalid("Review parameters must be JSON values");
  if (Array.isArray(value)) {
    if (value.length > 128) invalid("Review parameter arrays exceed 128 entries");
    for (const entry of value) validateReviewParameters(entry, depth + 1);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid("Review parameters must be plain JSON");
    const entries = Object.entries(value);
    if (entries.length > 128) invalid("Review parameter objects exceed 128 fields");
    for (const [key, entry] of entries) {
      if (key.length > 200 || /api.?key|authorization|password|secret|access.?token/i.test(key)) invalid("Secret or oversized parameter names are not persisted");
      validateReviewParameters(entry, depth + 1);
    }
  }
}

function validateReference(reference: ReviewStepReference, nodeId: string): void {
  if (!reference || !label(reference.role, 64)) invalid("Step references require an explicit bounded role");
  if ("resourceId" in reference) { if (!UUID.test(reference.resourceId)) invalid("Invalid step resource UUID"); }
  else if (reference.nodeId !== nodeId || !UUID.test(reference.itemId) || !Number.isSafeInteger(reference.version) || reference.version < 1) invalid("Step item input requires an exact authorized node/item/version");
  if (reference.region) {
    const region = reference.region;
    if (region.space !== "source-pixels" || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) invalid("Step region must use explicit source pixels");
  }
  if (reference.range && (!Number.isFinite(reference.range.startSec) || !Number.isFinite(reference.range.endSec) || reference.range.startSec < 0 || reference.range.endSec <= reference.range.startSec)) invalid("Step time ranges must be finite and increasing");
}

/** Validate persisted lifecycle and the dependency graph, without inventing processing steps. */
export function validateReviewSteps(nodeId: string, existing: readonly ReviewStep[], updates: readonly ReviewStep[]): void {
  const all = new Map(existing.map(step => [step.id, step]));
  for (const step of updates) {
    if (!UUID.test(step.id) || !UUID.test(step.runId) || step.nodeId !== nodeId || !label(step.label, 200)) invalid("Step identity must belong to its review node");
    if (!["user", "agent", "tool"].includes(step.actor) || !["planned", "running", "completed", "failed", "cancelled"].includes(step.state)) invalid("Unknown review step actor or state");
    if (!step.method || !["algorithm", "model", "skill"].includes(step.method.kind) || !label(step.method.name, 200) || (step.method.version !== undefined && !label(step.method.version, 100)) || !["declared", "measured"].includes(step.method.verification)) invalid("Review steps require a bounded method label and verification source");
    if (!Array.isArray(step.inputs) || !Array.isArray(step.outputs) || step.inputs.length > 64 || step.outputs.length > 64) invalid("Review steps allow at most 64 inputs and outputs");
    for (const reference of [...step.inputs, ...step.outputs]) validateReference(reference, nodeId);
    if (step.mapping) {
      const mapping = step.mapping;
      if (!["image-bounds", "time-range"].includes(mapping.kind) || !Number.isInteger(mapping.inputIndex) || mapping.inputIndex < 0 || mapping.inputIndex >= step.inputs.length || !Number.isInteger(mapping.outputIndex) || mapping.outputIndex < 0 || mapping.outputIndex >= 64) invalid("Invalid input/output mapping");
      if (step.state === "completed" && (mapping.outputIndex >= step.outputs.length || (mapping.kind === "time-range" && (!step.inputs[mapping.inputIndex].range || !step.outputs[mapping.outputIndex].range)))) invalid("A time mapping requires explicit input/output source ranges");
    }
    validateReviewParameters(step.parameters);
    if (!step.parameters || Array.isArray(step.parameters) || typeof step.parameters !== "object" || new TextEncoder().encode(JSON.stringify(step.parameters)).byteLength > 32768) invalid("Review parameters must be an object within 32 KiB");
    if (step.state === "completed" && !step.outputs.length) invalid("Completed steps require real outputs");
    if (step.state !== "completed" && step.outputs.length) invalid("An unfinished step cannot claim outputs");
    if (step.state !== "planned" && (!Number.isFinite(step.startedAt) || step.startedAt < 0)) invalid("Invalid step start time");
    if (["completed", "failed", "cancelled"].includes(step.state)) {
      const terminal = step as Extract<ReviewStep, { state: "completed" | "failed" | "cancelled" }>;
      if (!Number.isFinite(terminal.finishedAt) || terminal.finishedAt < terminal.startedAt) invalid("Invalid step finish time");
    }
    const previous = all.get(step.id);
    if (previous) {
      if (["completed", "failed", "cancelled"].includes(previous.state)) invalid("Terminal processing steps are immutable; retry with a new step ID");
      if (previous.state === "running" && (step.state === "planned" || step.startedAt !== previous.startedAt)) invalid("A running step cannot reset its lifecycle");
      if (previous.runId !== step.runId || previous.actor !== step.actor || previous.label !== step.label || previous.supersedesStepId !== step.supersedesStepId) invalid("A processing step cannot change its execution identity");
      if (canonical(previous.inputs) !== canonical(step.inputs) || canonical(previous.method) !== canonical(step.method) || canonical(previous.parameters) !== canonical(step.parameters) || canonical(previous.mapping) !== canonical(step.mapping)) invalid("A running step cannot change its inputs, method, parameters or mapping");
    }
    if (step.supersedesStepId && (!all.has(step.supersedesStepId) || step.supersedesStepId === step.id)) invalid("Unknown superseded step");
    all.set(step.id, step);
  }
  const producers = new Map<string, string>();
  for (const step of all.values()) for (const output of step.outputs) {
    const key = reviewReferenceKey(output);
    if (producers.has(key)) invalid("An exact output version cannot have multiple producing steps");
    producers.set(key, step.id);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid("Processing steps cannot depend on themselves or form cycles");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of all.get(id)!.inputs) {
      const producer = producers.get(reviewReferenceKey(input));
      if (producer) visit(producer);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of all.keys()) visit(id);
}
