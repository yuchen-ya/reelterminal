/** User-declared production history; never evidence that a model actually ran. */
export const PRODUCTION_OPERATIONS = [
  "original",
  "generation",
  "redraw",
  "composite",
  "resize",
  "modelEnhancement",
] as const;
export type ProductionOperation = (typeof PRODUCTION_OPERATIONS)[number];

export interface ProductionStep {
  readonly operation: ProductionOperation;
  readonly tool: string;
  readonly model?: string;
  readonly inputMediaIds: readonly string[];
  /** Zero-based source-frame range, half-open. Omitted means the whole asset. */
  readonly range?: { readonly startFrame: number; readonly endFrame: number };
}

export interface MediaProduction {
  readonly status: "pending" | "adopted" | "rejected";
  readonly notes: string;
  readonly steps: readonly ProductionStep[];
}

export function validateMediaProduction(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Production record must be an object";
  const record = value as MediaProduction;
  if (
    Object.keys(record).some(
      (key) => !["status", "notes", "steps"].includes(key),
    )
  )
    return "Unknown production field";
  if (!["pending", "adopted", "rejected"].includes(record.status))
    return "Invalid candidate status";
  if (typeof record.notes !== "string" || record.notes.length > 4000)
    return "Notes must be at most 4000 characters";
  if (!Array.isArray(record.steps) || record.steps.length > 100)
    return "At most 100 production steps are supported";
  for (const step of record.steps) {
    if (
      !step ||
      typeof step !== "object" ||
      Object.keys(step).some(
        (key) =>
          !["operation", "tool", "model", "inputMediaIds", "range"].includes(
            key,
          ),
      )
    )
      return "Invalid production step";
    if (!PRODUCTION_OPERATIONS.includes(step.operation))
      return "Invalid production operation";
    if (
      typeof step.tool !== "string" ||
      !step.tool.trim() ||
      step.tool.length > 200
    )
      return "Tool is required (at most 200 characters)";
    if (
      step.model !== undefined &&
      (typeof step.model !== "string" ||
        !step.model.trim() ||
        step.model.length > 200)
    )
      return "Invalid model name";
    if (step.operation === "modelEnhancement" && !step.model)
      return "Model enhancement requires an explicit model";
    if (
      !Array.isArray(step.inputMediaIds) ||
      step.inputMediaIds.length > 100 ||
      step.inputMediaIds.some(
        (id: unknown) => typeof id !== "string" || !id.trim(),
      )
    )
      return "Invalid input versions";
    if (
      step.range !== undefined &&
      (!step.range ||
        Object.keys(step.range).some(
          (key) => !["startFrame", "endFrame"].includes(key),
        ) ||
        !Number.isSafeInteger(step.range.startFrame) ||
        !Number.isSafeInteger(step.range.endFrame) ||
        step.range.startFrame < 0 ||
        step.range.endFrame <= step.range.startFrame)
    )
      return "Frame range must be zero-based [startFrame,endFrame)";
  }
  return null;
}
