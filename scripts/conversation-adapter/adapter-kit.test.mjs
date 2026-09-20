import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONVERSATION_ENDPOINT_PATH,
  MAX_REQUEST_BYTES,
  startConversationAdapter,
} from "./adapter-kit.mjs";

async function temporaryDescriptorPath() {
  const directory = await mkdtemp(join(tmpdir(), "openreel-adapter-kit-"));
  return join(directory, "nested", "conversation-endpoint.json");
}

async function descriptorAt(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function request(endpoint, token, payload, init = {}) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...init,
  });
}

test("writes a private descriptor atomically with the loopback endpoint", async () => {
  const descriptorPath = await temporaryDescriptorPath();
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-perms",
    agent: { name: "Test Agent", version: "1.0" },
    adapter: { name: "kit", capabilityLevel: "streaming" },
    descriptorPath,
  });
  try {
    const descriptor = await descriptorAt(descriptorPath);
    assert.deepEqual(Object.keys(descriptor).sort(), [
      "adapter",
      "agent",
      "endpoint",
      "product",
      "sessionId",
      "token",
      "transport",
      "version",
    ]);
    // N03: the product field marks the descriptor as owned by this
    // application family for legacy-path discovery.
    assert.equal(descriptor.product, "reelterminal");
    const endpoint = new URL(descriptor.endpoint);
    assert.equal(endpoint.protocol, "http:");
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.ok(Number(endpoint.port) > 0);
    assert.equal(endpoint.pathname, CONVERSATION_ENDPOINT_PATH);
    assert.match(descriptor.token, /^[a-f0-9]{64}$/);
    if (process.platform !== "win32") {
      assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
    }
  } finally {
    await adapter.close();
  }
  await assert.rejects(readFile(descriptorPath));
});

test("routes safe JSON-RPC requests and returns 204 for cancel notifications", async () => {
  const descriptorPath = await temporaryDescriptorPath();
  const calls = [];
  let routeToken = "";
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-route",
    agent: { name: "Route Agent" },
    adapter: { name: "kit", capabilityLevel: "observable" },
    descriptorPath,
    onInitialize: (params) => {
      calls.push(["initialize", params.clientInfo?.name]);
      return {
        protocolVersion: "openreel-conversation/1",
        agentInfo: { name: "Route Agent" },
        sessionCapabilities: {
          resume: true,
          prompt: true,
          cancel: true,
          conversation: { formalReply: true, approval: true },
        },
      };
    },
    onResume: (params) => {
      calls.push(["resume", params.sessionId]);
      return { sessionId: params.sessionId };
    },
    onPrompt: (params) => {
      calls.push(["prompt", params.prompt[0].text]);
      return { messageId: "agent-message-1", token: routeToken };
    },
    onCancel: (params) => {
      calls.push(["cancel", params.sessionId]);
    },
    onApproval: (params) => {
      calls.push(["approval", params.decision]);
      return { accepted: true };
    },
    onWorkMode: (params) => {
      calls.push(["work-mode", params.clientContext.workMode]);
    },
    onUpdates: (params) => {
      calls.push(["updates", params.after ?? null]);
      return {
        cursor: "cursor-1",
        notifications: [
          {
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message", content: [] },
            },
          },
        ],
      };
    },
  });
  try {
    const descriptor = await descriptorAt(descriptorPath);
    routeToken = descriptor.token;
    const initialize = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "openreel-conversation/1",
        clientInfo: { name: "ReelTerminal", version: "0.1.0" },
      },
    });
    assert.equal(initialize.status, 200);
    assert.deepEqual(await initialize.json(), {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "openreel-conversation/1",
        agentInfo: { name: "Route Agent" },
        sessionCapabilities: {
          resume: true,
          prompt: true,
          cancel: true,
          conversation: { formalReply: true, approval: true },
        },
      },
    });

    const prompt = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      id: "prompt-1",
      method: "session/prompt",
      params: {
        sessionId: descriptor.sessionId,
        prompt: [{ type: "text", text: "Review the selected cut." }],
      },
    });
    assert.deepEqual(await prompt.json(), {
      jsonrpc: "2.0",
      id: "prompt-1",
      result: { messageId: "agent-message-1", token: "[redacted]" },
    });

    const cancel = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: descriptor.sessionId },
    });
    assert.equal(cancel.status, 204);
    assert.equal(await cancel.text(), "");

    const workMode = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      method: "openreel/work_mode",
      params: {
        sessionId: descriptor.sessionId,
        clientContext: {
          workMode: "guided",
          semantics: {
            id: "guided",
            label: "Guided",
            summary: "Explain consequential choices and invite review.",
            deliveryRequiresExplicitAuthorization: true,
          },
        },
      },
    });
    assert.equal(workMode.status, 204);
    assert.equal(await workMode.text(), "");

    const approval = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/approval",
      params: {
        sessionId: descriptor.sessionId,
        requestId: "approval-1",
        decision: "approved",
      },
    });
    assert.deepEqual(await approval.json(), {
      jsonrpc: "2.0",
      id: 2,
      result: { accepted: true },
    });

    const updates = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "openreel/session/updates",
      params: { sessionId: descriptor.sessionId, after: "cursor-0", waitMs: 1_000 },
    });
    assert.deepEqual(await updates.json(), {
      jsonrpc: "2.0",
      id: 3,
      result: {
        cursor: "cursor-1",
        notifications: [
          {
            method: "session/update",
            params: {
              sessionId: descriptor.sessionId,
              update: { sessionUpdate: "agent_message", content: [] },
            },
          },
        ],
      },
    });
    assert.deepEqual(calls, [
      ["initialize", "ReelTerminal"],
      ["prompt", "Review the selected cut."],
      ["cancel", descriptor.sessionId],
      ["work-mode", "guided"],
      ["approval", "approved"],
      ["updates", "cursor-0"],
    ]);
  } finally {
    await adapter.close();
  }
});

test("redacts hook errors, rejects unauthorized callers, and enforces the body limit", async () => {
  const descriptorPath = await temporaryDescriptorPath();
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-errors",
    agent: { name: "Error Agent" },
    adapter: { name: "kit", capabilityLevel: "basic" },
    descriptorPath,
    onPrompt: async () => {
      throw new Error("bearer-token-secret and raw prompt must not escape");
    },
  });
  try {
    const descriptor = await descriptorAt(descriptorPath);
    const unauthorized = await request(descriptor.endpoint, "wrong-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(await unauthorized.text(), '{"error":"Unauthorized"}');

    const failed = await request(descriptor.endpoint, descriptor.token, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: descriptor.sessionId,
        prompt: [{ type: "text", text: "raw prompt" }],
      },
    });
    const failedBody = await failed.text();
    assert.equal(failed.status, 200);
    assert.match(failedBody, /External Agent request failed/);
    assert.doesNotMatch(failedBody, /bearer-token-secret|raw prompt/);

    const oversizedSecret = "secret-body-token-" + "x".repeat(MAX_REQUEST_BYTES);
    const oversized = await request(
      descriptor.endpoint,
      descriptor.token,
      oversizedSecret,
    );
    assert.equal(oversized.status, 413);
    const oversizedBody = await oversized.text();
    assert.doesNotMatch(oversizedBody, /secret-body-token/);
  } finally {
    await adapter.close();
  }
});

test("close only removes the descriptor still owned by that adapter", async () => {
  const descriptorPath = await temporaryDescriptorPath();
  const first = await startConversationAdapter({
    sessionId: "agent-session-first",
    agent: { name: "First Agent" },
    adapter: { name: "kit", capabilityLevel: "basic" },
    descriptorPath,
  });
  const firstDescriptor = await descriptorAt(descriptorPath);
  const second = await startConversationAdapter({
    sessionId: "agent-session-second",
    agent: { name: "Second Agent" },
    adapter: { name: "kit", capabilityLevel: "streaming" },
    descriptorPath,
  });
  try {
    const secondDescriptor = await descriptorAt(descriptorPath);
    assert.notEqual(firstDescriptor.token, secondDescriptor.token);
    await first.close();
    assert.deepEqual(await descriptorAt(descriptorPath), secondDescriptor);
  } finally {
    await second.close();
  }
  await assert.rejects(readFile(descriptorPath));
});

test("N03: mirror descriptors are published and removed with the adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openreel-adapter-mirror-"));
  const descriptorPath = join(directory, ".reelterminal", "conversation-endpoint.json");
  const legacyMirror = join(directory, ".openreel", "conversation-endpoint.json");
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-mirror",
    agent: { name: "Mirror Agent" },
    adapter: { name: "kit", capabilityLevel: "basic" },
    descriptorPath,
    mirrorDescriptorPaths: [legacyMirror],
  });
  try {
    const primary = await descriptorAt(descriptorPath);
    const mirror = await descriptorAt(legacyMirror);
    // Same descriptor payload at both paths; the mirror makes a live
    // adapter discoverable for read-only-legacy clients.
    assert.equal(mirror.endpoint, primary.endpoint);
    assert.equal(mirror.product, "reelterminal");
    if (process.platform !== "win32") {
      assert.equal((await stat(legacyMirror)).mode & 0o777, 0o600);
    }
  } finally {
    await adapter.close();
  }
  // Both owned copies are removed; the mirror failure of the primary must
  // not leave either behind.
  await assert.rejects(readFile(descriptorPath));
  await assert.rejects(readFile(legacyMirror));
});

test("N03: an unwritable mirror degrades to primary-only publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openreel-adapter-mirror-fail-"));
  // The mirror's parent is a regular file: mkdir fails on every platform.
  const blockedParent = join(directory, "blocked");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(blockedParent, "not a directory\n");
  const descriptorPath = join(directory, "nested", "conversation-endpoint.json");
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-mirror-fail",
    agent: { name: "Mirror Fail Agent" },
    adapter: { name: "kit", capabilityLevel: "basic" },
    descriptorPath,
    mirrorDescriptorPaths: [join(blockedParent, "conversation-endpoint.json")],
  });
  try {
    // The primary descriptor is live regardless of the mirror failure.
    const primary = await descriptorAt(descriptorPath);
    assert.equal(primary.sessionId, "agent-session-mirror-fail");
  } finally {
    await adapter.close();
  }
  await assert.rejects(readFile(descriptorPath));
});

test("N03: a mirror identical to the primary path is skipped, not double-written", async () => {
  const descriptorPath = await temporaryDescriptorPath();
  const adapter = await startConversationAdapter({
    sessionId: "agent-session-same",
    agent: { name: "Same Path Agent" },
    adapter: { name: "kit", capabilityLevel: "basic" },
    descriptorPath,
    mirrorDescriptorPaths: [descriptorPath],
  });
  try {
    const descriptor = await descriptorAt(descriptorPath);
    assert.equal(descriptor.sessionId, "agent-session-same");
  } finally {
    await adapter.close();
  }
  await assert.rejects(readFile(descriptorPath));
});
