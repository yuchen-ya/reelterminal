import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  getCommandCatalog,
  FACADE_CONTRACT_VERSION,
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
  type FacadeResult,
  type FacadeVerb,
} from "@reelterminal/agent-facade";
import {
  startLiveEndpointServer,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";

interface CallRecord {
  verb: FacadeVerb;
  params: unknown;
  guard?: { expectedProjectId?: string; expectedProjectEpoch?: string };
}

const calls: CallRecord[] = [];
let nextResult: FacadeResult<unknown> = {
  ok: true,
  value: { revision: 12 },
};

let tempDir: string;
let endpointFile: string;
let running: RunningLiveEndpoint;
let token: string;
let activity = 0;
let identity = {
  instanceId: "instance-test",
  projectId: "project-test",
  projectEpoch: "epoch-test",
  access: "write" as const,
  currentAction: null as string | null,
  enabled: true,
};

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ONE_PIXEL_PNG_SHA256 = createHash("sha256").update(ONE_PIXEL_PNG).digest("hex");

async function api(
  pathname: string,
  init: { method?: string; body?: unknown } = {},
  authToken = token,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(`${running.commandApiUrl}${pathname}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "openreel-live-endpoint-"));
  endpointFile = path.join(tempDir, "live-endpoint.json");
  running = await startLiveEndpointServer({
    callVerb: async (verb, params, guard) => {
      calls.push({ verb, params, ...(guard ? { guard } : {}) });
      return nextResult;
    },
    getStatus: () => identity,
    onExternalActivity: () => {
      activity += 1;
    },
    serverInfo: { name: "reelterminal-live", version: "test" },
    port: 0,
    endpointFilePath: endpointFile,
    artifactRoot: tempDir,
  });
  const file = JSON.parse(readFileSync(endpointFile, "utf8")) as {
    url: string;
    port: number;
    token: string;
    commandApi: { url: string; version: number };
  };
  expect(file.url).toBe(running.url);
  expect(file.url).toBe(running.commandApiUrl);
  expect(file.commandApi).toEqual({ url: running.commandApiUrl, version: 1 });
  expect(file.port).toBe(running.port);
  token = file.token;
});

afterAll(async () => {
  await running.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("live endpoint authentication + descriptor", () => {
  it("refuses to bind the authenticated API beyond the IPv4 loopback interface", async () => {
    await expect(startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "reelterminal-live", version: "test" },
      host: "0.0.0.0",
      port: 0,
      endpointFilePath: path.join(tempDir, "non-loopback.json"),
    })).rejects.toThrow("may only bind to 127.0.0.1");
    expect(existsSync(path.join(tempDir, "non-loopback.json"))).toBe(false);
  });

  it("rejects API requests without a token or with the wrong token", async () => {
    expect((await api("/status", {}, "")).status).toBe(401);
    expect((await api("/status", {}, "wrong")).status).toBe(401);
  });

  it("enforces the documented route and methods", async () => {
    const wrongMethod = await api("/command", { method: "GET" });
    expect(wrongMethod.status).toBe(405);
    const unknown = await fetch(`http://127.0.0.1:${running.port}/elsewhere`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unknown.status).toBe(404);
    const removedMcp = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(removedMcp.status).toBe(404);
    expect((await api("/status")).status).toBe(200);
  });

  it("writes the endpoint file mode 0600 and deletes it on close", async () => {
    // Windows has no POSIX permission bits; the mode check is POSIX-only.
    if (process.platform !== "win32") {
      const mode = statSync(endpointFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const closed = await startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "reelterminal-live", version: "test" },
      port: 0,
      endpointFilePath: path.join(tempDir, "second-endpoint.json"),
    });
    expect(existsSync(closed.endpointFile)).toBe(true);
    await closed.close();
    expect(existsSync(closed.endpointFile)).toBe(false);
  });

  it("atomically replaces a stale descriptor without leaving temporary files", async () => {
    const staleFile = path.join(tempDir, "stale-endpoint.json");
    writeFileSync(staleFile, '{"stale":true}\n', { mode: 0o644 });
    const replacement = await startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "reelterminal-live", version: "test" },
      port: 0,
      endpointFilePath: staleFile,
    });
    try {
      const descriptor = JSON.parse(readFileSync(staleFile, "utf8")) as {
        url: string;
        port: number;
        token: string;
      };
      expect(descriptor.url).toBe(replacement.url);
      expect(descriptor.port).toBe(replacement.port);
      expect(descriptor.token).toHaveLength(64);
      if (process.platform !== "win32") {
        expect(statSync(staleFile).mode & 0o777).toBe(0o600);
      }
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith("stale-endpoint.json.")),
      ).toEqual([]);
    } finally {
      await replacement.close();
    }
  });

  it("never leaks the token into any response body", async () => {
    const bodies: unknown[] = [];
    const status = await api("/status");
    bodies.push(await status.json());
    const list = await api("/catalog");
    bodies.push(await list.json());
    const unauthorized = await api("/catalog", {}, "");
    bodies.push(await unauthorized.json());
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain(token);
    }
  });
});

describe("live protocol-neutral Command API", () => {
  it("authenticates all API routes and enforces method and body limits", async () => {
    expect((await api("/status", {}, "")).status).toBe(401);
    expect((await api("/command", {}, token)).status).toBe(405);
    const oversized = await api("/command", {
      body: { command: "timeline.query", arguments: { padding: "x".repeat(4 * 1024 * 1024) } },
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  });

  it("exposes safe status fields and keeps authenticated status reads active", async () => {
    const before = activity;
    const res = await api("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      apiVersion: 1,
      contractVersion: FACADE_CONTRACT_VERSION,
      serverInfo: { name: "reelterminal-live", version: "test" },
      instanceId: "instance-test",
      projectId: "project-test",
      projectEpoch: "epoch-test",
      access: "write",
      currentAction: null,
      enabled: true,
    });
    expect(activity).toBe(before + 1);
  });

  it("serves the live command catalog and exact catalog-entry schemas", async () => {
    const response = await api("/catalog");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      apiVersion: number;
      commands: Array<{ name: string; toolName: string; inputSchema: unknown }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.apiVersion).toBe(1);
    expect(payload.commands).toEqual(getCommandCatalog("live"));
    expect(payload.commands.some((entry) => entry.name === "media.inspect")).toBe(true);

    const entry = await api("/catalog/edit.apply");
    expect(entry.status).toBe(200);
    const single = await entry.json() as { command: { name: string; inputSchema: unknown } };
    expect(single.command.name).toBe("edit.apply");
    expect(single.command.inputSchema).toEqual(LIVE_VERB_INPUT_SCHEMA_OVERRIDES["edit.apply"]);
    expect((await api("/catalog?mode=headless")).status).toBe(400);
  });

  it("routes commands through the existing facade dispatcher and forwards identity guards", async () => {
    calls.length = 0;
    nextResult = { ok: true, value: { revision: 13 } };
    const result = await api("/command", {
      body: {
        command: "edit.apply",
        arguments: { ops: [{ op: "track.add" }] },
        expectedProjectId: "project-test",
        expectedProjectEpoch: "epoch-test",
      },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(nextResult);
    expect(calls).toEqual([{
      verb: "edit.apply",
      params: { ops: [{ op: "track.add" }] },
      guard: {
        expectedProjectId: "project-test",
        expectedProjectEpoch: "epoch-test",
      },
    }]);

    const stale = await api("/command", {
      body: {
        command: "edit.apply",
        arguments: {},
        expectedProjectEpoch: "stale-epoch",
      },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(calls).toHaveLength(1);
  });

  it("rejects malformed and unknown commands with stable JSON errors", async () => {
    const malformed = await api("/command", { body: { command: "edit.apply", arguments: [] } });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    const unknown = await api("/command", { body: { command: "edit_apply", arguments: {} } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("returns a verified artifact only from the configured root and for its content hash", async () => {
    const imagePath = path.join(tempDir, "artifact.png");
    writeFileSync(imagePath, ONE_PIXEL_PNG);
    const query = `/artifact?path=${encodeURIComponent(imagePath)}&sha256=${ONE_PIXEL_PNG_SHA256}`;
    const image = await api(query);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(ONE_PIXEL_PNG);

    const wrongHash = await api(`/artifact?path=${encodeURIComponent(imagePath)}&sha256=${"0".repeat(64)}`);
    expect(wrongHash.status).toBe(404);
  });
});

// Regression: a descriptor write failure inside the listen callback
// must reject startLiveEndpointServer (aligning with the bind-failure path)
// instead of leaving the enable() promise pending forever.
describe("live endpoint descriptor write failure", () => {
  it("rejects instead of hanging when the endpoint file cannot be written, and allows retry", async () => {
    // The descriptor's parent path exists as a FILE, so the mkdirSync inside
    // writeEndpointFile throws — the same failure shape as an unwritable
    // ~/.openreel, reached without touching the real home directory.
    const blocker = path.join(tempDir, "write-blocked");
    writeFileSync(blocker, "not a directory\n");
    const blockedFile = path.join(blocker, "live-endpoint.json");

    let failure: unknown;
    try {
      await startLiveEndpointServer({
        callVerb: async () => ({ ok: true, value: {} }),
        serverInfo: { name: "reelterminal-live", version: "test" },
        port: 0,
        endpointFilePath: blockedFile,
      });
      expect.unreachable(
        "startLiveEndpointServer must reject when the descriptor cannot be written",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);

    // The lifecycle is not wedged: a retry against a writable path settles
    // normally, publishes the descriptor, and closes cleanly.
    const retried = await startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "reelterminal-live", version: "test" },
      port: 0,
      endpointFilePath: path.join(tempDir, "retry-endpoint.json"),
    });
    expect(existsSync(retried.endpointFile)).toBe(true);
    await retried.close();
    expect(existsSync(retried.endpointFile)).toBe(false);
  });
});
