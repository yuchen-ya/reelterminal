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
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
} from "./jsonschema";
import {
  EDIT_OP_SCHEMAS,
  MAX_EDIT_OPS_PER_BATCH,
} from "./verb-schemas";
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
  it("covers all registered facade verbs, keyed by verb name", () => {
    expect(Object.keys(EMITTED_VERB_JSON_SCHEMAS).sort()).toEqual(
      [...FACADE_VERBS].sort(),
    );
    expect(FACADE_VERBS).toHaveLength(FACADE_VERBS.length);
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
          // The open-object leaf (`{type:"object"}`, additionalProperties
          // defaulted) is reserved for values deep-validated elsewhere
          // (the custom-preset payload); pinned to those fields below.
          expect(
            node.additionalProperties === false ||
              node.additionalProperties === undefined,
            JSON.stringify(node),
          ).toBe(true);
          for (const key of Object.keys((node.properties ?? {}) as Schema)) {
            expect(key).toMatch(PROPERTY_NAME_RE);
          }
        }
        expect(node.$ref).toBeUndefined();
        expect(node.definitions).toBeUndefined();
        expect(node.$defs).toBeUndefined();
      });
    });
  }

  it("only the custom-preset payload uses the open-object leaf; everything else stays closed", () => {
    const openObjects: string[] = [];
    for (const [verb, typedSchema] of Object.entries(EMITTED_VERB_JSON_SCHEMAS)) {
      walk(typedSchema as unknown as Schema, (node) => {
        if (node.type === "object" && node.additionalProperties === undefined) {
          openObjects.push(`${verb}`);
        }
      });
    }
    expect(openObjects).toEqual(["preset.create", "preset.update"]);
  });

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
    // ADR 0004 Decision 4: the live context CAS guard, same integer shape.
    expect(props.expectedContextRevision).toEqual({ type: "integer", minimum: 0 });
    const ops = props.ops as Schema;
    expect(ops).toEqual({
      type: "array",
      minItems: 1,
      maxItems: MAX_EDIT_OPS_PER_BATCH,
      items: {
        anyOf: EDIT_OP_TYPES.map(
          (opType) => emitObjectSchema(EDIT_OP_SCHEMAS[opType]) as unknown as Schema,
        ),
      },
    });
    const anyOf = ((ops.items as Schema).anyOf ?? []) as Schema[];
    expect(anyOf).toHaveLength(41); // EDIT_OP_TYPES grows with the op set (reference + media.replace/relink/rename + clip.setChromaKey + clip.setNoiseReduction + svg.create/update/remove + workAsset.capture/rename/delete/instantiate)
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
    const clipMove = anyOf[2];
    expect(clipMove.required).toEqual(["op", "clipId", "startTime"]);
    expect((clipMove.properties as Schema).op).toEqual({ const: "clip.move" });
    const clipTrim = anyOf[3];
    expect(clipTrim.required).toEqual(["op", "clipId"]);
    expect((clipTrim.properties as Schema).op).toEqual({ const: "clip.trim" });
    const clipSplit = anyOf[4];
    expect(clipSplit.required).toEqual(["op", "clipId", "time"]);
    expect((clipSplit.properties as Schema).op).toEqual({ const: "clip.split" });
    const clipDuplicate = anyOf[5];
    expect(clipDuplicate.required).toEqual(["op", "clipId"]);
    expect((clipDuplicate.properties as Schema).op).toEqual({
      const: "clip.duplicate",
    });
    const clipRippleDelete = anyOf[6];
    expect(clipRippleDelete.required).toEqual(["op", "clipId"]);
    expect((clipRippleDelete.properties as Schema).op).toEqual({
      const: "clip.rippleDelete",
    });
    const textCreate = anyOf[7];
    expect(textCreate.required).toEqual(["op", "text", "startTime", "duration"]);
    expect((textCreate.properties as Schema).op).toEqual({ const: "text.create" });
    expect((textCreate.properties as Schema).style).toMatchObject({
      additionalProperties: false,
    });
    // Normalized point sub-objects are closed and bounded on both axes.
    expect((textCreate.properties as Schema).position).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
      },
    });
    expect((textCreate.properties as Schema).anchor).toEqual(
      (textCreate.properties as Schema).position,
    );
    const textUpdate = anyOf[8];
    expect(textUpdate.required).toEqual(["op", "overlayId"]);
    expect((textUpdate.properties as Schema).op).toEqual({ const: "text.update" });
    // Only overlayId is required: at-least-one-updatable-field is validator-only.
    expect(textUpdate.required).not.toContain("text");
    expect((textUpdate.properties as Schema).position).toMatchObject({
      additionalProperties: false,
    });
    const textDelete = anyOf[9];
    expect(textDelete.required).toEqual(["op", "overlayId"]);
    expect((textDelete.properties as Schema).op).toEqual({ const: "text.delete" });
    const clipSetSpeed = anyOf[10];
    expect(clipSetSpeed.required).toEqual(["op", "clipId", "speed"]);
    expect((clipSetSpeed.properties as Schema).speed).toEqual({
      type: "number",
      minimum: 0.1,
      maximum: 20,
    });
    const clipSetReverse = anyOf[11];
    expect(clipSetReverse.required).toEqual(["op", "clipId", "reversed"]);
    expect((clipSetReverse.properties as Schema).reversed).toEqual({
      type: "boolean",
    });
    const clipSetTransform = anyOf[12];
    expect(clipSetTransform.required).toEqual(["op", "clipId", "transform"]);
    expect((clipSetTransform.properties as Schema).transform).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    const clipSetVolume = anyOf[13];
    expect(clipSetVolume.required).toEqual(["op", "clipId", "volume"]);
    expect((clipSetVolume.properties as Schema).op).toEqual({ const: "clip.setVolume" });
    expect((clipSetVolume.properties as Schema).volume).toEqual({
      type: "number",
      minimum: 0,
      maximum: 4,
    });
    const clipSetFade = anyOf[14];
    expect(clipSetFade.required).toEqual(["op", "clipId"]);
    expect((clipSetFade.properties as Schema).fadeIn).toEqual({
      type: "number",
      minimum: 0,
    });
    const clipRemove = anyOf[15];
    expect(clipRemove.additionalProperties).toBe(false);
    expect(clipRemove.required).toEqual(["op", "clipId"]);
    expect((clipRemove.properties as Schema).op).toEqual({ const: "clip.remove" });
    expect((clipRemove.properties as Schema).clipId).toEqual({
      type: "string",
      minLength: 1,
    });
    const transitionAdd = anyOf[16];
    expect(transitionAdd.required).toEqual([
      "op",
      "clipAId",
      "clipBId",
      "type",
      "duration",
    ]);
    expect((transitionAdd.properties as Schema).op).toEqual({
      const: "transition.add",
    });
    const transitionUpdate = anyOf[17];
    expect(transitionUpdate.required).toEqual(["op", "transitionId"]);
    const transitionRemove = anyOf[18];
    expect(transitionRemove.required).toEqual(["op", "transitionId"]);
    const trackRemove = anyOf[19];
    expect(trackRemove.required).toEqual(["op", "trackId"]);
    expect((trackRemove.properties as Schema).op).toEqual({
      const: "track.remove",
    });
    const mediaRemove = anyOf[20];
    expect(mediaRemove.required).toEqual(["op", "mediaId"]);
    expect((mediaRemove.properties as Schema).op).toEqual({
      const: "media.remove",
    });
    const markerAdd = anyOf[21];
    expect(markerAdd.required).toEqual(["op", "target"]);
    expect((markerAdd.properties as Schema).op).toEqual({
      const: "marker.add",
    });
    // The target union is the one nested anyOf below the op: four closed
    // variants discriminated by `kind`.
    const markerTarget = (markerAdd.properties as Schema).target as Schema;
    const targetVariants = markerTarget.anyOf as Schema[];
    expect(targetVariants).toHaveLength(4);
    for (const variant of targetVariants) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toContain("kind");
    }
    expect((targetVariants[0].properties as Schema).kind).toEqual({ const: "asset" });
    expect((targetVariants[3].properties as Schema).kind).toEqual({ const: "timeRange" });
    const markerRemove = anyOf[22];
    expect(markerRemove.required).toEqual(["op", "number"]);
    expect((markerRemove.properties as Schema).op).toEqual({
      const: "marker.remove",
    });
    expect((markerRemove.properties as Schema).number).toEqual({
      type: "integer",
      minimum: 1,
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

  it("visual.inspect: bounded raster and exclusive selection fields emitted", () => {
    const props = EMITTED_VERB_JSON_SCHEMAS["visual.inspect"].properties as Schema;
    expect(props.clipId).toEqual({ type: "string", minLength: 1 });
    expect(props.width).toEqual({ type: "integer", minimum: 2, maximum: 1024 });
    expect(props.height).toEqual({ type: "integer", minimum: 2, maximum: 1024 });
    expect((props.timeRange as Schema).additionalProperties).toBe(false);
    expect((props.timeRange as Schema).required).toEqual(["startSec", "endSec"]);
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
      "editor.get_context",
    ] as const) {
      expect(EMITTED_VERB_JSON_SCHEMAS[verb]).toEqual({
        type: "object",
        additionalProperties: false,
        properties: {},
      });
    }
  });

  it("live schema overrides cover save and canonical store-minted clip ids", () => {
    // Live project.save takes no params (the GUI owns the save target), so
    // the live tools/list must not advertise the headless checkpoint schema
    // with required `path`. Live edit ops additionally omit explicit clip ids.
    expect(Object.keys(LIVE_VERB_INPUT_SCHEMA_OVERRIDES).sort()).toEqual([
      "edit.apply", "edit.validate", "project.save",
    ]);
    for (const verb of ["edit.apply", "edit.validate"] as const) {
      const schema = LIVE_VERB_INPUT_SCHEMA_OVERRIDES[verb] as any;
      const clipAdd = schema.properties.ops.items.anyOf.find((entry: any) => entry.properties.op.const === "clip.add");
      expect(clipAdd.properties.clipId).toBeUndefined();
      expect(clipAdd.additionalProperties).toBe(false);
    }
    expect((LIVE_VERB_INPUT_SCHEMA_OVERRIDES["edit.validate"] as any).properties.idempotencyKey).toBeUndefined();
    expect(LIVE_VERB_INPUT_SCHEMA_OVERRIDES["project.save"]).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
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
