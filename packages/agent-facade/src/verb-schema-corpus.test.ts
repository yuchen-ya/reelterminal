import { PLUGIN_TOOLS } from "./plugins";
/**
 * Facade-side half of the Decision-4 differential corpus (the ajv half
 * belongs to the transport). Every corpus case is classified by the SAME
 * validation objects and helpers the session's verb bodies use — the
 * exported schemas from verb-schemas.ts and validateEditOp from ops.ts —
 * layered in the same order as session.ts. The pin:
 *
 *   corpus case expectValid  ==  the facade boundary accepts the payload
 *   case.schemaValid (default expectValid) == what ajv must conclude in the
 *   transport's differential test; the schemaValid:true/expectValid:false
 *   cases assert the documented ordering — schema-valid but facade-rejected
 *   (cross-field predicates stay validator-only).
 */
import { describe, expect, it } from "vitest";
import { FacadeError } from "./errors";
import { validateEditOp } from "./ops";
import { validateObject } from "./validate";
import {
  EDIT_APPLY_SCHEMA,
  EMPTY_PARAMS_SCHEMA,
  EXPORT_SETTINGS_SCHEMA,
  EXPORT_START_SCHEMA,
  JOB_PARAMS_SCHEMA,
  MEDIA_IMPORT_SCHEMA,
  MEDIA_ANALYZE_START_SCHEMA,
  ANALYSIS_GET_SCHEMA,
  ANALYSIS_LIST_SCHEMA,
  PREVIEW_RENDER_COMPARISON_SCHEMA,
  PREVIEW_RENDER_FRAME_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  PROJECT_CREATE_SCHEMA,
  PROJECT_OPEN_SCHEMA,
  PROJECT_RENAME_SCHEMA,
  PROJECT_SAVE_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
  PROJECT_CHANGES_SCHEMA,
  TIMELINE_QUERY_SCHEMA,
  TIMELINE_QUERY_RANGE_SCHEMA,
  EDIT_VALIDATE_SCHEMA,
  HISTORY_GET_SCHEMA,
  HISTORY_CONTROL_SCHEMA,
  MATERIAL_LIST_SCHEMA,
  MATERIAL_GET_SCHEMA,
  MATERIAL_CREATE_SCHEMA,
  MATERIAL_UPDATE_SCHEMA,
  MATERIAL_BATCH_UPDATE_SCHEMA,
  MATERIAL_REMOVE_SCHEMA,
  MATERIAL_ATTACH_SCHEMA,
  MATERIAL_UNDO_SCHEMA,
  FONT_UPLOAD_SCHEMA,
  PRESET_LIST_SCHEMA,
  PRESET_GET_SCHEMA,
  PRESET_CREATE_SCHEMA,
  PRESET_UPDATE_SCHEMA,
  PRESET_REMOVE_SCHEMA,
  PRESET_APPLY_SCHEMA,
  HELP_DESCRIBE_SCHEMA,
  HELP_LIST_SCREENS_SCHEMA,
  HELP_SEARCH_SCHEMA,
} from "./verb-schemas";
import { describeManualScreen } from "./gui-manual";
import { validatePresetPayload } from "@openreel/core/presets/validate";
import { VERB_SCHEMA_CORPUS } from "./verb-schema-corpus";
import { FACADE_VERBS } from "./types";

/**
 * Mirrors the session's boundary layers, in session order (session.ts is
 * authoritative; keep this driver in step with it). Only the SCHEMA layers
 * — containment/provider/preflight checks are not param validation.
 */
function facadeBoundaryValidate(verb: string, params: unknown): void {
  switch (verb) {
    case "session.describe":
    case "capabilities.get":
    case "project.get_state":
    case "timeline.get":
    case "editor.get_context":
      validateObject(params, EMPTY_PARAMS_SCHEMA, `${verb} params`);
      return;
    case "editor.control": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        EDITOR_CONTROL_SCHEMA,
        "editor.control params",
      );
      const action = valid.action;
      if (action === "seek" && valid.timeSeconds === undefined) {
        throw new FacadeError("INVALID_PARAMS", "editor.control: seek requires timeSeconds");
      }
      if (action !== "seek" && valid.timeSeconds !== undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `editor.control: timeSeconds is only valid for seek, not ${String(action)}`,
        );
      }
      if (action === "select" && (!Array.isArray(valid.targets) || valid.targets.length === 0)) {
        throw new FacadeError("INVALID_PARAMS", "editor.control: select requires at least one target");
      }
      if (
        action !== "select" &&
        (valid.targets !== undefined || valid.selectionMode !== undefined)
      ) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `editor.control: targets and selectionMode are only valid for select, not ${String(action)}`,
        );
      }
      if (Array.isArray(valid.targets)) {
        valid.targets.forEach((target, index) =>
          validateObject(
            target,
            EDITOR_CONTROL_TARGET_SCHEMA,
            `editor.control params.targets[${index}]`,
          ),
        );
      }
      return;
    }
    case "project.create": {
      const valid = validateObject<{ settings?: unknown }>(
        params,
        PROJECT_CREATE_SCHEMA,
        "project.create params",
      );
      if (valid.settings !== undefined) {
        validateObject(valid.settings, PROJECT_SETTINGS_SCHEMA, "project.create params.settings");
      }
      return;
    }
    case "project.open":
      validateObject(params, PROJECT_OPEN_SCHEMA, "project.open params");
      return;
    case "project.save":
      validateObject(params, PROJECT_SAVE_SCHEMA, "project.save params");
      return;
    case "project.rename":
      validateObject(params, PROJECT_RENAME_SCHEMA, "project.rename params");
      return;
    case "project.changes":
      validateObject(params, PROJECT_CHANGES_SCHEMA, "project.changes params");
      return;
    case "media.import":
      validateObject(params, MEDIA_IMPORT_SCHEMA, "media.import params");
      return;
    case "media.analyze_start":
      validateObject(params, MEDIA_ANALYZE_START_SCHEMA, "media.analyze_start params");
      return;
    case "timeline.query": {
      const valid = validateObject<{ timeRange?: unknown }>(
        params,
        TIMELINE_QUERY_SCHEMA,
        "timeline.query params",
      );
      if (valid.timeRange !== undefined) {
        validateObject(valid.timeRange, TIMELINE_QUERY_RANGE_SCHEMA, "timeline.query params.timeRange");
      }
      return;
    }
    case "edit.validate":
    case "edit.apply": {
      const valid = validateObject<{ ops: unknown[] }>(
        params,
        verb === "edit.apply" ? EDIT_APPLY_SCHEMA : EDIT_VALIDATE_SCHEMA,
        `${verb} params`,
      );
      const ops = valid.ops.map((raw, index) => validateEditOp(raw, index));
      if (ops.length === 0) {
        throw new FacadeError("INVALID_PARAMS", "edit.apply: ops must contain at least one op");
      }
      return;
    }
    case "history.get":
      validateObject(params, HISTORY_GET_SCHEMA, "history.get params");
      return;
    case "history.control":
      validateObject(params, HISTORY_CONTROL_SCHEMA, "history.control params");
      return;
    case "preview.render_frame":
      validateObject(params, PREVIEW_RENDER_FRAME_SCHEMA, "preview.render_frame params");
      return;
    case "preview.render_comparison":
      validateObject(params, PREVIEW_RENDER_COMPARISON_SCHEMA, "preview.render_comparison params");
      return;
    case "analysis.list":
      validateObject(params, ANALYSIS_LIST_SCHEMA, "analysis.list params");
      return;
    case "analysis.get":
      validateObject(params, ANALYSIS_GET_SCHEMA, "analysis.get params");
      return;
    case "visual.inspect": {
      const valid = validateObject<{ clipId?: string; timeRange?: unknown }>(
        params,
        VISUAL_INSPECT_SCHEMA,
        "visual.inspect params",
      );
      if (valid.timeRange !== undefined) {
        validateObject(valid.timeRange, VISUAL_INSPECT_RANGE_SCHEMA, "visual.inspect params.timeRange");
      }
      if ((valid.clipId === undefined) === (valid.timeRange === undefined)) {
        throw new FacadeError("INVALID_PARAMS", "visual.inspect: pass exactly one of clipId or timeRange");
      }
      return;
    }
    case "export.start": {
      const valid = validateObject<{ settings?: unknown }>(
        params,
        EXPORT_START_SCHEMA,
        "export.start params",
      );
      if (valid.settings !== undefined) {
        validateObject(valid.settings, EXPORT_SETTINGS_SCHEMA, "export.start params.settings");
      }
      return;
    }
    case "job.status":
      validateObject(params, JOB_PARAMS_SCHEMA, "job.status params");
      return;
    case "job.cancel":
      validateObject(params, JOB_PARAMS_SCHEMA, "job.cancel params");
      return;
    case "verify.artifact": {
      const valid = validateObject<{ expect?: unknown; compare?: unknown }>(
        params,
        VERIFY_ARTIFACT_SCHEMA,
        "verify.artifact params",
      );
      if (valid.expect !== undefined) {
        validateObject(valid.expect, VERIFY_EXPECT_SCHEMA, "verify.artifact params.expect");
      }
      if (valid.compare !== undefined) {
        const compare = validateObject<{ region?: unknown }>(
          valid.compare,
          VERIFY_COMPARE_SCHEMA,
          "verify.artifact params.compare",
        );
        if (compare.region !== undefined) {
          const region = validateObject<{ x: number; y: number; width: number; height: number }>(
            compare.region,
            VERIFY_REGION_SCHEMA,
            "verify.artifact params.compare.region",
          );
          if (region.x + region.width > 1 || region.y + region.height > 1) {
            throw new FacadeError(
              "INVALID_PARAMS",
              "verify.artifact: compare.region must satisfy x+width ≤ 1 and y+height ≤ 1",
              { region },
            );
          }
        }
      }
      return;
    }
    case "material.list":
      validateObject(params, MATERIAL_LIST_SCHEMA, "material.list params");
      return;
    case "material.get":
      validateObject(params, MATERIAL_GET_SCHEMA, "material.get params");
      return;
    case "material.create": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        MATERIAL_CREATE_SCHEMA,
        "material.create params",
      );
      // Validator-only predicate, mirrored from live-session: media requires
      // a probeable local path; the kind-specific requirements for the other
      // kinds are canonically validated renderer-side.
      if (valid.kind === "media" && (valid.filePath === undefined || valid.mediaType === undefined)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "material.create: media materials require filePath and mediaType",
        );
      }
      return;
    }
    case "material.update":
      validateObject(params, MATERIAL_UPDATE_SCHEMA, "material.update params");
      return;
    case "material.batch_update":
      validateObject(params, MATERIAL_BATCH_UPDATE_SCHEMA, "material.batch_update params");
      return;
    case "material.remove":
      validateObject(params, MATERIAL_REMOVE_SCHEMA, "material.remove params");
      return;
    case "material.attach":
      validateObject(params, MATERIAL_ATTACH_SCHEMA, "material.attach params");
      return;
    case "material.undo":
      validateObject(params, MATERIAL_UNDO_SCHEMA, "material.undo params");
      return;
    case "font.upload": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        FONT_UPLOAD_SCHEMA,
        "font.upload params",
      );
      // Validator-only predicate, mirrored from live-session: exactly one
      // byte input (size budget and media-root containment are live-mode
      // concerns, enforced by the live session after validation).
      if ((valid.filePath === undefined) === (valid.dataBase64 === undefined)) {
        throw new FacadeError(
          "INVALID_PARAMS",
          "font.upload: exactly one of filePath or dataBase64 is required",
        );
      }
      return;
    }
    case "font.list":
      validateObject(params, EMPTY_PARAMS_SCHEMA, "font.list params");
      return;
    case "preset.list":
      validateObject(params, PRESET_LIST_SCHEMA, "preset.list params");
      return;
    case "preset.get":
      validateObject(params, PRESET_GET_SCHEMA, "preset.get params");
      return;
    case "preset.create": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        PRESET_CREATE_SCHEMA,
        "preset.create params",
      );
      // Validator-only layer mirrored from live-session: the deep per-kind
      // payload validation runs in the session body (Node-safe core
      // validator, the SAME function the GUI save path uses).
      const payload = validatePresetPayload(valid.payload);
      if (!payload.ok) {
        throw new FacadeError("INVALID_PARAMS", `preset.create: ${payload.message}`);
      }
      return;
    }
    case "preset.update":
      validateObject(params, PRESET_UPDATE_SCHEMA, "preset.update params");
      return;
    case "preset.remove":
      validateObject(params, PRESET_REMOVE_SCHEMA, "preset.remove params");
      return;
    case "preset.apply": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        PRESET_APPLY_SCHEMA,
        "preset.apply params",
      );
      // Validator-only predicate, mirrored from live-session: the target
      // shape is closed structurally before any renderer round-trip.
      const target = valid.target as Record<string, unknown>;
      const kind = target.kind;
      if (kind === "text") {
        if (target.mode !== "updateStyle" || typeof target.clipId !== "string" || target.clipId.length === 0) {
          throw new FacadeError(
            "INVALID_PARAMS",
            'preset.apply: text targets support {"kind":"text","mode":"updateStyle","clipId":...}',
          );
        }
        return;
      }
      if (kind === "effect") {
        const clipIds = target.clipIds;
        if (
          !Array.isArray(clipIds) ||
          clipIds.length === 0 ||
          !clipIds.every((id) => typeof id === "string" && id.length > 0)
        ) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "preset.apply: effect target requires a non-empty clipIds array",
          );
        }
        return;
      }
      if (kind === "transition") {
        if (typeof target.clipAId !== "string" || target.clipAId.length === 0) {
          throw new FacadeError(
            "INVALID_PARAMS",
            "preset.apply: transition target requires clipAId",
          );
        }
        return;
      }
      throw new FacadeError(
        "INVALID_PARAMS",
        `preset.apply: unknown target kind "${String(kind)}"`,
      );
    }
    case "help.list_screens":
      validateObject(params, HELP_LIST_SCREENS_SCHEMA, "help.list_screens params");
      return;
    case "help.describe": {
      const valid = validateObject<Record<string, unknown>>(
        params,
        HELP_DESCRIBE_SCHEMA,
        "help.describe params",
      );
      // Validator-only layer mirrored from gui-manual.ts: the id lookup runs
      // after the boundary schema, so a schema-valid but unknown id is an
      // INVALID_PARAMS.
      describeManualScreen(valid.screenId as string);
      return;
    }
    case "help.search":
      validateObject(params, HELP_SEARCH_SCHEMA, "help.search params");
      return;
    default:
      { const tool = PLUGIN_TOOLS.find((tool) => tool.name === verb);
        if (tool) { validateObject(params, tool.input, `${verb} params`); return; } }
      throw new Error(`corpus driver: no boundary layers for verb "${verb}"`);
  }
}

describe("Decision-4 differential corpus — facade-side classification", () => {
  it("covers every verb", () => {
    expect(Object.keys(VERB_SCHEMA_CORPUS).sort()).toEqual([...FACADE_VERBS].sort());
  });

  for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
    for (const testCase of cases) {
      const expectedSchemaVerdict = testCase.schemaValid ?? testCase.expectValid;
      it(`${verb}: ${testCase.name}`, () => {
        let facadeError: FacadeError | undefined;
        try {
          facadeBoundaryValidate(verb, testCase.params);
        } catch (error) {
          if (error instanceof FacadeError) facadeError = error;
          else throw error;
        }
        // Facade verdict must equal expectValid (rejected => INVALID_PARAMS):
        if (testCase.expectValid) {
          expect(facadeError).toBeUndefined();
        } else {
          expect(facadeError).toBeDefined();
          expect(facadeError?.code).toBe("INVALID_PARAMS");
        }
        // The corpus also documents what the emitted schema must conclude —
        // the transport's ajv run asserts exactly this classification.
        expect(typeof expectedSchemaVerdict).toBe("boolean");
      });
    }
  }

  it("ordering pins: cross-field predicates are schema-valid but facade-rejected", () => {
    const pins = Object.values(VERB_SCHEMA_CORPUS)
      .flat()
      .filter((c) => c.schemaValid === true && c.expectValid === false);
    for (const pin of pins) {
      let rejected: FacadeError | undefined;
      try {
        facadeBoundaryValidate(
          Object.entries(VERB_SCHEMA_CORPUS).find(([, cases]) =>
            cases.includes(pin),
          )![0],
          pin.params,
        );
      } catch (error) {
        if (error instanceof FacadeError) rejected = error;
        else throw error;
      }
      expect(rejected).toBeDefined();
      expect(rejected?.code).toBe("INVALID_PARAMS");
    }
  });
});
