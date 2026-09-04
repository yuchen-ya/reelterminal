import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(value, fallback) {
  if (isRecord(value) && typeof value.message === "string" && value.message) {
    return value.message;
  }
  return fallback;
}

export class CodexAppServerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

/**
 * Minimal, version-tolerant JSONL client for the stable Codex app-server
 * surface used by ReelTerminal. Unknown notifications are delivered to
 * listeners and ignored by the provider adapter unless explicitly projected.
 */
export class CodexAppServerClient {
  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.commandArgs = options.commandArgs ?? ["app-server", "--stdio"];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.process = null;
    this.reader = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.notifications = new Set();
    this.serverRequests = new Set();
    this.closeListeners = new Set();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.started = false;
    this.closed = false;
    this.closePromise = null;
    this.initializeResult = null;
  }

  async start() {
    if (this.started) return this.initializeResult;
    if (this.closed) throw new CodexAppServerError("CLOSED", "Codex app-server client is closed");
    this.started = true;
    const child = this.spawnImpl(this.command, this.commandArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.once("error", (error) => this.failClosed(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.failClosed(
        new CodexAppServerError(
          "PROCESS_EXIT",
          `Codex app-server exited unexpectedly (${signal ?? code ?? "unknown"})`,
        ),
      );
    });
    if (!child.stdout || !child.stdin) {
      throw new CodexAppServerError("SPAWN_FAILED", "Codex app-server stdio is unavailable");
    }
    // App Server diagnostics are not part of the protocol and may contain
    // provider details. Drain them so the child cannot block, but never relay
    // them into the ReelTerminal conversation surface.
    child.stderr?.resume();
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));

    this.initializeResult = await this.request("initialize", {
      clientInfo: {
        name: "reelterminal_codex_adapter",
        title: "ReelTerminal Codex Adapter",
        version: "0.1.0",
      },
      // Opt in to the newer server-request surface so command/file approvals
      // and non-secret option questions can be projected into ReelTerminal.
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return this.initializeResult;
  }

  request(method, params, options = {}) {
    if (!this.process?.stdin || this.closed) {
      return Promise.reject(
        new CodexAppServerError("CLOSED", "Codex app-server is not available"),
      );
    }
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerError(
            "REQUEST_TIMEOUT",
            `Codex app-server did not answer ${method} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  onNotification(listener) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onServerRequest(listener) {
    this.serverRequests.add(listener);
    return () => this.serverRequests.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async startThread(params = {}) {
    const result = await this.request("thread/start", params);
    if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== "string") {
      throw new CodexAppServerError("INVALID_RESPONSE", "Codex returned an invalid thread/start response");
    }
    return result;
  }

  async resumeThread(threadId, params = {}) {
    const result = await this.request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...params,
    });
    if (
      !isRecord(result) ||
      !isRecord(result.thread) ||
      result.thread.id !== threadId
    ) {
      throw new CodexAppServerError("INVALID_RESPONSE", "Codex returned an invalid thread/resume response");
    }
    return result;
  }

  async startTurn(threadId, text, options = {}) {
    const localImagePaths = Array.isArray(options.localImagePaths)
      ? options.localImagePaths.filter(
          (value) => typeof value === "string" && value.length > 0,
        )
      : [];
    const params = {
      threadId,
      input: [
        { type: "text", text, text_elements: [] },
        ...localImagePaths.map((imagePath) => ({
          type: "localImage",
          path: imagePath,
        })),
      ],
      ...(options.additionalContext
        ? {
            additionalContext: {
              reelterminal: {
                kind: "application",
                value: options.additionalContext,
              },
            },
          }
        : {}),
    };
    const result = await this.request("turn/start", params);
    if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== "string") {
      throw new CodexAppServerError("INVALID_RESPONSE", "Codex returned an invalid turn/start response");
    }
    return result.turn;
  }

  waitForTurn(turnId) {
    const completed = this.completedTurns.get(turnId);
    if (completed !== undefined) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      this.turnWaiters.set(turnId, { resolve, reject });
    });
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      this.reader?.close();
      const child = this.process;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        this.rejectPending(new CodexAppServerError("CLOSED", "Codex app-server client closed"));
        return;
      }
      child.stdin?.end();
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve();
        }, CLOSE_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.rejectPending(new CodexAppServerError("CLOSED", "Codex app-server client closed"));
    })();
    return this.closePromise;
  }

  write(message) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || this.closed) {
      throw new CodexAppServerError("CLOSED", "Codex app-server is not writable");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.failClosed(
        new CodexAppServerError("INVALID_JSON", "Codex app-server emitted invalid JSON"),
      );
      return;
    }
    if (!isRecord(message)) return;

    if (Object.hasOwn(message, "id") && typeof message.method !== "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        pending.reject(
          new CodexAppServerError(
            message.error.code ?? "REQUEST_FAILED",
            errorMessage(message.error, `Codex app-server rejected ${pending.method}`),
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      if (this.serverRequests.size === 0) {
        this.respondError(message.id, -32601, "Unsupported server request");
        return;
      }
      for (const listener of this.serverRequests) listener(message);
      return;
    }

    if (typeof message.method === "string") {
      if (
        message.method === "turn/completed" &&
        isRecord(message.params) &&
        isRecord(message.params.turn) &&
        typeof message.params.turn.id === "string"
      ) {
        const turnId = message.params.turn.id;
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          waiter.resolve(message.params.turn);
        } else {
          this.completedTurns.set(turnId, message.params.turn);
          if (this.completedTurns.size > 32) {
            this.completedTurns.delete(this.completedTurns.keys().next().value);
          }
        }
      }
      for (const listener of this.notifications) listener(message);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }

  failClosed(error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    for (const listener of this.closeListeners) listener(error);
  }
}
