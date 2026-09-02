import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { endpointFilePath, forwardLine, validateLiveEndpointUrl } from "./index";

describe("live MCP endpoint selection", () => {
  afterEach(() => {
    delete process.env.OPENREEL_LIVE_ENDPOINT_FILE;
  });

  it("defaults to the live endpoint descriptor", () => {
    delete process.env.OPENREEL_LIVE_ENDPOINT_FILE;
    expect(endpointFilePath()).toBe(path.join(os.homedir(), ".openreel", "live-endpoint.json"));
  });

  it("supports an isolated descriptor override", () => {
    const descriptor = path.join(os.tmpdir(), "openreel-live-endpoint.json");
    process.env.OPENREEL_LIVE_ENDPOINT_FILE = descriptor;
    expect(endpointFilePath()).toBe(descriptor);
  });
});

describe("live endpoint URL boundary", () => {
  it("accepts only local plain-HTTP endpoints", () => {
    expect(validateLiveEndpointUrl("http://127.0.0.1:3210/mcp").hostname).toBe(
      "127.0.0.1",
    );
    expect(validateLiveEndpointUrl("http://localhost:3210/mcp").hostname).toBe(
      "localhost",
    );
  });

  it.each([
    "https://127.0.0.1:3210/mcp",
    "http://example.com:3210/mcp",
    "http://user:secret@127.0.0.1:3210/mcp",
    "not a URL",
  ])("rejects an unsafe descriptor URL: %s", (url) => {
    expect(() => validateLiveEndpointUrl(url)).toThrow();
  });
});

describe("forwardLine", () => {
  it("forwards live MCP requests", async () => {
    const post = vi.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    const result = await forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', post);
    expect(post).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(result!)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });

  it("rejects legacy or unsupported methods without forwarding", async () => {
    const post = vi.fn();
    const result = await forwardLine(
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"execute_action"}}',
      post,
    );
    expect(JSON.parse(result!)).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(post).not.toHaveBeenCalled();
  });

  it("turns upstream failures into concise JSON-RPC errors", async () => {
    const post = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await forwardLine('{"jsonrpc":"2.0","id":2,"method":"ping"}', post);
    expect(JSON.parse(result!)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "connection refused" },
    });
  });

  it("does not emit a response for notifications", async () => {
    const post = vi.fn().mockResolvedValue(null);
    expect(await forwardLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', post)).toBeNull();
  });
});
