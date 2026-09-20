import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readEnvAlias } from "./env-alias";
import { endpointFilePath } from "../live-mcp/index";

/**
 * N02 env naming contract (docs/NAMING-AND-COMPATIBILITY.md §3), exercised on
 * the shared resolver plus one real main-process read point (the live
 * endpoint descriptor path). Resolution: new REELTERMINAL_* name set → use
 * it; else legacy OPENREEL_* name; else the built-in default.
 */

const NEW_FILE = "REELTERMINAL_LIVE_ENDPOINT_FILE";
const OLD_FILE = "OPENREEL_LIVE_ENDPOINT_FILE";

afterEach(() => {
  delete process.env[NEW_FILE];
  delete process.env[OLD_FILE];
});

describe("readEnvAlias precedence matrix (N02)", () => {
  it("1. new name set wins over the old name", () => {
    expect(readEnvAlias({ NEW: "n", OLD: "o" }, "NEW", "OLD")).toBe("n");
  });

  it("2. new name set to an empty string counts as set (no fallback)", () => {
    expect(readEnvAlias({ NEW: "", OLD: "o" }, "NEW", "OLD")).toBe("");
    expect(readEnvAlias({ NEW: "" }, "NEW", "OLD")).toBe("");
  });

  it("3. old name is used when the new name is unset", () => {
    expect(readEnvAlias({ OLD: "o" }, "NEW", "OLD")).toBe("o");
  });

  it("4. both unset → undefined (default logic stays at the call site)", () => {
    expect(readEnvAlias({}, "NEW", "OLD")).toBeUndefined();
  });
});

describe("live endpoint descriptor path aliasing (main-process representative)", () => {
  it("prefers REELTERMINAL_LIVE_ENDPOINT_FILE when both names are set", () => {
    process.env[NEW_FILE] = "C:/cfg/new.json";
    process.env[OLD_FILE] = "C:/cfg/old.json";
    expect(endpointFilePath()).toBe("C:/cfg/new.json");
  });

  it("falls back to OPENREEL_LIVE_ENDPOINT_FILE for legacy hosts", () => {
    delete process.env[NEW_FILE];
    process.env[OLD_FILE] = "C:/cfg/old.json";
    expect(endpointFilePath()).toBe("C:/cfg/old.json");
  });

  it("treats an empty new name as set-and-empty → built-in default path applies", () => {
    // The call site keeps its original `override.length > 0` semantics.
    process.env[NEW_FILE] = "";
    delete process.env[OLD_FILE];
    expect(endpointFilePath()).toContain(path.join(".reelterminal", "live-endpoint.json"));
  });

  it("uses the built-in default when neither name is set", () => {
    delete process.env[NEW_FILE];
    delete process.env[OLD_FILE];
    expect(endpointFilePath()).toContain(path.join(".reelterminal", "live-endpoint.json"));
  });
});
