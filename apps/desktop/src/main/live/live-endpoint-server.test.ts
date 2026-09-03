import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EMITTED_VERB_JSON_SCHEMAS,
  FACADE_VERBS,
  type FacadeResult,
  type FacadeVerb,
} from "@openreel/agent-facade";
import {
  startLiveEndpointServer,
  toolNameForVerb,
  type RunningLiveEndpoint,
} from "./live-endpoint-server";

interface CallRecord {
  verb: FacadeVerb;
  params: unknown;
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

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function rpc(body: unknown, authToken?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(running.url, { method: "POST", headers, body: JSON.stringify(body) });
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "openreel-live-endpoint-"));
  endpointFile = path.join(tempDir, "live-endpoint.json");
  running = await startLiveEndpointServer({
    callVerb: async (verb, params) => {
      calls.push({ verb, params });
      return nextResult;
    },
    onExternalActivity: () => {
      activity += 1;
    },
    serverInfo: { name: "openreel-live", version: "test" },
    port: 0,
    endpointFilePath: endpointFile,
    artifactRoot: tempDir,
  });
  const file = JSON.parse(readFileSync(endpointFile, "utf8")) as {
    url: string;
    port: number;
    token: string;
  };
  expect(file.url).toBe(running.url);
  expect(file.port).toBe(running.port);
  token = file.token;
});

afterAll(async () => {
  await running.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("live endpoint auth + transport", () => {
  it("rejects requests without a token (401)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token (401)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong");
    expect(res.status).toBe(401);
  });

  it("rejects non-POST methods (405)", async () => {
    const res = await fetch(running.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it("POST to a non-/mcp path is 404, never an accepted request", async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/elsewhere`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
    // The real path keeps working.
    const ok = await rpc({ jsonrpc: "2.0", id: 2, method: "ping" }, token);
    expect(ok.status).toBe(200);
  });

  it("writes the endpoint file mode 0600 and deletes it on close", async () => {
    const mode = statSync(endpointFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const closed = await startLiveEndpointServer({
      callVerb: async () => ({ ok: true, value: {} }),
      serverInfo: { name: "openreel-live", version: "test" },
      port: 0,
      endpointFilePath: path.join(tempDir, "second-endpoint.json"),
    });
    expect(existsSync(closed.endpointFile)).toBe(true);
    await closed.close();
    expect(existsSync(closed.endpointFile)).toBe(false);
  });

  it("never leaks the token into any response body", async () => {
    const bodies: unknown[] = [];
    const init = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      token,
    );
    bodies.push(await init.json());
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token);
    bodies.push(await list.json());
    const unauthorized = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    bodies.push(await unauthorized.json());
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain(token);
    }
  });
});

describe("live endpoint MCP protocol", () => {
  it("negotiates initialize: echoes a supported version, defaults an unknown one", async () => {
    const supported = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      token,
    );
    const supportedJson = (await supported.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(supportedJson.result.protocolVersion).toBe("2025-06-18");
    expect(supportedJson.result.serverInfo.name).toBe("openreel-live");

    const unknown = await rpc(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      token,
    );
    const unknownJson = (await unknown.json()) as {
      result: { protocolVersion: string };
    };
    expect(unknownJson.result.protocolVersion).toBe("2024-11-05");
  });

  it("answers ping", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, token);
    const json = (await res.json()) as { result: Record<string, never> };
    expect(json.result).toEqual({});
  });

  it("tools/list returns exactly the 17 facade tools, schemas verbatim, no renderer round-trip", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
    const json = (await res.json()) as {
      result: {
        tools: Array<{ name: string; description: string; inputSchema: unknown }>;
      };
    };
    const tools = json.result.tools;
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.name)).toEqual(FACADE_VERBS.map(toolNameForVerb));
    expect(tools.some((t) => t.name === "editor_get_context")).toBe(true);
    // The inputSchema is the facade emission, verbatim (no copy drift) —
    // except live-honest overrides: live project.save takes no params (the
    // GUI owns the save target), so the checkpoint schema with required
    // `path` must NOT be advertised.
    const editApply = tools.find((t) => t.name === "edit_apply");
    expect(editApply?.inputSchema).toEqual(EMITTED_VERB_JSON_SCHEMAS["edit.apply"]);
    const projectSave = tools.find((t) => t.name === "project_save");
    expect(projectSave?.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(projectSave?.inputSchema).not.toEqual(EMITTED_VERB_JSON_SCHEMAS["project.save"]);
    // tools/list is answered in main — no facade call happened for it.
    expect(calls).toHaveLength(0);
  });

  it("tools/call dispatches to the facade and maps isError from the result", async () => {
    calls.length = 0;
    nextResult = { ok: true, value: { revision: 12, applied: [], replayed: false } };
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "edit_apply", arguments: { ops: [{ op: "track.add" }] } },
      },
      token,
    );
    const json = (await res.json()) as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: unknown;
        isError: boolean;
      };
    };
    expect(calls).toEqual([
      { verb: "edit.apply", params: { ops: [{ op: "track.add" }] } },
    ]);
    expect(json.result.isError).toBe(false);
    expect(json.result.content).toHaveLength(1);
    expect(json.result.content[0]!.text).toBe(JSON.stringify(nextResult));
    expect(json.result.structuredContent).toEqual(nextResult);

    nextResult = {
      ok: false,
      error: { code: "CONFLICT", message: "revision conflict" },
    };
    const failed = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project_save" } },
      token,
    );
    const failedJson = (await failed.json()) as { result: { isError: boolean } };
    expect(failedJson.result.isError).toBe(true);
  });

  it("embeds a facade-contained visual PNG as an MCP image block", async () => {
    const sheetPath = path.join(tempDir, "visual", "contact-sheet.png");
    const sheetDir = path.dirname(sheetPath);
    // The endpoint only exposes files beneath the configured artifact root;
    // use a real PNG so this also exercises the transport signature check.
    mkdirSync(sheetDir, { recursive: true });
    writeFileSync(sheetPath, ONE_PIXEL_PNG);
    nextResult = {
      ok: true,
      value: {
        revision: 12,
        sourceRevision: 12,
        frames: [],
        contactSheet: { path: sheetPath, format: "png", sizeBytes: ONE_PIXEL_PNG.length },
      },
    };
    const res = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "visual_inspect", arguments: { clipId: "c1" } } },
      token,
    );
    const json = (await res.json()) as {
      result: { content: Array<{ type: string; data?: string; mimeType?: string }> };
    };
    expect(json.result.content).toHaveLength(2);
    expect(json.result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(json.result.content[1]?.data).toBe(ONE_PIXEL_PNG.toString("base64"));
  });

  it("falls back to a valid frame when the contact sheet is missing", async () => {
    const framePath = path.join(tempDir, "visual", "frame-fallback.png");
    mkdirSync(path.dirname(framePath), { recursive: true });
    writeFileSync(framePath, ONE_PIXEL_PNG);
    nextResult = {
      ok: true,
      value: {
        revision: 12,
        sourceRevision: 12,
        contactSheet: { path: path.join(tempDir, "visual", "missing-sheet.png") },
        frames: [{ artifact: { path: framePath } }],
      },
    };
    const res = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "visual_inspect", arguments: {} } },
      token,
    );
    const json = (await res.json()) as {
      result: { content: Array<{ type: string; data?: string; text?: string; mimeType?: string }> };
    };
    const image = json.result.content.find((block) => block.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG.toString("base64") });
    expect(json.result.content.some((block) => block.text?.includes("not embedded"))).toBe(true);
  });

  it("unknown tool is a protocol error, never a domain result", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope_nope" } },
      token,
    );
    const json = (await res.json()) as { error: { code: number; message: string } };
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("Unknown tool");
  });

  it("fires onExternalActivity on initialize and tools/call", async () => {
    const before = activity;
    await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, token);
    await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping" } },
      token,
    );
    expect(activity).toBeGreaterThan(before);
  });
});
