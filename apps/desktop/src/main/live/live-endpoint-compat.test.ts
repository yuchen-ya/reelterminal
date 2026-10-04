import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startLiveEndpointServer,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";
import {
  canonicalEndpointPath,
  ENDPOINT_PRODUCT_ID,
  resolveEndpointReadPath,
} from "../../shared/endpoint-paths";
import { readEndpoint } from "../../live-mcp/index";

/**
 * Every fixture lives in a per-test temporary home; the real ~/.reelterminal and
 * ~/.openreel are never touched and descriptor contents are never printed —
 * assertions look at structural fields only.
 */

interface Home {
  root: string;
  canonical: string;
  legacy: string;
}

const homes: string[] = [];

function freshHome(): Home {
  const root = mkdtempSync(path.join(tmpdir(), "reelterminal-live-compat-"));
  homes.push(root);
  return {
    root,
    canonical: canonicalEndpointPath(root, "live-endpoint"),
    legacy: path.join(root, ".openreel", "live-endpoint.json"),
  };
}

afterEach(() => {
  delete process.env.REELTERMINAL_LIVE_ENDPOINT_FILE;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

function writeDescriptor(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(content)}\n`, { mode: 0o600 });
}

function readDescriptor(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

async function start(home: Home): Promise<RunningLiveEndpoint> {
  return startLiveEndpointServer({
    callVerb: async () => ({ ok: true, value: {} }),
    serverInfo: { name: "reelterminal-live", version: "test" },
    port: 0,
    home: home.root,
  });
}

const DEAD_LEGACY_DESCRIPTOR = {
  // Port 1 has no test server listening and provides an unmarked fixture.
  url: "http://127.0.0.1:1/mcp",
  port: 1,
  token: "0".repeat(64),
};

describe("live endpoint compatibility", () => {
  it("新→新: serves the canonical descriptor and never creates a legacy file", async () => {
    const home = freshHome();
    const running = await start(home);
    try {
      expect(running.endpointFile).toBe(home.canonical);
      const descriptor = readDescriptor(home.canonical);
      expect(descriptor.product).toBe(ENDPOINT_PRODUCT_ID);
      expect(descriptor.url).toBe(running.url);
      expect(descriptor.port).toBe(running.port);
      expect(typeof descriptor.token).toBe("string");
      if (process.platform !== "win32") {
        expect(statSync(home.canonical).mode & 0o777).toBe(0o600);
      }
      // The connector resolves the canonical path with no discovery.
      expect(
        resolveEndpointReadPath("live-endpoint", { env: {}, home: home.root }),
      ).toEqual({ path: home.canonical });
      expect(existsSync(home.legacy)).toBe(false);
    } finally {
      await running.close();
    }
    expect(existsSync(home.canonical)).toBe(false);
    expect(existsSync(path.dirname(home.canonical))).toBe(true);
    // No temporary residue in either directory.
    expect(readdirSync(path.dirname(home.canonical))).toEqual([]);
  });

  it("discovers an owned legacy descriptor", async () => {
    const home = freshHome();
    writeDescriptor(home.legacy, DEAD_LEGACY_DESCRIPTOR);
    const resolution = resolveEndpointReadPath("live-endpoint", {
      env: {},
      home: home.root,
    });
    expect(resolution).toEqual({ path: home.legacy, legacyDiscovery: true });
    // And the connector actually loads it (structural assertions only).
    const loaded = readEndpoint(home.root);
    expect(loaded.url).toBe(DEAD_LEGACY_DESCRIPTOR.url);
    expect(loaded.token).toBe(DEAD_LEGACY_DESCRIPTOR.token);
  });





  it("publishes only the canonical descriptor and leaves a saved legacy descriptor untouched", async () => {
    const home = freshHome();
    writeDescriptor(home.legacy, DEAD_LEGACY_DESCRIPTOR);
    const running = await start(home);
    try {
      expect(readDescriptor(home.canonical).product).toBe(ENDPOINT_PRODUCT_ID);
      expect(readDescriptor(home.legacy)).toEqual(DEAD_LEGACY_DESCRIPTOR);
    } finally {
      await running.close();
    }
    expect(existsSync(home.canonical)).toBe(false);
    expect(readDescriptor(home.legacy)).toEqual(DEAD_LEGACY_DESCRIPTOR);
  });

  it("新旧并存且身份不一致: the host serves canonical and never overwrites a foreign legacy file", async () => {
    const home = freshHome();
    const foreign = {
      product: "upstream-other-app",
      url: "http://127.0.0.1:1/mcp",
      port: 1,
      token: "2".repeat(64),
    };
    writeDescriptor(home.legacy, foreign);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = await start(home);
    try {
      expect(running.endpointFile).toBe(home.canonical);
      expect(readDescriptor(home.legacy)).toEqual(foreign);
    } finally {
      errorSpy.mockRestore();
      await running.close();
    }
    expect(readDescriptor(home.legacy)).toEqual(foreign);
  });

  it("新旧并存且身份不一致: the connector refuses to guess and asks for an explicit path", async () => {
    const home = freshHome();
    writeDescriptor(home.canonical, {
      product: ENDPOINT_PRODUCT_ID,
      url: "http://127.0.0.1:9/mcp",
      port: 9,
      token: "3".repeat(64),
    });
    writeDescriptor(home.legacy, {
      product: "upstream-other-app",
      url: "http://127.0.0.1:1/mcp",
      port: 1,
      token: "4".repeat(64),
    });
    const resolution = resolveEndpointReadPath("live-endpoint", {
      env: {},
      home: home.root,
    });
    expect(resolution.conflict).toContain("another product");
    expect(resolution.conflict).toContain("REELTERMINAL_LIVE_ENDPOINT_FILE");
    // The connector surfaces the conflict as a startup failure.
    expect(() => readEndpoint(home.root)).toThrow(/another product/);
  });

  it("显式 override 指向另一产品: the host refuses to start instead of rewriting it", async () => {
    const home = freshHome();
    const overrideTarget = path.join(home.root, "override", "live-endpoint.json");
    writeDescriptor(overrideTarget, {
      product: "someone-elses-session",
      url: "http://127.0.0.1:1/mcp",
      port: 1,
      token: "5".repeat(64),
    });
    await expect(
      startLiveEndpointServer({
        callVerb: async () => ({ ok: true, value: {} }),
        serverInfo: { name: "reelterminal-live", version: "test" },
        port: 0,
        endpointFilePath: overrideTarget,
      }),
    ).rejects.toThrow(/another product.*someone-elses-session/s);
    // The foreign file was not modified.
    expect(readDescriptor(overrideTarget).product).toBe("someone-elses-session");
  });

  it("starts with an explicit override to an owned legacy descriptor", async () => {
    const home = freshHome();
    const overrideTarget = path.join(home.root, "override", "live-endpoint.json");
    writeDescriptor(overrideTarget, DEAD_LEGACY_DESCRIPTOR);
    const running = await startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "reelterminal-live", version: "test" },
      port: 0,
      endpointFilePath: overrideTarget,
    });
    try {
      const descriptor = readDescriptor(overrideTarget);
      expect(descriptor.product).toBe(ENDPOINT_PRODUCT_ID);
      expect(descriptor.url).toBe(running.url);
      // An explicit target is fully user-managed: no legacy mirror.
      expect(existsSync(home.legacy)).toBe(false);
    } finally {
      await running.close();
    }
  });
});
