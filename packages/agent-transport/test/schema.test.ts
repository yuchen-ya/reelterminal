import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";

import {
  createAgentFacade,
  getCommandCatalog,
  EMITTED_VERB_JSON_SCHEMAS,
  FACADE_VERBS,
  VERB_SCHEMA_CORPUS,
  type FacadeResult,
} from "@reelterminal/agent-facade";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const MEDIA_ROOT = fileURLToPath(new URL("../../agent-facade/src/media/fixtures/", import.meta.url));
const MEDIA_PREFLIGHT_PATH = join(MEDIA_ROOT, "tiny-mp4.ts");
const FONT_ROOT = fileURLToPath(new URL("../../../apps/web/public/fonts/", import.meta.url));
const FONT_PATH = join(FONT_ROOT, "1Ptug8zYS_SKggPNyCMIT4ttDfCmxA.woff2");

function compile(verb: string, schema: unknown) {
  let validator = compiled.get(verb);
  if (!validator) {
    validator = ajv.compile(schema as object);
    compiled.set(verb, validator);
  }
  return validator;
}

async function productionFacadeErrorCode(
  verb: string,
  params: unknown,
): Promise<string | undefined> {
  const facade = createAgentFacade({ mediaRoots: [MEDIA_ROOT, FONT_ROOT] }) as unknown as Record<string, unknown>;
  const call = facade[verb];
  if (typeof call !== "function") {
    throw new Error(`production facade has no method for "${verb}"`);
  }
  const result = await (call as (params: unknown) => Promise<FacadeResult<unknown>>)(params);
  return result.ok ? undefined : result.error.code;
}

describe("Decision 4 item 2: transport assigns facade schemas verbatim", () => {
  it("Command catalog inputSchemas are the EMITTED_VERB_JSON_SCHEMAS objects (deep-equal, by reference)", () => {
    const emitted = EMITTED_VERB_JSON_SCHEMAS as Record<string, unknown>;
    expect(getCommandCatalog("headless")).toHaveLength(FACADE_VERBS.length);
    getCommandCatalog("headless").forEach((tool, index) => {
      expect(tool.inputSchema).toBe(emitted[FACADE_VERBS[index]]);
      expect(tool.inputSchema).toEqual(emitted[FACADE_VERBS[index]]);
    });
  });

  it("every emitted schema compiles under draft-2020-12 ajv", () => {
    for (const [verb, schema] of Object.entries(EMITTED_VERB_JSON_SCHEMAS)) {
      expect(() => compile(verb, schema)).not.toThrow();
    }
  });
});

describe("Decision 4 item 3: ajv differential corpus against the production facade", () => {
  it("covers every registered verb", () => {
    expect(Object.keys(VERB_SCHEMA_CORPUS).sort()).toEqual([...FACADE_VERBS].sort());
  });

  for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
    describe(verb, () => {
      for (const testCase of cases) {
        it(`"${testCase.name}" classifies identically`, async () => {
          const validator = compile(
            verb,
            EMITTED_VERB_JSON_SCHEMAS[verb as keyof typeof EMITTED_VERB_JSON_SCHEMAS],
          );
          const schemaValid = validator(testCase.params) as boolean;
          const expectedSchemaValid = testCase.schemaValid ?? testCase.expectValid;
          expect(schemaValid).toBe(expectedSchemaValid);

          const params = verb === "media.import_preflight" &&
            typeof (testCase.params as { path?: unknown }).path === "string"
            ? { ...(testCase.params as Record<string, unknown>), path: MEDIA_PREFLIGHT_PATH }
            : verb === "font.upload" &&
                typeof (testCase.params as { filePath?: unknown }).filePath === "string" &&
                (testCase.params as { filePath: string }).filePath.length > 0
              ? { ...(testCase.params as Record<string, unknown>), filePath: FONT_PATH }
              : testCase.params;
          const errorCode = await productionFacadeErrorCode(verb, params);
          if (testCase.expectValid) {
            expect(errorCode).not.toBe("INVALID_PARAMS");
          } else {
            expect(errorCode).toBe("INVALID_PARAMS");
          }
        });
      }
    });
  }

  it("ordering pins retain schema-valid but production-rejected cases", () => {
    const pins = Object.values(VERB_SCHEMA_CORPUS)
      .flat()
      .filter((testCase) => testCase.schemaValid === true && !testCase.expectValid);
    expect(pins.length).toBeGreaterThanOrEqual(3);
    expect(pins.some((testCase) => testCase.name.includes("clip.trim"))).toBe(true);
    expect(pins.some((testCase) => testCase.name.includes("width"))).toBe(true);
    expect(pins.some((testCase) => testCase.name.includes("region"))).toBe(true);
  });
});
