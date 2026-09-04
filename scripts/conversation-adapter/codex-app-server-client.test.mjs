import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAppServerClient } from "./codex-app-server-client.mjs";

class FakeAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.messages = [];
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (line) => {
      const message = JSON.parse(line);
      this.messages.push(message);
      this.handle(message);
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  handle(message) {
    if (message.method === "initialize") {
      this.send({ id: message.id, result: { userAgent: "codex-cli/test" } });
    } else if (message.method === "thread/start") {
      this.send({ id: message.id, result: { thread: { id: "thread-1" } } });
    } else if (message.method === "turn/start") {
      this.send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      this.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
    } else if (message.method === "turn/interrupt") {
      this.send({ id: message.id, result: {} });
    }
  }

  kill(signal) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("handshakes, frames turns, and retains early completion notifications", async () => {
  const child = new FakeAppServerProcess();
  const requests = [];
  const client = new CodexAppServerClient({ spawnImpl: () => child });
  try {
    const initialized = await client.start();
    assert.equal(initialized.userAgent, "codex-cli/test");
    assert.equal(child.stderr.readableFlowing, true);

    const unsubscribe = client.onServerRequest((message) => requests.push(message));
    child.send({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0]?.id, 77);
    client.respond(77, { decision: "decline" });
    unsubscribe();

    const thread = await client.startThread({ approvalsReviewer: "user" });
    assert.equal(thread.thread.id, "thread-1");
    const turn = await client.startTurn("thread-1", "Inspect the live project.", {
      localImagePaths: ["/tmp/reelterminal-state.png"],
    });
    assert.equal(turn.id, "turn-1");
    assert.deepEqual(await client.waitForTurn(turn.id), {
      id: "turn-1",
      status: "completed",
    });

    assert.equal(child.messages[0].method, "initialize");
    assert.equal(child.messages[0].params.capabilities.experimentalApi, true);
    assert.equal(child.messages[1].method, "initialized");
    assert.ok(child.messages.some((message) => message.result?.decision === "decline"));
    assert.ok(child.messages.some((message) => message.method === "thread/start"));
    const turnRequest = child.messages.find((message) => message.method === "turn/start");
    assert.deepEqual(turnRequest.params.input, [
      { type: "text", text: "Inspect the live project.", text_elements: [] },
      { type: "localImage", path: "/tmp/reelterminal-state.png" },
    ]);
  } finally {
    await client.close();
  }
  assert.equal(child.signalCode, "SIGTERM");
});
