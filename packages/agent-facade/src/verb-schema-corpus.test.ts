import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAgentFacade,
  createLiveFacade,
  FACADE_VERBS,
  LiveWriterLease,
  VERB_SCHEMA_CORPUS,
  type FacadeResult,
  type LiveProjectStore,
} from "@reelterminal/agent-facade";

type FacadeCall = (params: unknown) => Promise<FacadeResult<unknown>>;
const MEDIA_ROOT = fileURLToPath(new URL("./media/fixtures/", import.meta.url));
const MEDIA_PREFLIGHT_PATH = join(MEDIA_ROOT, "tiny-mp4.ts");
const FONT_ROOT = fileURLToPath(new URL("../../../apps/web/public/fonts/", import.meta.url));
const FONT_PATH = join(FONT_ROOT, "1Ptug8zYS_SKggPNyCMIT4ttDfCmxA.woff2");

const LIVE_PROJECT_SAVE_CASES = [
  {
    name: "valid live node save request",
    params: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      expectedRevision: 0,
      idempotencyKey: "save-1",
    },
    expectValid: true,
  },
  {
    name: "live save requires a revision",
    params: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      idempotencyKey: "save-1",
    },
    expectValid: false,
  },
  {
    name: "live save rejects checkpoint path",
    params: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      expectedRevision: 0,
      idempotencyKey: "save-1",
      path: "C:/project.openreel.json",
    },
    expectValid: false,
  },
] as const;

function facadeCall(
  facade: Record<string, unknown>,
  verb: string,
): FacadeCall {
  const call = facade[verb];
  if (typeof call !== "function") {
    throw new Error(`production facade has no method for "${verb}"`);
  }
  return call as FacadeCall;
}

function createValidationOnlyLiveFacade() {
  // The corpus tests the public parameter boundary. Any valid request that
  // reaches project state gets a non-INVALID_PARAMS infrastructure failure;
  // malformed and cross-field-invalid requests must be rejected first.
  const store = new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw new Error(`schema corpus stopped at live store ${String(property)}`);
      };
    },
  }) as LiveProjectStore;
  return createLiveFacade({
    store,
    lease: new LiveWriterLease(),
    sessionId: "schema-corpus",
    // gate() enforces authorization BEFORE param validation; the corpus
    // asserts the INVALID_PARAMS boundary, so grant review write access.
    access: "write",
    reviewAccess: () => "write",
    artifactRoot: tmpdir(),
    mediaRoots: [MEDIA_ROOT, FONT_ROOT],
  });
}

function productionParams(verb: string, params: unknown): unknown {
  if (
    verb === "media.import_preflight" &&
    typeof params === "object" && params !== null &&
    typeof (params as { path?: unknown }).path === "string"
  ) {
    return { ...params, path: MEDIA_PREFLIGHT_PATH };
  }
  if (
    verb === "font.upload" &&
    typeof params === "object" && params !== null &&
    typeof (params as { filePath?: unknown }).filePath === "string" &&
    (params as { filePath: string }).filePath.length > 0
  ) return { ...params, filePath: FONT_PATH };
  return params;
}

function liveExpectedValid(verb: string, params: unknown, expected: boolean): boolean {
  if (
    expected &&
    (verb === "edit.apply" || verb === "edit.validate") &&
    typeof params === "object" &&
    params !== null &&
    Array.isArray((params as { ops?: unknown }).ops) &&
    (params as { ops: unknown[] }).ops.some(
      (op) => typeof op === "object" && op !== null &&
        (op as { op?: unknown }).op === "clip.add" &&
        (op as { clipId?: unknown }).clipId !== undefined,
    )
  ) {
    return false;
  }
  return expected;
}

async function expectBoundaryResult(
  call: FacadeCall,
  params: unknown,
  expectValid: boolean,
): Promise<void> {
  const result = await call(params);
  if (expectValid) {
    expect(result.ok ? undefined : result.error.code).not.toBe("INVALID_PARAMS");
  } else {
    expect(result.ok ? undefined : result.error.code).toBe("INVALID_PARAMS");
  }
}

describe("Decision 4 differential corpus — production facade boundaries", () => {
  it("covers every registered verb", () => {
    expect(Object.keys(VERB_SCHEMA_CORPUS).sort()).toEqual([...FACADE_VERBS].sort());
  });

  for (const [verb, cases] of Object.entries(VERB_SCHEMA_CORPUS)) {
    for (const testCase of cases) {
      it(`headless ${verb}: ${testCase.name}`, async () => {
        const facade = createAgentFacade({ mediaRoots: [MEDIA_ROOT, FONT_ROOT] }) as unknown as Record<string, unknown>;
        await expectBoundaryResult(
          facadeCall(facade, verb),
          productionParams(verb, testCase.params),
          testCase.expectValid,
        );
      });

      if (verb !== "project.save") {
        it(`live ${verb}: ${testCase.name}`, async () => {
          const facade = createValidationOnlyLiveFacade();
          try {
            await expectBoundaryResult(
              facadeCall(facade as unknown as Record<string, unknown>, verb),
              productionParams(verb, testCase.params),
              liveExpectedValid(verb, testCase.params, testCase.expectValid),
            );
          } finally {
            await facade.dispose();
          }
        });
      }
    }
  }

  for (const testCase of LIVE_PROJECT_SAVE_CASES) {
    it(`live project.save: ${testCase.name}`, async () => {
      const facade = createValidationOnlyLiveFacade();
      try {
        await expectBoundaryResult(
          facadeCall(facade as unknown as Record<string, unknown>, "project.save"),
          testCase.params,
          testCase.expectValid,
        );
      } finally {
        await facade.dispose();
      }
    });
  }

  it("keeps schema-valid cross-field cases rejected by both production boundaries", () => {
    const pins = Object.values(VERB_SCHEMA_CORPUS)
      .flat()
      .filter((testCase) => testCase.schemaValid === true && !testCase.expectValid);
    expect(pins.length).toBeGreaterThanOrEqual(3);
  });
});
