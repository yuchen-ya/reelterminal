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
  chmodSync,
} from "node:fs";
import { createServer } from "node:http";
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
  delete process.env.OPENREEL_LIVE_ENDPOINT_FILE;
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

  it("旧→新: replaces a dead owned legacy descriptor (atomic write-back) and cleans up on close", async () => {
    const home = freshHome();
    writeDescriptor(home.legacy, DEAD_LEGACY_DESCRIPTOR);
    if (process.platform !== "win32") {
      chmodSync(home.legacy, 0o600);
    }
    const running = await start(home);
    try {
      // Canonical descriptor published…
      expect(readDescriptor(home.canonical).product).toBe(ENDPOINT_PRODUCT_ID);
      // …and the legacy descriptor atomically republished to this instance
      // so read-only-legacy (old) connectors discover the new host.
      const mirror = readDescriptor(home.legacy);
      expect(mirror.url).toBe(running.url);
      expect(mirror.port).toBe(running.port);
      expect(mirror.product).toBe(ENDPOINT_PRODUCT_ID);
      expect(mirror.token).toHaveLength(64);
      if (process.platform !== "win32") {
        expect(statSync(home.legacy).mode & 0o777).toBe(0o600);
      }
      // A single publish = one rename: no partial temporary files remain.
      expect(readdirSync(path.dirname(home.legacy)).filter((name) =>
        name.endsWith(".tmp"),
      )).toEqual([]);
      expect(readdirSync(path.dirname(home.canonical)).filter((name) =>
        name.endsWith(".tmp"),
      )).toEqual([]);
    } finally {
      await running.close();
    }
    // Both owned descriptors are removed; the legacy directory remains.
    expect(existsSync(home.canonical)).toBe(false);
    expect(existsSync(home.legacy)).toBe(false);
    expect(existsSync(path.dirname(home.legacy))).toBe(true);

    // Idempotent restart: with no legacy file present, nothing is mirrored.
    const second = await start(home);
    try {
      expect(existsSync(home.legacy)).toBe(false);
    } finally {
      await second.close();
    }
  });

  it("旧→新 again: the replica descriptor is removed with the host, twice in a row", async () => {
    const home = freshHome();
    for (let round = 0; round < 2; round += 1) {
      writeDescriptor(home.legacy, DEAD_LEGACY_DESCRIPTOR);
      const running = await start(home);
      expect(readDescriptor(home.legacy).url).toBe(running.url);
      await running.close();
      expect(existsSync(home.legacy)).toBe(false);
      expect(existsSync(home.canonical)).toBe(false);
    }
  });

  it("陈旧坏 JSON: an unidentifiable legacy file is left untouched and logged", async () => {
    const home = freshHome();
    mkdirSync(path.dirname(home.legacy), { recursive: true });
    writeFileSync(home.legacy, "{ truncated", { mode: 0o600 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = await start(home);
    try {
      expect(readDescriptor(home.canonical).product).toBe(ENDPOINT_PRODUCT_ID);
      expect(readFileSync(home.legacy, "utf8")).toBe("{ truncated");
      const notes = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("could not be identified"));
      expect(notes).toHaveLength(1);
      // Credential safety: the log names the path and reason only.
      expect(notes[0]).not.toContain("token");
    } finally {
      errorSpy.mockRestore();
      await running.close();
    }
    expect(readFileSync(home.legacy, "utf8")).toBe("{ truncated");
    expect(existsSync(home.canonical)).toBe(false);
  });

  it("陈旧活跃端口: a live publisher behind the legacy descriptor blocks the write-back", async () => {
    const home = freshHome();
    let sawAuthorization: string | undefined;
    let requests = 0;
    const publisher = createServer((req, res) => {
      requests += 1;
      sawAuthorization = req.headers.authorization;
      res.writeHead(401).end();
    });
    await new Promise<void>((resolve) => publisher.listen(0, "127.0.0.1", resolve));
    const address = publisher.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const legacyContent = {
      url: `http://127.0.0.1:${port}/mcp`,
      port,
      token: "1".repeat(64),
    };
    writeDescriptor(home.legacy, legacyContent);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let running: RunningLiveEndpoint | undefined;
    try {
      running = await start(home);
      // The pre-existing descriptor still belongs to the running instance.
      expect(readDescriptor(home.legacy)).toEqual(legacyContent);
      const notes = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("running instance"));
      expect(notes).toHaveLength(1);
      // The liveness probe sent no Authorization header — credentials never
      // leave the descriptor file.
      expect(requests).toBeGreaterThanOrEqual(1);
      expect(sawAuthorization).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      await running?.close();
      await new Promise<void>((resolve) => publisher.close(() => resolve()));
    }
    expect(readDescriptor(home.legacy)).toEqual(legacyContent);
    expect(existsSync(home.canonical)).toBe(false);
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
      const notes = errorSpy.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("belongs to another product"));
      expect(notes).toHaveLength(1);
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
