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
  PREVIEW_RENDER_FRAME_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
  VISUAL_INSPECT_SCHEMA,
  PROJECT_CREATE_SCHEMA,
  PROJECT_OPEN_SCHEMA,
  PROJECT_SAVE_SCHEMA,
  PROJECT_SETTINGS_SCHEMA,
  VERIFY_ARTIFACT_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  EDITOR_CONTROL_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
} from "./verb-schemas";
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
    case "media.import":
      validateObject(params, MEDIA_IMPORT_SCHEMA, "media.import params");
      return;
    case "edit.apply": {
      const valid = validateObject<{ ops: unknown[] }>(
        params,
        EDIT_APPLY_SCHEMA,
        "edit.apply params",
      );
      const ops = valid.ops.map((raw, index) => validateEditOp(raw, index));
      if (ops.length === 0) {
        throw new FacadeError("INVALID_PARAMS", "edit.apply: ops must contain at least one op");
      }
      return;
    }
    case "preview.render_frame":
      validateObject(params, PREVIEW_RENDER_FRAME_SCHEMA, "preview.render_frame params");
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
    default:
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
