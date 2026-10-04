import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { endpointFilePath, handleRpc, validateLiveEndpointUrl } from "./index";
import type { LiveCommandClient } from "../reelctl/client";

const catalog = {
  ok: true as const,
  apiVersion: 1 as const,
  commands: [
    {
      name: "preview.render_frame",
      toolName: "preview_render_frame",
      description: "Render a project frame.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      effects: ["read", "task", "filesystem"],
      retry: "never" as const,
    },
  ],
};

function client(overrides: Partial<LiveCommandClient> = {}): LiveCommandClient {
  return {
    status: vi.fn().mockResolvedValue({ ok: true, apiVersion: 1, instanceId: "i1", projectId: "p1", projectEpoch: "epoch-a" }),
    catalog: vi.fn().mockResolvedValue(catalog),
    command: vi.fn(),
    artifact: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as LiveCommandClient;
}

describe("reelctl MCP adapter endpoint compatibility", () => {
  afterEach(() => {
    delete process.env.REELTERMINAL_LIVE_ENDPOINT_FILE;
  });

  it("defaults to the canonical live endpoint descriptor path", () => {
    expect(endpointFilePath()).toBe(path.join(os.homedir(), ".reelterminal", "live-endpoint.json"));
  });

  it("respects the ReelTerminal descriptor override", () => {
    process.env.REELTERMINAL_LIVE_ENDPOINT_FILE = path.join(os.tmpdir(), "new.json");
    expect(endpointFilePath()).toBe(process.env.REELTERMINAL_LIVE_ENDPOINT_FILE);
  });

  it("accepts only a plain HTTP loopback URL", () => {
    expect(validateLiveEndpointUrl("http://127.0.0.1:3210/mcp").hostname).toBe("127.0.0.1");
    expect(() => validateLiveEndpointUrl("https://127.0.0.1:3210/mcp")).toThrow();
    expect(() => validateLiveEndpointUrl("http://example.com/mcp")).toThrow();
  });
});

describe("live MCP Command API adapter", () => {
  it.each(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"])("preserves the old endpoint's supported protocol %s", async (version) => {
    const response = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } }, client());
    expect(response).toMatchObject({ result: { protocolVersion: version } });
  });

  it("lists every catalog tool with its generated schema", async () => {
    const api = client();
    const response = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, api);
    expect(response).toMatchObject({
      result: { tools: [{ name: "preview_render_frame", inputSchema: catalog.commands[0]!.inputSchema }] },
    });
    expect(api.catalog).toHaveBeenCalledWith();
  });

  it("forwards tool calls as canonical commands and preserves domain envelopes", async () => {
    const api = client({
      command: vi.fn().mockResolvedValue({ ok: false, error: { code: "CONFLICT", message: "revision changed" } }),
    });
    const response = await handleRpc({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "preview_render_frame", arguments: { timeSec: 4 } },
    }, api);
    expect(api.command).toHaveBeenCalledWith("preview.render_frame", { timeSec: 4 }, expect.objectContaining({ retry: "never" }));
    expect(response).toMatchObject({
      result: {
        isError: true,
        structuredContent: { ok: false, error: { code: "CONFLICT" } },
      },
    });
  });

  it("embeds only Command API verified PNG artifacts", async () => {
    const data = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const api = client({
      command: vi.fn().mockResolvedValue({
        ok: true,
        value: { artifact: { kind: "image", format: "png", path: "C:/private/artifact.png", sha256: "a".repeat(64) } },
      }),
      artifact: vi.fn().mockResolvedValue({ data, mimeType: "image/png" }),
    });
    const response = await handleRpc({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "preview_render_frame", arguments: { timeSec: 4 } },
    }, api);
    expect(api.artifact).toHaveBeenCalledWith("C:/private/artifact.png", "a".repeat(64));
    expect(response).toMatchObject({ result: { content: [{ type: "text" }, { type: "image", mimeType: "image/png", data }] } });
  });

  it("uses MCP errors for unknown tools and rejects malformed arguments", async () => {
    const api = client();
    expect(await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "unknown" } }, api))
      .toMatchObject({ error: { code: -32602 } });
    expect(await handleRpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "preview_render_frame", arguments: [] } }, api))
      .toMatchObject({ error: { code: -32602 } });
  });
});
