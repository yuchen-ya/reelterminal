/**
 * Schema differential tests (ADR 0003 Decision 4 items 2/3/5):
 *
 * (a) CI deep-equal — the served tools/list inputSchemas deep-equal the
 *     facade emission EMITTED_VERB_JSON_SCHEMAS (the transport assigns
 *     them by reference; copy drift dies here);
 * (b) ajv differential corpus — for EVERY verb, EVERY case of
 *     VERB_SCHEMA_CORPUS classifies identically under ajv (emitted schema,
 *     ajv is the transport's devDependency only) and the facade's runtime
 *     validators (mirroring session.ts's validation sequence, including
 *     the cross-field validation-only predicates);
 * (c) ordering pins — schemaValid:true / expectValid:false cases (clip.trim
 *     at-least-one-of, odd width, verify region x+width ≤ 1) must pass
 *     ajv and still fail INVALID_PARAMS at the facade: the schema is a
 *     boundary superset filter, the runtime validators are the only
 *     authority (Decision 4 item 5 passthrough).
 */
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { TOOLS } from "../src/tools";
import { EMITTED_VERB_JSON_SCHEMAS } from "@openreel/agent-facade";
import { VERB_SCHEMA_CORPUS } from "@openreel/agent-facade";
import { validateObject } from "@openreel/agent-facade/validate";
import { validateEditOp } from "@openreel/agent-facade/ops";
import {
  EXPORT_SETTINGS_SCHEMA,
  VISUAL_INSPECT_RANGE_SCHEMA,
  VERIFY_COMPARE_SCHEMA,
  VERIFY_EXPECT_SCHEMA,
  VERIFY_REGION_SCHEMA,
  VERB_PARAM_SCHEMAS,
  PROJECT_SETTINGS_SCHEMA,
  EDITOR_CONTROL_TARGET_SCHEMA,
  TIMELINE_QUERY_RANGE_SCHEMA,
} from "@openreel/agent-facade/verb-schemas";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map<string, any>();
function compile(verb: string, schema: unknown): any {
  let c = compiled.get(verb);
  if (!c) {
    c = ajv.compile(schema as object);
    compiled.set(verb, c);
  }
  return c;
}

/**
 * Mirror of the facade's runtime boundary validation sequence per verb
 * (session.ts): the closed envelope schema, plus the nested schemas and
 * validation-only cross-field predicates for the verbs that have them.
 */
function facadeRuntimeValidation(verb: string, params: unknown): boolean {
  try {
    const envelope = (VERB_PARAM_SCHEMAS as Record<string, typeof VERB_PARAM_SCHEMAS[keyof typeof VERB_PARAM_SCHEMAS]>)[verb];
    if (!envelope) throw new Error(`no declaration for verb ${verb}`);
    const valid = validateObject<Record<string, unknown>>(params, envelope, `${verb} params`);
    switch (verb) {
      case "project.create": {
        // session.projectCreate also schema-checks the settings subset.
        if (valid.settings !== undefined) {
          validateObject(valid.settings, PROJECT_SETTINGS_SCHEMA, "project.create params.settings");
        }
        return true;
      }
      case "edit.apply":
      case "edit.validate": {
        const ops = valid.ops as unknown[];
        if (ops.length === 0) return false; // minItems 1 is enforced at runtime
        ops.forEach((op, index) => validateEditOp(op, index)); // cross-field: trim in/out
        return true;
      }
      case "timeline.query": {
        if (valid.timeRange !== undefined) {
          const range = validateObject<Record<string, number>>(
            valid.timeRange,
            TIMELINE_QUERY_RANGE_SCHEMA,
            "timeline.query params.timeRange",
          );
          if (range.endSec <= range.startSec) return false;
        }
        return true;
      }
      case "export.start": {
        if (valid.settings !== undefined) {
          validateObject(valid.settings, EXPORT_SETTINGS_SCHEMA, "export.start params.settings");
        }
        return true;
      }
      case "visual.inspect": {
        if (valid.timeRange !== undefined) {
          validateObject(valid.timeRange, VISUAL_INSPECT_RANGE_SCHEMA, "visual.inspect params.timeRange");
        }
        if ((valid.clipId === undefined) === (valid.timeRange === undefined)) return false;
        return true;
      }
      case "verify.artifact": {
        if (valid.expect !== undefined) {
          validateObject(valid.expect, VERIFY_EXPECT_SCHEMA, "verify.artifact params.expect");
        }
        if (valid.compare !== undefined) {
          const compare = validateObject<Record<string, any>>(valid.compare, VERIFY_COMPARE_SCHEMA, "verify.artifact params.compare");
          if (compare.region !== undefined) {
            const region = validateObject<Record<string, number>>(compare.region, VERIFY_REGION_SCHEMA, "verify.artifact params.compare.region");
            // validation-only predicate (not expressible in JSON Schema)
            if (region.x + region.width > 1 || region.y + region.height > 1) return false;
          }
        }
        return true;
      }
      case "editor.control": {
        const action = valid.action;
        if (action === "seek" && valid.timeSeconds === undefined) return false;
        if (action !== "seek" && valid.timeSeconds !== undefined) return false;
        if (action === "select" && (!Array.isArray(valid.targets) || valid.targets.length === 0)) return false;
        if (action !== "select" && (valid.targets !== undefined || valid.selectionMode !== undefined)) return false;
        if (Array.isArray(valid.targets)) {
          valid.targets.forEach((target, index) =>
            validateObject(target, EDITOR_CONTROL_TARGET_SCHEMA, `${verb} params.targets[${index}]`),
          );
        }
        return true;
      }
      default:
        return true;
    }
  } catch {
    return false; // FacadeError INVALID_PARAMS: boundary rejection
  }
}

describe("Decision 4 item 2: transport assigns facade schemas verbatim", () => {
  it("TOOLS inputSchemas are the EMITTED_VERB_JSON_SCHEMAS objects (deep-equal, by reference)", () => {
    const verbOrder: string[] = [
      "session.describe", "capabilities.get", "project.create", "project.open",
      "project.save", "project.rename", "project.get_state", "project.changes",
      "media.import", "media.analyze_start", "timeline.get", "timeline.query",
      "editor.get_context",
      "editor.control",
      "edit.validate", "edit.apply", "history.get", "history.control",
      "preview.render_frame", "visual.inspect", "export.start", "job.status",
      "job.cancel", "verify.artifact",
    ];
    const emitted = EMITTED_VERB_JSON_SCHEMAS as Record<string, unknown>;
    expect(TOOLS).toHaveLength(24);
    TOOLS.forEach((tool, i) => {
      expect(tool.inputSchema).toBe(emitted[verbOrder[i]]);
      expect(tool.inputSchema).toEqual(emitted[verbOrder[i]]);
    });
  });

  it("every emitted schema compiles under draft-2020-12 ajv", () => {
    for (const [verb, schema] of Object.entries(EMITTED_VERB_JSON_SCHEMAS)) {
      expect(() => compile(verb, schema)).not.toThrow();
    }
  });
});

describe("Decision 4 item 3: ajv differential corpus", () => {
  for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
    describe(verb, () => {
      for (const testCase of cases) {
        it(`"${testCase.name}" classifies identically`, () => {
          const validate = compile(verb, EMITTED_VERB_JSON_SCHEMAS[verb as keyof typeof EMITTED_VERB_JSON_SCHEMAS]);
          const schemaValid = validate(testCase.params) as boolean;
          const expectedSchemaValid = testCase.schemaValid ?? testCase.expectValid;
          expect(schemaValid).toBe(expectedSchemaValid);

          const runtimeValid = facadeRuntimeValidation(verb, testCase.params);
          expect(runtimeValid).toBe(testCase.expectValid);
        });
      }
    });
  }

  it("ordering pins: schema-valid but facade-rejected cases exist and are asserted", () => {
    const pins: { verb: string; name: string }[] = [];
    for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
      for (const c of cases) {
        if (c.schemaValid === true && c.expectValid === false) pins.push({ verb, name: c.name });
      }
    }
    // clip.trim at-least-one-of, odd width, region x+width ≤ 1
    expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(pins.some((p) => p.verb === "edit.apply")).toBe(true);
    expect(pins.some((p) => p.verb === "preview.render_frame")).toBe(true);
    expect(pins.some((p) => p.verb === "verify.artifact")).toBe(true);
  });
});
