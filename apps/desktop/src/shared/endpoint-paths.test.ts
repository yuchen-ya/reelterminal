import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalEndpointPath,
  classifyDescriptorOwnership,
  describeWritebackDecision,
  endpointOverridePath,
  foreignDescriptorRefusal,
  isLoopbackHttpUrl,
  legacyEndpointPath,
  planLegacyCompatWriteback,
  probeDescriptorOwnership,
  probeLoopbackEndpointAlive,
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

describe("endpoint override resolution (readEnvAlias semantics)", () => {
  it("prefers the new REELTERMINAL_* name", () => {
    expect(
      endpointOverridePath(
        { REELTERMINAL_LIVE_ENDPOINT_FILE: "/n", OPENREEL_LIVE_ENDPOINT_FILE: "/o" },
        "live-endpoint",
      ),
    ).toBe("/n");
  });

  it("falls back to the legacy OPENREEL_* name", () => {
    expect(
      endpointOverridePath({ OPENREEL_LIVE_ENDPOINT_FILE: "/o" }, "live-endpoint"),
    ).toBe("/o");
  });

  it("treats an empty new name as set-and-empty, never consulting the old name", () => {
    expect(
      endpointOverridePath(
        { REELTERMINAL_LIVE_ENDPOINT_FILE: "", OPENREEL_LIVE_ENDPOINT_FILE: "/o" },
        "live-endpoint",
      ),
    ).toBe("");
  });

  it("returns undefined when neither name is set", () => {
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

describe("isLoopbackHttpUrl", () => {
  it("accepts loopback HTTP(S) URLs without credentials", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:9/mcp")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:9/mcp")).toBe(true);
    expect(isLoopbackHttpUrl("http://[::1]:9/mcp")).toBe(true);
  });

  it("rejects remote hosts, credentials, and junk", () => {
    expect(isLoopbackHttpUrl("https://example.com/mcp")).toBe(false);
    expect(isLoopbackHttpUrl("http://user:pw@127.0.0.1:9/mcp")).toBe(false);
    expect(isLoopbackHttpUrl("not a url")).toBe(false);
  });
});

describe("planLegacyCompatWriteback", () => {
  const liveTarget = (home: string) => canonicalEndpointPath(home, "live-endpoint");
  const deadProbe = async () => false;
  const aliveProbe = async () => true;

  it("declines explicit or non-canonical targets", async () => {
    const home = freshHome();
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: "/custom/live.json",
        explicitTarget: true,
        home,
        probeAlive: deadProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "explicit-target" });
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: "/custom/live.json",
        explicitTarget: false,
        home,
        probeAlive: deadProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "explicit-target" });
  });

  it("declines when no legacy descriptor exists", async () => {
    const home = freshHome();
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: liveTarget(home),
        explicitTarget: false,
        home,
        probeAlive: deadProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "no-legacy" });
  });

  it("writes back an owned, dead legacy descriptor (product and legacy-shape)", async () => {
    for (const content of [
      { product: ENDPOINT_PRODUCT_ID, url: "http://127.0.0.1:1/mcp", port: 1, token: "t" },
      { url: "http://127.0.0.1:1/mcp", port: 1, token: "t" },
    ]) {
      const home = freshHome();
      const legacy = legacyEndpointPath(home, "live-endpoint");
      writeDescriptor(legacy, content);
      expect(
        await planLegacyCompatWriteback({
          resource: "live-endpoint",
          targetPath: liveTarget(home),
          explicitTarget: false,
          home,
          probeAlive: deadProbe,
        }),
      ).toMatchObject({ writeback: true, reason: "owned-stale", legacyPath: legacy });
    }
  });

  it("declines foreign or unidentifiable legacy files without probing", async () => {
    const home = freshHome();
    const legacy = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(legacy, { product: "another-product", junk: true });
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: liveTarget(home),
        explicitTarget: false,
        home,
        probeAlive: aliveProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "foreign" });

    writeDescriptor(legacy, "}{");
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: liveTarget(home),
        explicitTarget: false,
        home,
        probeAlive: aliveProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "invalid" });
  });

  it("declines a legacy descriptor that is still being served", async () => {
    const home = freshHome();
    const legacy = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(legacy, { url: "http://127.0.0.1:9/mcp", port: 9, token: "t" });
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: liveTarget(home),
        explicitTarget: false,
        home,
        probeAlive: aliveProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "alive" });
    expect(describeWritebackDecision(await planLegacyCompatWriteback({
      resource: "live-endpoint",
      targetPath: liveTarget(home),
      explicitTarget: false,
      home,
      probeAlive: aliveProbe,
    }))).toContain("running instance");
  });

  it("declines a live descriptor whose URL is not loopback (probe refuses)", async () => {
    const home = freshHome();
    const legacy = legacyEndpointPath(home, "live-endpoint");
    writeDescriptor(legacy, { url: "https://example.com/mcp", port: 9, token: "t" });
    expect(
      await planLegacyCompatWriteback({
        resource: "live-endpoint",
        targetPath: liveTarget(home),
        explicitTarget: false,
        home,
        // The default probe would refuse non-loopback URLs; a fake probe
        // returning true must not be reached — descriptorEndpointUrl filters.
        probeAlive: aliveProbe,
      }),
    ).toMatchObject({ writeback: false, reason: "invalid" });
  });
});

describe("probeLoopbackEndpointAlive (default probe)", () => {
  it("sees a live loopback server and never sends credentials", async () => {
    const { createServer } = await import("node:http");
    let sawAuthorization: string | undefined;
    const server = createServer((req, res) => {
      sawAuthorization = req.headers.authorization;
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const alive = await probeLoopbackEndpointAlive(
        `http://127.0.0.1:${port}/mcp`,
        1_000,
      );
      expect(alive).toBe(true);
      // Credential safety: the liveness probe authenticates nothing.
      expect(sawAuthorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports dead endpoints as not alive", async () => {
    expect(
      await probeLoopbackEndpointAlive("http://127.0.0.1:1/mcp", 500),
    ).toBe(false);
  });

  it("refuses non-loopback URLs outright", async () => {
    expect(
      await probeLoopbackEndpointAlive("https://openreel.video/mcp", 500),
    ).toBe(false);
  });
});
