/**
 * Emitter contract tests (ADR 0003 Decision 4 item 6): per-verb structural
 * assertions on the emitted draft-2020-12 schemas — closed objects, required
 * arrays, enums, const discriminators, the nested op-union shape, no `$ref`
 * anywhere, the client property-name regex, and no root-level combinators.
 * The emitter is dependency-free, so these tests are too.
 */
import { describe, expect, it } from "vitest";
import {
  emitObjectSchema,
  EMITTED_VERB_JSON_SCHEMAS,
} from "./jsonschema";
import {
  CLIP_ADD_SCHEMA,
  CLIP_TRIM_SCHEMA,
  TEXT_CREATE_SCHEMA,
  TRACK_ADD_SCHEMA,
} from "./ops";
import { EDIT_OP_TYPES, FACADE_VERBS } from "./types";
import { VERB_SCHEMA_CORPUS } from "./verb-schema-corpus";

type Schema = Record<string, unknown>;

const PROPERTY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Recursively walk every node of an emitted schema. */
function walk(schema: Schema, visit: (node: Schema) => void): void {
  visit(schema);
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") walk(entry as Schema, visit);
      }
    } else if (value && typeof value === "object") {
      walk(value as Schema, visit);
    }
  }
}

describe("emitted verb JSON Schemas — global client constraints", () => {
  it("covers exactly the 14 facade verbs, keyed by verb name", () => {
    expect(Object.keys(EMITTED_VERB_JSON_SCHEMAS).sort()).toEqual(
      [...FACADE_VERBS].sort(),
    );
    expect(FACADE_VERBS).toHaveLength(14);
  });

  for (const [verb, typedSchema] of Object.entries(EMITTED_VERB_JSON_SCHEMAS)) {
    const schema = typedSchema as unknown as Schema;
    it(`${verb}: root is a flat closed object with no root-level combinator`, () => {
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.allOf).toBeUndefined();
      expect(schema.$ref).toBeUndefined();
      expect(schema.$schema).toBeUndefined();
      expect(typeof schema.properties).toBe("object");
    });

    it(`${verb}: every property name matches ^[A-Za-z0-9_-]{1,64}$ and every object is closed, with no $ref anywhere`, () => {
      walk(schema, (node) => {
        if (node.type === "object") {
          expect(node.additionalProperties, JSON.stringify(node)).toBe(false);
          for (const key of Object.keys(node.properties as Schema)) {
            expect(key).toMatch(PROPERTY_NAME_RE);
          }
        }
        expect(node.$ref).toBeUndefined();
        expect(node.definitions).toBeUndefined();
        expect(node.$defs).toBeUndefined();
      });
    });
  }

  it("emission is a pure derivation: editing a declaration changes both consumers (single source smoke)", () => {
    // The op-union variants in the emitted schema are the SAME declaration
    // objects the runtime validator uses — not copies.
    const ops = (EMITTED_VERB_JSON_SCHEMAS["edit.apply"].properties as Schema)
      .ops as Schema;
    const anyOf = (ops.items as Schema).anyOf as Schema[];
    expect(anyOf).toHaveLength(EDIT_OP_TYPES.length);
  });
});

describe("emitted schema per-verb structure", () => {
  it("project.create: all-optional fields, hardened settings subset inline", () => {
    const schema = EMITTED_VERB_JSON_SCHEMAS["project.create"];
    expect(schema.required).toBeUndefined();
    const props = schema.properties as Schema;
    expect(Object.keys(props)).toEqual(["name", "settings", "idempotencyKey"]);
    expect(props.name).toEqual({ type: "string", minLength: 1 });
    expect(props.settings).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        frameRate: { type: "number", exclusiveMinimum: 0 },
        sampleRate: { type: "integer", minimum: 1 },
        channels: { type: "integer", minimum: 1 },
      },
    });
    expect(props.idempotencyKey).toEqual({ type: "string", minLength: 1 });
  });

  it("media.import: required [path], expectedRevision is a non-negative integer", () => {
    const schema = EMITTED_VERB_JSON_SCHEMAS["media.import"];
    expect(schema.required).toEqual(["path"]);
    const props = schema.properties as Schema;
    expect(props.expectedRevision).toEqual({ type: "integer", minimum: 0 });
  });

  it("edit.apply: the discriminated op union lives as a nested anyOf inside items", () => {
    const schema = EMITTED_VERB_JSON_SCHEMAS["edit.apply"];
    expect(schema.required).toEqual(["ops"]);
    const props = schema.properties as Schema;
    expect(props.expectedRevision).toEqual({ type: "integer", minimum: 0 });
    const ops = props.ops as Schema;
    expect(ops).toEqual({
      type: "array",
      minItems: 1,
      items: {
        anyOf: [
          emitObjectSchema(TRACK_ADD_SCHEMA),
          emitObjectSchema(CLIP_ADD_SCHEMA),
          emitObjectSchema(CLIP_TRIM_SCHEMA),
          emitObjectSchema(TEXT_CREATE_SCHEMA),
        ],
      },
    });
    const anyOf = ((ops.items as Schema).anyOf ?? []) as Schema[];
    const trackAdd = anyOf[0];
    expect(trackAdd.additionalProperties).toBe(false);
    expect(trackAdd.required).toEqual(["op", "trackType"]);
    expect((trackAdd.properties as Schema).op).toEqual({ const: "track.add" });
    expect((trackAdd.properties as Schema).trackType).toEqual({
      enum: ["video", "audio", "image", "text", "graphics"],
    });
    const clipAdd = anyOf[1];
    expect(clipAdd.required).toEqual(["op", "trackId", "mediaId", "startTime"]);
    expect((clipAdd.properties as Schema).op).toEqual({ const: "clip.add" });
    const clipTrim = anyOf[2];
    expect(clipTrim.required).toEqual(["op", "clipId"]);
    expect((clipTrim.properties as Schema).op).toEqual({ const: "clip.trim" });
    const textCreate = anyOf[3];
    expect(textCreate.required).toEqual(["op", "text", "startTime", "duration"]);
    expect((textCreate.properties as Schema).op).toEqual({ const: "text.create" });
    expect((textCreate.properties as Schema).style).toMatchObject({
      additionalProperties: false,
    });
  });

  it("preview.render_frame: raster bounds emitted; evenness intentionally absent", () => {
    const props = EMITTED_VERB_JSON_SCHEMAS["preview.render_frame"]
      .properties as Schema;
    expect(props.timeSec).toEqual({ type: "number", minimum: 0 });
    expect(props.width).toEqual({ type: "integer", minimum: 2, maximum: 8192 });
    expect(props.height).toEqual({ type: "integer", minimum: 2, maximum: 8192 });
    // The validator refuses odd dimensions; the schema is the honest superset.
    expect(JSON.stringify(props.width)).not.toContain("multipleOf");
  });

  it("export.start: settings consts for the closed mp4/h264 slice", () => {
    const props = EMITTED_VERB_JSON_SCHEMAS["export.start"].properties as Schema;
    expect((props.settings as Schema).properties).toMatchObject({
      format: { const: "mp4" },
      codec: { const: "h264" },
    });
  });

  it("job.status / job.cancel: required [jobId]", () => {
    for (const verb of ["job.status", "job.cancel"] as const) {
      expect(EMITTED_VERB_JSON_SCHEMAS[verb].required).toEqual(["jobId"]);
    }
  });

  it("verify.artifact: nested expect/compare objects, region bounds, mode enum", () => {
    const props = EMITTED_VERB_JSON_SCHEMAS["verify.artifact"].properties as Schema;
    expect(props.path).toEqual({ type: "string", minLength: 1 });
    const expectSchema = props.expect as Schema;
    expect((expectSchema.properties as Schema).container).toEqual({ const: "mp4" });
    expect(expectSchema.required).toBeUndefined();
    const compare = props.compare as Schema;
    expect(compare.required).toEqual(["referencePath", "timeSec", "mode"]);
    expect((compare.properties as Schema).mode).toEqual({
      enum: ["similar", "different"],
    });
    const region = (compare.properties as Schema).region as Schema;
    expect(region.required).toEqual(["x", "y", "width", "height"]);
    for (const bound of Object.values(region.properties as Schema)) {
      expect(bound).toEqual({ type: "number", minimum: 0, maximum: 1 });
    }
    // x+width <= 1 stays validator-only:
    expect(JSON.stringify(region)).not.toContain("x+width");
  });

  it("project.open / project.save: lifecycle and snapshot param shapes", () => {
    const open = EMITTED_VERB_JSON_SCHEMAS["project.open"];
    expect(open.required).toEqual(["path"]);
    expect(Object.keys(open.properties as Schema)).toEqual(["path", "idempotencyKey"]);
    const save = EMITTED_VERB_JSON_SCHEMAS["project.save"];
    expect(save.required).toEqual(["path"]);
    expect((save.properties as Schema).overwrite).toEqual({ type: "boolean" });
    expect((save.properties as Schema).expectedRevision).toEqual({
      type: "integer",
      minimum: 0,
    });
    // A snapshot carries no idempotencyKey (Decision 10.3):
    expect((save.properties as Schema).idempotencyKey).toBeUndefined();
  });

  it("param-less verbs emit a closed empty object", () => {
    for (const verb of [
      "session.describe",
      "capabilities.get",
      "project.get_state",
      "timeline.get",
    ] as const) {
      expect(EMITTED_VERB_JSON_SCHEMAS[verb]).toEqual({
        type: "object",
        additionalProperties: false,
        properties: {},
      });
    }
  });
});

describe("adversarial corpus fixture (transport-side differential input)", () => {
  it("covers every verb with at least one valid and one failing case", () => {
    expect(Object.keys(VERB_SCHEMA_CORPUS).sort()).toEqual([...FACADE_VERBS].sort());
    for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
      expect(cases.length, verb).toBeGreaterThanOrEqual(2);
      expect(cases.some((c) => c.expectValid), verb).toBe(true);
      expect(cases.some((c) => !c.expectValid), verb).toBe(true);
    }
  });

  it("pins the superset ordering: schemaValid:true + expectValid:false cases exist", () => {
    const orderingPins = Object.values(VERB_SCHEMA_CORPUS)
      .flat()
      .filter((c) => c.schemaValid === true && c.expectValid === false);
    expect(orderingPins.length).toBeGreaterThanOrEqual(3);
    expect(orderingPins.map((c) => c.name).join("\n")).toContain("clip.trim");
    expect(orderingPins.map((c) => c.name).join("\n")).toContain("region");
    expect(orderingPins.map((c) => c.name).join("\n")).toContain("odd width");
  });
});
