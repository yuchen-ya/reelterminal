import { FacadeError, toFailure, type FacadeResult } from "./errors";
import { validateObject } from "./validate";
import { WORKSPACE_VERB_SCHEMAS } from "./workspace-schemas";
import {
  EXPORT_COMPARISON_SCHEMA,
  EXPORT_SETTINGS_SCHEMA,
  MEDIA_RENDER_HTML_SCHEMA,
  PRESET_APPLY_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  VERB_PARAM_SCHEMAS,
} from "./verb-schemas";
import {
  parseVerifyCompare,
  parseVerifyExpect,
  validateEditOpList,
  validateEditorControlAction,
  validateEditorControlTargets,
  validateFontUploadSource,
  validateTimelineQueryTimeRange,
  validateVisualInspectTimeRange,
} from "./verb-param-rules";
import type { LiveEditorControlParams } from "./live-store";
import type { TimelineQueryParams, VerifyArtifactParams } from "./types";
import { describeManualScreen } from "./gui-manual";
import { validatePresetPayload } from "@reelterminal/core/presets/validate";
import { presetApplyTargetProblem } from "./preset-verbs";
import { FACADE_VERBS } from "./types";
function validateFacadeFields(verb: string, params: unknown, mode: "headless" | "live"): void {
  const schema = mode === "live" && verb === "project.save"
    ? WORKSPACE_VERB_SCHEMAS["node.save"]
    : VERB_PARAM_SCHEMAS[verb];
  if (!schema) throw new Error(`request validation has no schema for verb "${verb}"`);

  const valid = validateObject<Record<string, unknown>>(params, schema, `${verb} params`);
  switch (verb) {
    case "editor.control": {
      // Same shared cross-field rules as both session implementations; at
      // this boundary the action rules deliberately run BEFORE the per-target
      // schema validation (the sessions check targets first — order preserved
      // from the original boundary copy).
      const params = valid as unknown as LiveEditorControlParams;
      validateEditorControlAction(params);
      validateEditorControlTargets(params.targets);
      return;
    }
    case "project.create":
      if (valid.settings !== undefined) {
        validateObject(valid.settings, PROJECT_SETTINGS_SCHEMA, "project.create params.settings");
      }
      return;
    case "timeline.query":
      validateTimelineQueryTimeRange(valid as unknown as TimelineQueryParams);
      return;
    case "audio.process.normalize":
      if ((valid.endSec as number) <= (valid.startSec as number)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "audio.process.normalize: endSec must be greater than startSec",
        );
      }
      if ((valid.endSec as number) - (valid.startSec as number) > 120) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "audio.process.normalize: the selected source range cannot exceed 120 seconds",
        );
      }
      return;
    case "edit.validate":
    case "edit.apply": {
      const ops = validateEditOpList(valid.ops as unknown[]);
      if (ops.length === 0) {
        throw new FacadeError("INVALID_PARAMS", `${verb}: ops must contain at least one op`);
      }
      if (mode === "live" && ops.some((op) => op.op === "clip.add" && op.clipId !== undefined)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `${verb}: clip.add with an explicit clipId is not supported in live mode — omit clipId and use the createdIds the result reports`,
        );
      }
      (params as Record<string, unknown>).ops = ops;
      return;
    }
    case "visual.inspect": {
      validateVisualInspectTimeRange(valid);
      if ((valid.clipId === undefined) === (valid.timeRange === undefined)) {
        throw new FacadeError("INVALID_PARAMS", "visual.inspect: pass exactly one of clipId or timeRange");
      }
      return;
    }
    case "export.start":
      if (valid.settings !== undefined) {
        validateObject(valid.settings, EXPORT_SETTINGS_SCHEMA, "export.start params.settings");
      }
      if (valid.comparison !== undefined) {
        validateObject(valid.comparison, EXPORT_COMPARISON_SCHEMA, "export.start params.comparison");
      }
      return;
    case "verify.artifact": {
      parseVerifyExpect(valid as unknown as VerifyArtifactParams);
      if (valid.compare === undefined) return;
      parseVerifyCompare(
        valid.compare as NonNullable<VerifyArtifactParams["compare"]>,
      );
      return;
    }
    case "material.create":
      if (valid.kind === "media" && (valid.filePath === undefined || valid.mediaType === undefined)) {
        throw new FacadeError("INVALID_PARAMS", "material.create: media materials require filePath and mediaType");
      }
      return;
    case "font.upload":
      validateFontUploadSource(valid);
      return;
    case "preset.create": {
      const payload = validatePresetPayload(valid.payload);
      if (!payload.ok) {
        throw new FacadeError("INVALID_PARAMS", `preset.create: ${payload.message}`);
      }
      return;
    }
    case "preset.update": {
      if (valid.payload === undefined) return;
      const payload = validatePresetPayload(valid.payload);
      if (!payload.ok) {
        throw new FacadeError("INVALID_PARAMS", `preset.update: ${payload.message}`);
      }
      return;
    }
    case "preset.apply": {
      const problem = presetApplyTargetProblem(valid.target);
      if (problem !== null) throw new FacadeError("INVALID_PARAMS", problem);
      const target = valid.target as Record<string, unknown>;
      const targetEmits = PRESET_APPLY_SCHEMA.target.emits;
      if (targetEmits?.kind !== "anyOfObjects") {
        throw new Error("preset.apply target schema is missing its declared variants");
      }
      const targetSchema = targetEmits.variants.find((variant) => variant.kind.check(target.kind));
      if (!targetSchema) {
        throw new Error(`preset.apply target schema has no variant for kind ${String(target.kind)}`);
      }
      validateObject(target, targetSchema, "preset.apply params.target");
      return;
    }
    case "media.render_html": {
      const source = valid.source as Record<string, unknown>;
      const sourceEmits = MEDIA_RENDER_HTML_SCHEMA.source.emits;
      if (sourceEmits?.kind !== "anyOfObjects") {
        throw new Error("media.render_html source schema is missing its declared variants");
      }
      const sourceSchema = sourceEmits.variants.find((variant) => variant.kind.check(source.kind));
      if (!sourceSchema) {
        throw new Error(`media.render_html source schema has no variant for kind ${String(source.kind)}`);
      }
      validateObject(source, sourceSchema, "media.render_html params.source");
      return;
    }
    case "help.describe":
      describeManualScreen(valid.screenId as string);
      return;
  }
}
/** Validate a request payload before the session can read state or providers. */
export function validateFacadeParams(
  verb: string,
  params: unknown,
  mode: "headless" | "live",
): unknown {
  let requestParams: unknown;
  try {
    requestParams = params === undefined ? {} : structuredClone(params);
  } catch {
    throw new FacadeError("INVALID_PARAMS", `${verb} params must be JSON-compatible`);
  }
  validateFacadeFields(verb, requestParams, mode);
  return requestParams;
}

/** Apply the same parameter boundary to the headless and live factory APIs. */
export function withValidatedFacadeCalls<T extends object>(
  facade: T,
  mode: "headless" | "live",
  beforeValidate?: (verb: string) => void,
): T {
  const verbs = new Set<string>(FACADE_VERBS);
  const wrappedCalls = new Map<PropertyKey, unknown>();

  return new Proxy(facade, {
    get(target, property, receiver) {
      const call = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !verbs.has(property) || typeof call !== "function") {
        return call;
      }

      let wrapped = wrappedCalls.get(property);
      if (!wrapped) {
        wrapped = (...args: unknown[]) => {
          try {
            beforeValidate?.(property);
            const params = validateFacadeParams(property, args[0], mode);
            return Reflect.apply(call, target, [params, ...args.slice(1)]);
          } catch (error) {
            return Promise.resolve(toFailure(error) as FacadeResult<unknown>);
          }
        };
        wrappedCalls.set(property, wrapped);
      }
      return wrapped;
    },
  });
}
