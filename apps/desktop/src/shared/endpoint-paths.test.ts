import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalEndpointPath,
  classifyDescriptorOwnership,
  endpointOverridePath,
  foreignDescriptorRefusal,
  legacyEndpointPath,
  probeDescriptorOwnership,
  resolveEndpointReadPath,
  ENDPOINT_PRODUCT_ID,
  type EndpointResource,
} from "./endpoint-paths";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function freshHome(): string {
  tempDir = mkdtempSync(path.join(tmpdir(), "reelterminal-endpoint-paths-"));
  return tempDir;
}

function writeDescriptor(filePath: string, content: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    typeof content === "string" ? content : `${JSON.stringify(content)}\n`,
  );
}

const RESOURCES: EndpointResource[] = ["live-endpoint"];

describe("endpoint path constants", () => {
  it.each(RESOURCES)(
    "canonical path is ~/.reelterminal/<resource>, legacy is ~/.openreel/<resource>: %s",
    (resource) => {
      const fileName = "live-endpoint.json";
      expect(canonicalEndpointPath("/home/u", resource)).toBe(
        path.join("/home/u", ".reelterminal", fileName),
      );
      expect(legacyEndpointPath("/home/u", resource)).toBe(
        path.join("/home/u", ".openreel", fileName),
      );
    },
  );
});

describe("endpoint override resolution", () => {
  it("reads the REELTERMINAL_* override", () => {
    expect(
      endpointOverridePath(
        { REELTERMINAL_LIVE_ENDPOINT_FILE: "/n" },
        "live-endpoint",
      ),
    ).toBe("/n");
  });


  it("preserves an empty override", () => {
    expect(
      endpointOverridePath(
        { REELTERMINAL_LIVE_ENDPOINT_FILE: "" },
        "live-endpoint",
      ),
    ).toBe("");
  });

  it("returns undefined when the override is unset", () => {
    expect(endpointOverridePath({}, "live-endpoint")).toBeUndefined();
  });
});

describe("resolveEndpointReadPath", () => {
  const liveOwned = {
    url: "http://127.0.0.1:9/mcp",
    port: 9,
    token: "a".repeat(64),
  };
  const liveForeign = {
    product: "someone-else",
    url: "http://127.0.0.1:9/mcp",
    port: 9,
    token: "a".repeat(64),
  };

  it("returns the accepted override verbatim", () => {
    const home = freshHome();
    const resolution = resolveEndpointReadPath("live-endpoint", {
      env: { REELTERMINAL_LIVE_ENDPOINT_FILE: "/explicit/live.json" },
      home,
      exists: () => true,
    });
    expect(resolution).toEqual({ path: "/explicit/live.json" });
  });

  it("prefers the canonical file when both paths exist and legacy is owned", () => {
    const home = freshHome();
    const canonical = canonicalEndpointPath(home, "live-endpoint");
    writeDescriptor(canonical, liveOwned);
    writeDescriptor(legacyEndpointPath(home, "live-endpoint"), liveOwned);
    const resolution = resolveEndpointReadPath("live-endpoint", { env: {}, home });
    expect(resolution).toEqual({ path: canonical });
  });

  it("reports a conflict when both exist and the legacy descriptor is foreign", () => {
    const home = freshHome();
    const canonical = canonicalEndpointPath(home, "live-endpoint");
    writeDescriptor(canonical, liveOwned);
    writeDescriptor(legacyEndpointPath(home, "live-endpoint"), liveForeign);
    const resolution = resolveEndpointReadPath("live-endpoint", { env: {}, home });
    expect(resolution.conflict).toContain("another product");
    expect(resolution.conflict).toContain("someone-else");
    expect(resolution.conflict).toContain("REELTERMINAL_LIVE_ENDPOINT_FILE");
    // The message names paths and the product id only — never contents.
    expect(resolution.conflict).not.toContain("a".repeat(64));
  });

  it("discovers an owned legacy descriptor when the canonical path is absent", () => {
    const home = freshHome();
    const legacy = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(legacy, liveOwned);
    const resolution = resolveEndpointReadPath("live-endpoint", { env: {}, home });
    expect(resolution).toEqual({ path: legacy, legacyDiscovery: true });
  });

  it("refuses an unidentifiable legacy descriptor instead of reading it", () => {
    const home = freshHome();
    const legacy = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(legacy, "{not json");
    const resolution = resolveEndpointReadPath("live-endpoint", { env: {}, home });
    expect(resolution.conflict).toContain("not a readable ReelTerminal");
  });

  it("falls back to the canonical path when nothing exists", () => {
    const home = freshHome();
    const resolution = resolveEndpointReadPath("live-endpoint", { env: {}, home });
    expect(resolution).toEqual({
      path: canonicalEndpointPath(home, "live-endpoint"),
    });
  });
});

describe("descriptor ownership classification", () => {
  it("accepts an explicit reelterminal product marker", () => {
    expect(classifyDescriptorOwnership("live-endpoint", { product: ENDPOINT_PRODUCT_ID })).toBe(
      "product",
    );
  });

  it("marks a foreign product marker as foreign even when the shape matches", () => {
    expect(
      classifyDescriptorOwnership("live-endpoint", {
        product: "other-app",
        url: "http://127.0.0.1:1/mcp",
        port: 1,
        token: "x",
      }),
    ).toBe("foreign");
  });

  it("recognizes the legacy live endpoint shape {url, port, token}", () => {
    expect(
      classifyDescriptorOwnership("live-endpoint", {
        url: "http://127.0.0.1:1/mcp",
        port: 1,
        token: "x",
      }),
    ).toBe("legacy-shape");
    // A missing port does not match the supported legacy shape.
    expect(
      classifyDescriptorOwnership("live-endpoint", { url: "http://127.0.0.1:1/mcp", token: "x" }),
    ).toBe("invalid");
  });

  it("classifies non-JSON values as invalid", () => {
    expect(classifyDescriptorOwnership("live-endpoint", "junk")).toBe("invalid");
    expect(classifyDescriptorOwnership("live-endpoint", null)).toBe("invalid");
    expect(classifyDescriptorOwnership("live-endpoint", [1, 2])).toBe("invalid");
  });

  it("probeDescriptorOwnership never throws and never returns contents", () => {
    const home = freshHome();
    const file = legacyEndpointPath(home, "live-endpoint");
    expect(probeDescriptorOwnership(file, "live-endpoint")).toEqual({
      kind: "unreadable",
    });
    writeDescriptor(file, "{ truncated");
    expect(probeDescriptorOwnership(file, "live-endpoint")).toEqual({
      kind: "ownership",
      ownership: "invalid",
    });
  });
});

describe("foreignDescriptorRefusal (explicit host targets)", () => {
  it("refuses a foreign descriptor and names the product and override", () => {
    const home = freshHome();
    const file = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(file, { product: "rival-app" });
    const message = foreignDescriptorRefusal("live-endpoint", file);
    expect(message).toContain("rival-app");
    expect(message).toContain("REELTERMINAL_LIVE_ENDPOINT_FILE");
    expect(message).toContain(file);
  });

  it("allows absent or owned targets", () => {
    const home = freshHome();
    const file = legacyEndpointPath(home, "live-endpoint");
    expect(foreignDescriptorRefusal("live-endpoint", file)).toBeUndefined();
    writeDescriptor(file, { product: ENDPOINT_PRODUCT_ID });
    expect(foreignDescriptorRefusal("live-endpoint", file)).toBeUndefined();
  });
});
