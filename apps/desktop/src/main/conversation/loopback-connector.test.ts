import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalConversationBridge } from "@reelterminal/agent-facade";
import {
  createLoopbackConversationConnector,
  readConversationEndpointDescriptor,
} from "./loopback-connector";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function descriptorPath(value: Record<string, unknown>, mode = 0o600): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openreel-conversation-"));
  tempDirs.push(dir);
  const file = path.join(dir, "conversation-endpoint.json");
  writeFileSync(file, JSON.stringify(value), { mode });
  chmodSync(file, mode);
  return file;
}

function validDescriptor(endpoint = "http://127.0.0.1:42123/conversation") {
  return {
    version: 1,
    transport: "http-jsonrpc-long-poll",
    endpoint,
    token: "0123456789abcdef0123456789abcdef",
    sessionId: "session-owned-by-agent",
    agent: { name: "Test Agent", version: "1.0.0" },
    adapter: { name: "test-adapter", capabilityLevel: "observable" },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

describe("conversation endpoint descriptor", () => {
  it("accepts one private loopback descriptor and returns no derived secrets", async () => {
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(validDescriptor()),
    );
    expect(descriptor.sessionId).toBe("session-owned-by-agent");
    expect(descriptor.endpoint).toBe("http://127.0.0.1:42123/conversation");
  });

  it("rejects non-loopback and credential-bearing endpoints", async () => {
    await expect(
      readConversationEndpointDescriptor(
        descriptorPath(validDescriptor("https://agent.example/conversation")),
      ),
    ).rejects.toThrow("loopback HTTP");
    await expect(
      readConversationEndpointDescriptor(
        descriptorPath(
          validDescriptor("http://user:pass@127.0.0.1:42123/conversation"),
        ),
      ),
    ).rejects.toThrow("forbidden credentials");
    await expect(
      readConversationEndpointDescriptor(
        descriptorPath(
          validDescriptor("http://127.0.0.1:42123/other?target=conversation"),
        ),
      ),
    ).rejects.toThrow("/conversation path");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a descriptor readable by another user",
    async () => {
      await expect(
        readConversationEndpointDescriptor(descriptorPath(validDescriptor(), 0o644)),
      ).rejects.toThrow("0600");
    },
  );
});

describe("loopback conversation transport", () => {
  it("attaches an existing session, sends a prompt, and projects polled updates", async () => {
    const notifications: Record<string, unknown>[] = [];
    let cursor = 0;
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe(
        "Bearer 0123456789abcdef0123456789abcdef",
      );
      const rpc = await readJson(req);
      const method = rpc.method;
      if (method === "initialize") {
        json(res, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "0.1",
            agentInfo: { name: "Test Agent", version: "1.0.0" },
            sessionCapabilities: {
              resume: true,
              prompt: true,
              cancel: true,
              conversation: {
                formalReply: true,
                streaming: true,
                toolEvents: true,
              },
            },
          },
        });
        return;
      }
      if (method === "session/resume") {
        json(res, { jsonrpc: "2.0", id: rpc.id, result: {} });
        return;
      }
      if (method === "session/prompt") {
        cursor += 1;
        notifications.push({
          method: "session/update",
          params: {
            sessionId: "session-owned-by-agent",
            sequence: cursor,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "reply-1",
              content: { type: "text", text: "Finished in the external session." },
            },
          },
        });
        json(res, { jsonrpc: "2.0", id: rpc.id, result: { messageId: "user-1" } });
        return;
      }
      if (method === "openreel/session/updates") {
        const batch = notifications.splice(0);
        if (batch.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        json(res, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { cursor, notifications: batch },
        });
        return;
      }
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(
        validDescriptor(`http://127.0.0.1:${address.port}/conversation`),
      ),
    );
    const bridge = new ExternalConversationBridge({
      connector: createLoopbackConversationConnector(descriptor),
    });
    try {
      await bridge.connect({ sessionId: descriptor.sessionId });
      expect(bridge.getDisplayState().lifecycle).toBe("ready");
      await bridge.prompt("Finish #2 and #3, then align #1.");
      await new Promise((resolve) => setTimeout(resolve, 80));
      const updates = bridge
        .getDisplayState()
        .updates.filter((event) => event.type === "session_update");
      expect(updates).toHaveLength(1);
      expect(updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
    } finally {
      await bridge.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not reflect an upstream error body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("SECRET_REMOTE_BODY");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(
        validDescriptor(`http://127.0.0.1:${address.port}/conversation`),
      ),
    );
    const transport = await createLoopbackConversationConnector(descriptor).connect({
      sessionId: descriptor.sessionId,
    });
    try {
      await expect(transport.request("initialize", {})).rejects.not.toThrow(
        "SECRET_REMOTE_BODY",
      );
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a long turn alive past the ordinary request timeout and aborts it on close", async () => {
    let markPromptReceived!: () => void;
    const promptReceived = new Promise<void>((resolve) => {
      markPromptReceived = resolve;
    });
    const server = createServer(async (req) => {
      const rpc = await readJson(req);
      if (rpc.method === "session/prompt") markPromptReceived();
      // Deliberately leave the response open; transport.close must abort it.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(
        validDescriptor(`http://127.0.0.1:${address.port}/conversation`),
      ),
    );
    const transport = await createLoopbackConversationConnector(descriptor).connect({
      sessionId: descriptor.sessionId,
    });
    vi.useFakeTimers();
    const prompt = transport.request("session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await promptReceived;
    let settled = false;
    void prompt.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    await transport.close();
    await expect(prompt).rejects.toBeDefined();
    vi.useRealTimers();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("aborts a pending prompt when polling reaches a terminal failure", async () => {
    let markPromptReceived!: () => void;
    const promptReceived = new Promise<void>((resolve) => {
      markPromptReceived = resolve;
    });
    const server = createServer(async (req, res) => {
      const rpc = await readJson(req);
      if (rpc.method === "initialize") {
        json(res, { jsonrpc: "2.0", id: rpc.id, result: {} });
        return;
      }
      if (rpc.method === "openreel/session/updates") {
        res.writeHead(500);
        res.end();
        return;
      }
      if (rpc.method === "session/prompt") {
        markPromptReceived();
        // Deliberately leave the response open. Fatal polling must abort it.
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(
        validDescriptor(`http://127.0.0.1:${address.port}/conversation`),
      ),
    );
    const transport = await createLoopbackConversationConnector(descriptor).connect({
      sessionId: descriptor.sessionId,
    });
    transport.onNotification(() => undefined);
    const closed = new Promise<void>((resolve) => {
      transport.onClose(() => resolve());
    });
    await transport.request("initialize", {});
    const prompt = transport.request("session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await promptReceived;
    await closed;
    await expect(prompt).rejects.toBeDefined();
    await transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("validates JSON-RPC ids and removes untrusted error details", async () => {
    let wrongId = true;
    const server = createServer(async (req, res) => {
      const rpc = await readJson(req);
      if (wrongId) {
        json(res, { jsonrpc: "2.0", id: "wrong-id", result: {} });
        return;
      }
      json(res, {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: "ADAPTER_FAILURE",
          message: "SECRET_REMOTE_ERROR",
          data: { token: "SECRET_REMOTE_TOKEN" },
        },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const descriptor = await readConversationEndpointDescriptor(
      descriptorPath(
        validDescriptor(`http://127.0.0.1:${address.port}/conversation`),
      ),
    );
    const transport = await createLoopbackConversationConnector(descriptor).connect({
      sessionId: descriptor.sessionId,
    });
    try {
      await expect(transport.request("initialize", {})).rejects.toThrow(
        "invalid JSON-RPC",
      );
      wrongId = false;
      const response = await transport.request("initialize", {});
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: "ADAPTER_FAILURE",
          message: "External Agent request failed",
        },
      });
      expect(JSON.stringify(response)).not.toContain("SECRET_REMOTE");
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
