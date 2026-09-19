import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexMcpOverrides,
  startCodexConversationAdapter,
} from "./codex-adapter.mjs";

test("uses an explicit packaged runtime for the live MCP connector", () => {
  const overrides = codexMcpOverrides(
    "/Applications/ReelTerminal.app/Contents/Resources/app.asar.unpacked/dist/live-mcp/index.js",
    {},
    "/Applications/ReelTerminal.app/Contents/MacOS/ReelTerminal",
    true,
  );
  const serialized = overrides.join("\n");
  assert.match(serialized, /mcp_servers\.openreel_live\.command=.*ReelTerminal/);
  assert.match(serialized, /ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(serialized, /command="node"/);
  assert.ok(!overrides.includes("--stdio"));
});

test("spawns the bare app-server subcommand with an optional prefix, never --stdio", async () => {
  const spawns = [];
  // The child exits immediately (like a CLI rejecting its arguments); the
  // assertions only care about the constructed spawn arguments.
  class ExitingChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = 2;
      this.signalCode = null;
      queueMicrotask(() => this.emit("exit", 2, null));
    }
    kill() {
      return true;
    }
  }
  const child = new ExitingChild();
  await assert.rejects(
    startCodexConversationAdapter({
      threadId: "thr_unreachable",
      configureLiveMcp: false,
      codexCommand: "node",
      codexArgsPrefix: ["codex.js"],
      spawnImpl: (command, args) => {
        spawns.push([command, [...args]]);
        return child;
      },
    }),
  );
  assert.deepEqual(spawns, [["node", ["codex.js", "app-server"]]]);
});

test("closes the App Server client when thread startup fails", async () => {
  let closed = 0;
  const client = {
    async start() { return {}; },
    async resumeThread() { throw new Error("resume failed"); },
    async close() { closed += 1; },
  };
  await assert.rejects(
    startCodexConversationAdapter({
      client,
      threadId: "missing-thread",
      configureLiveMcp: false,
    }),
    /resume failed/,
  );
  assert.equal(closed, 1);
});

class FakeCodexClient {
  constructor() {
    this.notifications = new Set();
    this.serverRequests = new Set();
    this.turnWaiters = new Map();
    this.nextTurn = 0;
    this.activeTurn = null;
    this.lastTurn = null;
    this.responses = [];
    this.compactions = 0;
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

  async compactThread(threadId) {
    assert.equal(threadId, "codex-thread-test");
    this.compactions += 1;
    const id = `compact-${this.compactions}`;
    setTimeout(() => {
      this.emit("turn/started", {
        threadId,
        turn: { id, status: "inProgress" },
      });
      this.emit("item/started", {
        threadId,
        turnId: id,
        item: { type: "contextCompaction", id: `compaction-item-${this.compactions}` },
      });
      this.emit("item/completed", {
        threadId,
        turnId: id,
        item: { type: "contextCompaction", id: `compaction-item-${this.compactions}` },
      });
      this.emit("turn/completed", {
        threadId,
        turn: { id, status: "completed" },
      });
    }, 0);
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

async function fixture({ createThread = true } = {}) {
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
    createThread,
    ...(!createThread ? { threadId: "codex-thread-test" } : {}),
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
    // session/prompt is a delivery acknowledgement. The turn continues over
    // session/update instead of holding the composer request open until the
    // final answer.
    assert.deepEqual(prompted.result, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(client.lastTurn?.text ?? "", /User request from ReelTerminal/);
    const extra = JSON.stringify(client.lastTurn?.options?.additionalContext);
    assert.match(extra, /openreel_live MCP/);
    assert.match(extra, /projectRevision/);
    assert.match(extra, /7/);
    assert.match(extra, /do not call capabilities_get/i);
    assert.match(extra, /tool schemas and returned errors as authoritative/i);
    assert.match(extra, /call capabilities_get before creating job files/i);
    assert.match(extra, /skip unrequested editor-control polish/i);
    assert.match(extra, /A1\/A2 are Agent references/);
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
    assert.deepEqual(client.lastTurn?.options?.localImagePaths ?? [], []);
    const extra = JSON.stringify(client.lastTurn?.options?.additionalContext);
    assert.match(extra, /imageAttached/);
    assert.match(extra, /false/);
    assert.doesNotMatch(extra, /outside-reelterminal-state/);
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
    const extra = JSON.stringify(client.lastTurn?.options?.additionalContext);
    assert.match(extra, /deltaRegions/);
    assert.match(extra, /imageX/);
    assert.deepEqual(client.lastTurn?.options?.localImagePaths, [
      await realpath(visualImagePath),
    ]);
  } finally {
    await adapter.close();
  }
});

test("acknowledges delivery before completion and keeps cancel out-of-band", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    const prompted = await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait for cancel" }],
    });
    assert.deepEqual(prompted.result, {});
    assert.equal(client.activeTurn?.id, "turn-1");
    const working = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    assert.match(JSON.stringify(working.result.notifications), /"state":"working"/);
    const cancelled = await notify(descriptor, "session/cancel", {
      sessionId: descriptor.sessionId,
    });
    assert.equal(cancelled.status, 204);
    await new Promise((resolve) => setTimeout(resolve, 10));
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

test("reports per-turn, cached, and current-context usage without changing model effort", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait for cancel" }],
    });
    client.emit("thread/tokenUsage/updated", {
      threadId: descriptor.sessionId,
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 800,
          outputTokens: 50,
          reasoningOutputTokens: 20,
          totalTokens: 1_050,
        },
        last: {
          inputTokens: 240,
          cachedInputTokens: 200,
          outputTokens: 10,
          reasoningOutputTokens: 4,
          totalTokens: 250,
        },
        modelContextWindow: 500_000,
      },
    });
    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    const usage = updates.result.notifications
      .map((notification) => notification.params?.update)
      .find((update) => update?.sessionUpdate === "usage");
    assert.deepEqual(usage, {
      sessionUpdate: "usage",
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 1_050,
      turnInputTokens: 1_000,
      turnCachedInputTokens: 800,
      turnOutputTokens: 50,
      turnReasoningOutputTokens: 20,
      turnTotalTokens: 1_050,
      currentContextTokens: 240,
      contextWindowTokens: 500_000,
    });
    assert.equal(client.lastTurn?.options?.effort, undefined);
    await notify(descriptor, "session/cancel", { sessionId: descriptor.sessionId });
  } finally {
    await adapter.close();
  }
});

test("infers the first resumed-turn delta from App Server last usage", async () => {
  const { adapter, client, descriptor } = await fixture({ createThread: false });
  try {
    await connect(descriptor);
    await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "wait for cancel" }],
    });
    client.emit("thread/tokenUsage/updated", {
      threadId: descriptor.sessionId,
      tokenUsage: {
        total: { inputTokens: 9_800, cachedInputTokens: 9_000, outputTokens: 200, totalTokens: 10_000 },
        last: { inputTokens: 240, cachedInputTokens: 220, outputTokens: 10, totalTokens: 250 },
      },
    });
    const updates = await rpc(descriptor, "openreel/session/updates", {
      sessionId: descriptor.sessionId,
      after: "0",
      waitMs: 0,
    });
    const usage = updates.result.notifications
      .map((notification) => notification.params?.update)
      .find((update) => update?.sessionUpdate === "usage");
    assert.equal(usage.turnInputTokens, 240);
    assert.equal(usage.turnCachedInputTokens, 220);
    assert.equal(usage.turnOutputTokens, 10);
    assert.equal(usage.turnTotalTokens, 250);
    await notify(descriptor, "session/cancel", { sessionId: descriptor.sessionId });
  } finally {
    await adapter.close();
  }
});

test("routes explicit /compact to Codex and restores the editor capsule on the next turn", async () => {
  const { adapter, client, descriptor } = await fixture();
  try {
    await connect(descriptor);
    const compacted = await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "/compact" }],
      visualState: {
        version: 1,
        stateRef: "state-before-compact",
        kind: "metadata",
        projectRevision: 12,
        contextRevision: 8,
        playheadSeconds: 4,
        selectedClipIds: [],
        selectedTextIds: [],
        selectedMediaIds: [],
        projectId: "project-1",
        projectName: "Dam Letter",
        references: [{
          ref: "A1",
          number: 1,
          kind: "video",
          entityId: "clip-1",
          label: "Close shot",
          timing: { startSeconds: 4, endSeconds: 8 },
          revisionAtMark: 12,
          stale: false,
        }],
        reviewMarkers: [{
          ref: "R1",
          number: 1,
          id: "marker-1",
          target: { kind: "clip", clipId: "clip-2" },
        }],
        changed: ["references"],
      },
    });
    assert.deepEqual(compacted.result, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(client.compactions, 1);

    await rpc(descriptor, "session/prompt", {
      sessionId: descriptor.sessionId,
      prompt: [{ type: "text", text: "continue editing @A1" }],
    });
    const extra = client.lastTurn?.options?.additionalContext;
    assert.equal(extra?.restoredAfterCompaction, true);
    assert.equal(extra?.sessionCapsule?.projectName, "Dam Letter");
    assert.equal(extra?.sessionCapsule?.references?.[0]?.ref, "A1");
    assert.equal(extra?.sessionCapsule?.reviewMarkers?.[0]?.ref, "R1");
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
