/**
 * Draft-2020-12 JSON Schema emitter.
 *
 * Dependency-free: the closed `ObjectSchema` declarations in
 * verb-schemas.ts / ops.ts ARE the single hand-maintained definition of
 * each verb's params; this module renders them into the JSON Schemas the
 * transport assigns verbatim to its `tools/list` entries. There is no
 * second hand-written schema anywhere.
 *
 * The emitted schemas use these shapes:
 *  - flat top-level object; the discriminated edit.apply op union lives as
 *    a nested `anyOf` inside `items` (root-level combinators are never
 *    emitted);
 *  - `additionalProperties: false` on every object (closed, like the
 *    runtime validators);
 *  - inline everything — no `$ref` (at least one major MCP client does not
 *    dereference them);
 *  - `integer` where the validator demands integers, enums and consts where
 *    the validator checks membership, min/max bounds where the validator
 *    has them;
 *  - cross-field predicates that JSON Schema cannot express stay
 *    validation-only: the emitted schema is a boundary superset filter and
 *    the runtime validators remain the only authority.
 */
import { FACADE_VERBS, type FacadeVerb } from "./types";
import { VERB_PARAM_SCHEMAS } from "./verb-schemas";
import type {
  FieldEmits,
  JsonSchemaNode,
  JsonSchemaObjectNode,
  ObjectSchema,
} from "./validate";

export type JsonSchemaObject = JsonSchemaObjectNode;
export type { JsonSchemaNode };

const PROPERTY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Render one field's emission metadata into its JSON-Schema node. A rule
 * without metadata fails loudly here rather than silently emitting a hole —
 * a declaration that validates but cannot be emitted is a bug.
 */
function emitFieldEmits(field: FieldEmits): JsonSchemaNode {
  switch (field.kind) {
    case "leaf":
      return field.schema;
    case "object":
      return emitObjectSchema(field.schema);
    case "array":
      return {
        type: "array",
        items: emitFieldEmits(field.items),
        ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
        ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
      };
    case "anyOfObjects":
      return { anyOf: field.variants.map(emitObjectSchema) };
  }
}

/**
 * Render one closed declaration into a draft-2020-12 object schema:
 * `{type:"object", additionalProperties:false, properties, required}`.
 * `required` lists exactly the declaration's `required: true` fields, in
 * declaration order (omitted when empty — an absent `required` accepts the
 * empty object, matching the validator, which also allows omitting every
 * optional field).
 */
export function emitObjectSchema(schema: ObjectSchema): JsonSchemaObject {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, rule] of Object.entries(schema)) {
    if (!PROPERTY_NAME_RE.test(key)) {
      throw new Error(
        `jsonschema: field name "${key}" violates the client property-name constraint ^[A-Za-z0-9_-]{1,64}$`,
      );
    }
    if (rule.required) required.push(key);
    if (!rule.emits) {
      throw new Error(
        `jsonschema: field "${key}" has no emission metadata — every field of an emitted declaration must carry \`emits\` (Decision 4: one declaration, both consumers derived)`,
      );
    }
    properties[key] = emitFieldEmits(rule.emits);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function emitVerbSchema(verb: FacadeVerb): JsonSchemaObject {
  const schema = VERB_PARAM_SCHEMAS[verb as string];
  if (!schema) {
    throw new Error(`jsonschema: no param declaration for verb "${verb}"`);
  }
  return emitObjectSchema(schema);
}

/**
 * The emitted draft-2020-12 input schema per facade verb, keyed by verb
 * name (B.1 tool map, 24 verbs). The transport imports this map and assigns
 * `tool.inputSchema = EMITTED_VERB_JSON_SCHEMAS[verb]` verbatim; a CI
 * assertion there deep-equals it against the running `tools/list` payload,
 * so any drift between the two surfaces dies in CI.
 *
 * Derived once at module load from VERB_PARAM_SCHEMAS — editing a
 * declaration changes validation and emission together, by construction.
 */
export const EMITTED_VERB_JSON_SCHEMAS: Readonly<
  Record<FacadeVerb, JsonSchemaObject>
> = Object.fromEntries(
  FACADE_VERBS.map((verb) => [verb, emitVerbSchema(verb)]),
) as Readonly<Record<FacadeVerb, JsonSchemaObject>>;

/**
 * Live-mode input-schema overrides. The live facade implements the
 * same bundled verbs, but live `project.save` is NOT a checkpoint write: it takes
 * no params (the GUI owns the save target) and flushes the GUI's autosave
 * snapshot, reporting only the revision. Advertising the headless checkpoint
 * schema (`path` required) on the live `tools/list` would instruct
 * integrators to pass a param the live runtime must reject — a contract
 * self-contradiction. Live endpoints assign
 * `LIVE_VERB_INPUT_SCHEMA_OVERRIDES[verb] ?? EMITTED_VERB_JSON_SCHEMAS[verb]`.
 * Live edit schemas also omit clip.add.clipId because the canonical GUI store
 * mints ids. Top-level validate/apply parameter differences remain intact.
 */
function liveEditSchema(verb: "edit.apply" | "edit.validate"): JsonSchemaObject {
  const schema = structuredClone(EMITTED_VERB_JSON_SCHEMAS[verb]);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, any>;
    if (value.properties?.op?.const === "clip.add") delete value.properties.clipId;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return schema;
}

export const LIVE_VERB_INPUT_SCHEMA_OVERRIDES: Readonly<
  Partial<Record<FacadeVerb, JsonSchemaObject>>
> = {
  "edit.apply": liveEditSchema("edit.apply"),
  "edit.validate": liveEditSchema("edit.validate"),
  "project.save": {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};
