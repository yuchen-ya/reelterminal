import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startCodexConversationAdapter } from "./codex-adapter.mjs";

class FakeCodexClient {
  constructor() {
    this.notifications = new Set();
    this.serverRequests = new Set();
    this.turnWaiters = new Map();
    this.nextTurn = 0;
    this.activeTurn = null;
    this.lastTurn = null;
    this.responses = [];
    this.closed = false;
  }

  async start() {
    return { userAgent: "codex-cli/test" };
  }

  async startThread() {
    return { thread: { id: "codex-thread-test" } };
  }

  async resumeThread(threadId) {
    return { thread: { id: threadId } };
  }

  onNotification(listener) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener) {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.notifications) listener({ method, params });
  }

  async startTurn(threadId, text, options) {
    const id = `turn-${++this.nextTurn}`;
    this.activeTurn = { id, threadId, text, options };
    this.lastTurn = this.activeTurn;
    if (text.includes("wait for cancel")) return { id, status: "inProgress" };
    setTimeout(() => {
      this.emit("turn/started", {
        threadId,
        turn: { id, status: "inProgress" },
      });
      this.emit("item/started", {
        threadId,
        turnId: id,
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "openreel_live",
          tool: "edit_apply",
          status: "inProgress",
          arguments: { secret: "raw-argument-must-not-cross" },
        },
      });
      this.emit("item/completed", {
        threadId,
        turnId: id,
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "openreel_live",
          tool: "edit_apply",
          status: "completed",
          result: { secret: "raw-result-must-not-cross" },
        },
      });
      this.emit("item/agentMessage/delta", {
        threadId,
        turnId: id,
        itemId: "agent-1",
        delta: "Edit ",
      });
      this.emit("item/agentMessage/delta", {
        threadId,
        turnId: id,
        itemId: "agent-1",
        delta: "complete.",
      });
      this.emit("item/completed", {
        threadId,
        turnId: id,
        item: { type: "reasoning", id: "reason-1", summary: ["Checked the cut."], content: ["raw chain of thought"] },
      });
      this.emit("item/completed", {
        threadId,
        turnId: id,
        item: { type: "agentMessage", id: "agent-1", text: "Edit complete." },
      });
      this.completeTurn({ id, status: "completed" });
    }, 0);
    return { id, status: "inProgress" };
  }

  waitForTurn(turnId) {
    return new Promise((resolve) => this.turnWaiters.set(turnId, resolve));
  }

  completeTurn(turn) {
    this.emit("turn/completed", {
      threadId: "codex-thread-test",
      turn,
    });
    this.turnWaiters.get(turn.id)?.(turn);
    this.turnWaiters.delete(turn.id);
    this.activeTurn = null;
  }

  async interruptTurn(threadId, turnId) {
    assert.equal(threadId, "codex-thread-test");
    assert.equal(turnId, this.activeTurn?.id);
    setTimeout(() => this.completeTurn({ id: turnId, status: "interrupted" }), 0);
    return {};
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.responses.push({ id, error: { code, message } });
  }

  requestApproval(method, toolOptions) {
    for (const listener of this.serverRequests) {
      listener({
        id: 900,
        method,
        params: method === "item/tool/requestUserInput" ? {
          threadId: "codex-thread-test",
          turnId: "turn-approval",
          itemId: "item-approval",
          isBlocking: true,
          questions: [{
            id: "approve-tool",
            header: "Tool approval",
            question: "Allow this tool?",
            isOther: false,
            isSecret: false,
            options: toolOptions ?? [
              { label: "Allow once", description: "Run this tool once." },
              { label: "Deny", description: "Do not run it." },
            ],
          }],
        } : {
          threadId: "codex-thread-test",
          turnId: "turn-approval",
          itemId: "item-approval",
          command: "cat /private/secret",
          cwd: "/private/secret",
        },
      });
    }
  }

  async close() {
    this.closed = true;
  }
}

async function rpc(descriptor, method, params, id = 1) {
  const response = await fetch(descriptor.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response.json();
}

async function notify(descriptor, method, params) {
  return fetch(descriptor.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reelterminal-codex-adapter-"));
  const descriptorPath = path.join(directory, "conversation-endpoint.json");
  const visualStateRoot = path.join(directory, "visual-state");
  const visualImagePath = path.join(visualStateRoot, "state.png");
  const visualImageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await mkdir(visualStateRoot, { recursive: true });
  await writeFile(visualImagePath, visualImageBytes);
  const client = new FakeCodexClient();
  const adapter = await startCodexConversationAdapter({
    client,
    createThread: true,
    configureLiveMcp: false,
    descriptorPath,
    visualStateRoot,
  });
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  return {
    adapter,
    client,
    descriptor,
    visualImagePath,
    visualImageSha256: createHash("sha256").update(visualImageBytes).digest("hex"),
  };
}

async function connect(descriptor) {
  const initialized = await rpc(descriptor, "initialize", {
    protocolVersion: "openreel-conversation/1",
  });
  assert.equal(initialized.result.agentInfo.name, "Codex");
  assert.equal(initialized.result.sessionCapabilities.conversation.approval, true);
  const resumed = await rpc(descriptor, "session/resume", {
    sessionId: descriptor.sessionId,
  });
  assert.equal(resumed.result.sessionId, descriptor.sessionId);
}

test("projects a real Codex turn with trusted visual state into safe streaming updates", async () => {
  const { adapter, client, descriptor, visualImagePath, visualImageSha256 } = await fixture();
  try {
    await connect(descriptor);
    const prompted = await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "Tighten the selected clip." }],
      clientContext: {
        workMode: "collaborative",
        semantics: {
          id: "collaborative",
          label: "Collaborative",
          summary: "Work as a peer.",
          deliveryRequiresExplicitAuthorization: true,
        },
      },
      visualState: {
        version: 1,
        stateRef: "vs-test-1",
        kind: "keyframe",
        projectRevision: 7,
        contextRevision: 3,
        playheadSeconds: 1.25,
        selectedClipIds: ["clip-1"],
        selectedTextIds: [],
        selectedMediaIds: [],
        changed: ["preview", "timeline", "selection"],
        image: {
          type: "localImage",
          path: visualImagePath,
          width: 1,
          height: 1,
          sha256: visualImageSha256,
        },
      },
    });
    assert.equal(prompted.result.messageId, "agent-1");
    assert.match(client.lastTurn?.text ?? "", /openreel_live MCP/);
    assert.match(client.lastTurn?.text ?? "", /User request from ReelTerminal/);
    assert.match(client.lastTurn?.text ?? "", /"projectRevision":7/);
    assert.match(client.lastTurn?.text ?? "", /do not call capabilities_get/i);
    assert.deepEqual(client.lastTurn?.options?.localImagePaths, [await realpath(visualImagePath)]);

    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    const serialized = JSON.stringify(updates.result.notifications);
    assert.match(serialized, /user_message/);
    assert.match(serialized, /tool_call/);
    assert.match(serialized, /agent_message_chunk/);
    assert.match(serialized, /Edit /);
    assert.match(serialized, /Edit complete\./);
    assert.match(serialized, /Checked the cut\./);
    assert.match(serialized, /"state":"idle"/);
    assert.doesNotMatch(serialized, /raw-argument-must-not-cross/);
    assert.doesNotMatch(serialized, /raw-result-must-not-cross/);
    assert.doesNotMatch(serialized, /raw chain of thought/);
  } finally {
    await adapter.close();
  }
  assert.equal(client.closed, true);
});

test("drops a local image outside the trusted visual-state root", async () => {
  const { adapter, client, descriptor, visualImageSha256 } = await fixture();
  try {
    await connect(descriptor);
    const outsidePath = path.join(tmpdir(), "outside-reelterminal-state.png");
    await writeFile(
      outsidePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const prompted = await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "Inspect safely." }],
      visualState: {
        version: 1,
        stateRef: "vs-test-outside",
        kind: "keyframe",
        projectRevision: 1,
        contextRevision: 1,
        playheadSeconds: 0,
        selectedClipIds: [],
        selectedTextIds: [],
        selectedMediaIds: [],
        changed: ["preview"],
        image: {
          type: "localImage",
          path: outsidePath,
          width: 1,
          height: 1,
          sha256: visualImageSha256,
        },
      },
    });
    assert.ok(prompted.result);
    assert.deepEqual(client.lastTurn?.options ?? {}, {});
    assert.match(client.lastTurn?.text ?? "", /"imageAttached":false/);
    assert.doesNotMatch(client.lastTurn?.text ?? "", /outside-reelterminal-state/);
  } finally {
    await adapter.close();
  }
});

test("forwards a trusted delta atlas with explicit board mappings", async () => {
  const { adapter, client, descriptor, visualImagePath, visualImageSha256 } = await fixture();
  try {
    await connect(descriptor);
    const prompted = await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "Continue from the visual delta." }],
      visualState: {
        version: 1,
        stateRef: "vs-test-2",
        baseRef: "vs-test-1",
        kind: "delta",
        projectRevision: 8,
        contextRevision: 4,
        playheadSeconds: 1.25,
        selectedClipIds: ["clip-1"],
        selectedTextIds: [],
        selectedMediaIds: [],
        changed: ["preview"],
        image: {
          type: "localImage",
          path: visualImagePath,
          width: 1,
          height: 1,
          sha256: visualImageSha256,
          regions: [
            { x: 32, y: 64, width: 1, height: 1, imageX: 0, imageY: 0 },
          ],
        },
      },
    });
    assert.ok(prompted.result);
    assert.match(client.lastTurn?.text ?? "", /"deltaRegions":\[/);
    assert.match(client.lastTurn?.text ?? "", /"imageX":0/);
    assert.deepEqual(client.lastTurn?.options?.localImagePaths, [
      await realpath(visualImagePath),
    ]);
  } finally {
    await adapter.close();
  }
});

test("keeps cancel out-of-band and settles the pending prompt", async () => {
  const { adapter, descriptor } = await fixture();
  try {
    await connect(descriptor);
    const promptPromise = rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait for cancel" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await notify(descriptor, "session/cancel", {
      sessionId: descriptor.sessionId,
    });
    assert.equal(cancelled.status, 204);
    await promptPromise;
    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    assert.match(JSON.stringify(updates.result.notifications), /"state":"cancelled"/);
  } finally {
    await adapter.close();
  }
});

test("round-trips Codex approvals without exposing commands or paths", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    client.requestApproval("item/commandExecution/requestApproval");
    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    const serialized = JSON.stringify(updates.result.notifications);
    assert.match(serialized, /codex-approval-1/);
    assert.doesNotMatch(serialized, /cat \/private\/secret/);
    assert.doesNotMatch(serialized, /\/private\/secret/);

    const approved = await rpc(descriptor, "session/approval", {
      sessionId: descriptor.sessionId,
      requestId: "codex-approval-1",
      decision: "approved",
    });
    assert.deepEqual(approved.result, {});
    assert.deepEqual(client.responses, [{ id: 900, result: { decision: "accept" } }]);
  } finally {
    await adapter.close();
  }
});

test("maps a Codex tool confirmation onto the binary ReelTerminal approval UI", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    client.requestApproval("item/tool/requestUserInput");
    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    const serialized = JSON.stringify(updates.result.notifications);
    assert.match(serialized, /Allow Codex to use the ReelTerminal tool/);
    assert.doesNotMatch(serialized, /Allow this tool/);

    await rpc(descriptor, "session/approval", {
      sessionId: descriptor.sessionId,
      requestId: "codex-approval-1",
      decision: "approved",
    });
    assert.deepEqual(client.responses, [{
      id: 900,
      result: {
        answers: { "approve-tool": { answers: ["Allow once"] } },
      },
    }]);
  } finally {
    await adapter.close();
  }
});

test("rejects ambiguous or multi-option Codex questions instead of inventing approval semantics", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    client.requestApproval("item/tool/requestUserInput", [
      { label: "Red", description: "Choose red." },
      { label: "Green", description: "Choose green." },
      { label: "Blue", description: "Choose blue." },
    ]);
    assert.equal(client.responses[0]?.error?.code, -32602);

    client.responses = [];
    client.requestApproval("item/tool/requestUserInput", [
      { label: "First", description: "Choose the first option." },
      { label: "Second", description: "Choose the second option." },
    ]);
    assert.equal(client.responses[0]?.error?.code, -32602);

    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    assert.doesNotMatch(JSON.stringify(updates.result.notifications), /approval_request/);
  } finally {
    await adapter.close();
  }
});
