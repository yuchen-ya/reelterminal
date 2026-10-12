import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LiveCliError, LiveCommandClient, defaultRequestTimeoutMs, type LiveEndpoint } from "./client";

const target = { projectId: "project-1", workspaceId: "workspace-1" };
const servers: Server[] = [];
async function endpointFor(handler: RequestListener): Promise<LiveEndpoint> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token: "test-token-never-printed",
    commandApi: { url: `http://127.0.0.1:${address.port}/v1`, version: 1 },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized) });
  res.end(serialized);
}

describe("live Command API client", () => {
  it("discovers one command schema from the dotted catalog route", async () => {
    const command = {
      name: "edit.apply", toolName: "edit_apply", description: "Apply an edit.",
      inputSchema: { type: "object", properties: {} }, effects: ["write"], retry: "never",
    };
    let requestPath = "";
    const endpoint = await endpointFor((req, res) => {
      requestPath = req.url ?? "";
      sendJson(res, 200, { ok: true, apiVersion: 1, contractVersion: "1", serverInfo: { name: "ReelTerminal", version: "1" }, command });
    });
    await expect(new LiveCommandClient(endpoint).catalogEntry("edit.apply")).resolves.toEqual(command);
    expect(requestPath).toBe("/v1/catalog/edit.apply");
  });

  it("sends auth only to the loopback API and guards each command with project identity", async () => {
    const requests: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
    const endpoint = await endpointFor((req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      if (req.url === "/v1/status") {
        sendJson(res, 200, { ok: true, apiVersion: 1, instanceId: "instance-1", projectId: "project-1", projectEpoch: "epoch-1", access: "write" });
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => body += chunk);
      req.on("end", () => {
        requests[requests.length - 1]!.body = body;
        sendJson(res, 200, { ok: true, value: { revision: 5 } });
      });
    });
    const result = await new LiveCommandClient(endpoint).command("edit.apply", { ...target, expectedRevision: 4 }, {
      retry: "idempotent", addIdempotencyKey: true,
    });
    expect(result).toEqual({ ok: true, value: { revision: 5 } });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "/v1/status"], ["POST", "/v1/command"],
    ]);
    expect(requests.every((request) => request.auth === "Bearer test-token-never-printed")).toBe(true);
    const body = JSON.parse(requests[1]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      command: "edit.apply",
      expectedProjectEpoch: "epoch-1",
      arguments: { ...target, expectedRevision: 4, idempotencyKey: expect.any(String) },
    });
    expect(body).not.toHaveProperty("expectedProjectId");
  });

  it("returns a 409 project guard failure as a business result", async () => {
    const endpoint = await endpointFor((req, res) => {
      if (req.url === "/v1/status") sendJson(res, 200, { ok: true, apiVersion: 1, instanceId: "i", projectId: "p", projectEpoch: "e" });
      else sendJson(res, 409, { ok: false, error: { code: "CONFLICT", message: "project identity changed" } });
    });
    await expect(new LiveCommandClient(endpoint).command("edit.apply", { ...target, expectedRevision: 1 }, { retry: "idempotent" }))
      .resolves.toEqual({ ok: false, error: { code: "CONFLICT", message: "project identity changed" } });
  });

  it("derives the default request ceiling from the environment when valid", () => {
    const previous = process.env.REELTERMINAL_REQUEST_TIMEOUT_MS;
    try {
      expect(defaultRequestTimeoutMs()).toBe(30_000);
      process.env.REELTERMINAL_REQUEST_TIMEOUT_MS = "300000";
      expect(defaultRequestTimeoutMs()).toBe(300_000);
      process.env.REELTERMINAL_REQUEST_TIMEOUT_MS = "not-a-number";
      expect(defaultRequestTimeoutMs()).toBe(30_000);
      process.env.REELTERMINAL_REQUEST_TIMEOUT_MS = "-5";
      expect(defaultRequestTimeoutMs()).toBe(30_000);
    } finally {
      if (previous === undefined) delete process.env.REELTERMINAL_REQUEST_TIMEOUT_MS;
      else process.env.REELTERMINAL_REQUEST_TIMEOUT_MS = previous;
    }
  });

  it("reuses one generated idempotency key for uncertain network retries", async () => {
    const received: string[] = [];
    let posts = 0;
    const endpoint = await endpointFor((req, res) => {
      if (req.url === "/v1/status") {
        sendJson(res, 200, { ok: true, apiVersion: 1, instanceId: "i", projectId: "p", projectEpoch: "e" });
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => body += chunk);
      req.on("end", () => {
        posts += 1;
        received.push(JSON.parse(body).arguments.idempotencyKey as string);
        if (posts === 1) res.socket?.destroy();
        else sendJson(res, 200, { ok: true, value: { revision: 6 } });
      });
    });
    const result = await new LiveCommandClient(endpoint).command("edit.apply", { ...target, expectedRevision: 5 }, {
      retry: "idempotent", addIdempotencyKey: true,
    });
    expect(result).toEqual({ ok: true, value: { revision: 6 } });
    expect(posts).toBe(2);
    expect(received[0]).toBeTruthy();
    expect(received[0]).toBe(received[1]);
  });

  it("does not retry deterministic authorization failures", async () => {
    let posts = 0;
    const endpoint = await endpointFor((req, res) => {
      if (req.url === "/v1/status") sendJson(res, 200, { ok: true, apiVersion: 1, instanceId: "i", projectId: "p", projectEpoch: "e" });
      else {
        posts += 1;
        sendJson(res, 401, { ok: false, error: { message: "private upstream detail" } });
      }
    });
    await expect(new LiveCommandClient(endpoint).command("edit.apply", { ...target, expectedRevision: 1 }, {
      retry: "idempotent", addIdempotencyKey: true,
    })).rejects.toMatchObject({ kind: "connection", retryable: false });
    expect(posts).toBe(1);
  });

  it("does not repeat an idempotent-policy write unless a stable key is present", async () => {
    let posts = 0;
    const endpoint = await endpointFor((req, res) => {
      if (req.url === "/v1/status") {
        sendJson(res, 200, { ok: true, apiVersion: 1, instanceId: "i", projectId: "p", projectEpoch: "e" });
        return;
      }
      posts += 1;
      req.resume();
      req.on("end", () => res.socket?.destroy());
    });
    await expect(new LiveCommandClient(endpoint).command("edit.apply", { ...target, expectedRevision: 1 }, {
      retry: "idempotent", addIdempotencyKey: false,
    })).rejects.toMatchObject({ kind: "connection" });
    expect(posts).toBe(1);
  });

  it("fails closed before sending credentials to non-loopback or non-HTTP descriptors", async () => {
    const bad = new LiveCommandClient({
      url: "http://127.0.0.1/mcp",
      token: "must-not-leak",
      commandApi: { url: "https://example.com/v1", version: 1 },
    });
    await expect(bad.status()).rejects.toBeInstanceOf(LiveCliError);
  });
});
