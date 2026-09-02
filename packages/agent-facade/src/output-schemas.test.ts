import { describe, expect, it } from "vitest";
import { EMITTED_VERB_OUTPUT_JSON_SCHEMAS } from "./output-schemas";
import { FACADE_VERBS } from "./types";

type Schema = Record<string, unknown>;

describe("emitted MCP output schemas", () => {
  it("covers every facade verb with a closed successful envelope", () => {
    expect(Object.keys(EMITTED_VERB_OUTPUT_JSON_SCHEMAS).sort()).toEqual(
      [...FACADE_VERBS].sort(),
    );
    for (const verb of FACADE_VERBS) {
      const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as unknown as Schema;
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["ok", "value"],
      });
      expect((schema.properties as Schema).ok).toEqual({ const: true });
    }
  });

  it("makes edit.apply creating-op results explicit per applied op", () => {
    const schema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS["edit.apply"] as unknown as Schema;
    const value = (schema.properties as Schema).value as Schema;
    const applied = (value.properties as Schema).applied as Schema;
    const item = applied.items as Schema;
    expect(item.required).toEqual(["op", "createdIds"]);
    expect(item.additionalProperties).toBe(false);
    expect((item.properties as Schema).createdIds).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });
});
