import { spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;
const STDERR_SUMMARY_MAX_LENGTH = 240;

/**
 * One-line, sanitized summary of App Server stderr for setup diagnostics.
 * Absolute paths collapse to their file name (and `~` for the home
 * directory) so the summary stays free of paths, and obvious credential
 * shapes are redacted. Returns null for empty input.
 */
export function sanitizeStderrLine(line, maxLength = STDERR_SUMMARY_MAX_LENGTH) {
  if (typeof line !== "string") return null;
  let text = line.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const home = os.homedir();
  if (home && home.length > 2) text = text.split(home).join("~");
  text = text
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|]+\\)*[^\\/:*?"<>|]*/g, (match) =>
      `…\\${match.slice(match.lastIndexOf("\\") + 1)}`)
    .replace(/(?:\/[A-Za-z0-9@._-]+){2,}/g, (match) =>
      `…/${match.slice(match.lastIndexOf("/") + 1)}`)
    .replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi, "[redacted]");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

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
  constructor(code, message, detail = null) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    // Sanitized stderr summary (see sanitizeStderrLine) or other bounded,
    // path-free diagnostic context. Safe for the setup UI detail line.
    this.detail = typeof detail === "string" && detail ? detail : null;
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
    // stdio is the app-server default transport (`--listen` defaults to
    // `stdio://`; verified on 0.130.0 and 0.153.2). The previously hardcoded
    // `--stdio` flag failed the spawn outright on every CLI version probed
    // (exit 2, `unexpected argument '--stdio' found`, observed on 0.130.0;
    // 0.153.2 `--help` no longer lists the flag). Which versions ever
    // accepted it is unverified, so the bare subcommand is the portable form.
    this.commandArgs = options.commandArgs ?? ["app-server"];
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
    this.stderrSummary = null;
    this.lastFailure = null;
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
    child.once("error", (error) =>
      this.failClosed(
        new CodexAppServerError(
          "SPAWN_FAILED",
          errorMessage(error, "Codex app-server failed to start"),
        ),
      ));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const summary = this.stderrSummary;
      const reason = signal ?? (code === null ? "unknown" : `exit code ${code}`);
      this.failClosed(
        new CodexAppServerError(
          "PROCESS_EXIT",
          `Codex app-server exited unexpectedly (${reason})${summary ? `: ${summary}` : ""}`,
          summary,
        ),
      );
    });
    if (!child.stdout || !child.stdin) {
      throw new CodexAppServerError("SPAWN_FAILED", "Codex app-server stdio is unavailable");
    }
    // App Server diagnostics are not part of the protocol and may contain
    // provider details. Keep the child draining so it cannot block, retain a
    // sanitized first line for setup diagnostics only, and never relay either
    // into the ReelTerminal conversation surface.
    child.stderr?.on("data", (chunk) => this.noteStderr(chunk));
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
    try {
      this.notify("initialized", {});
    } catch {
      // The process died between the initialize response and the initialized
      // notification; surface the recorded failure instead of the secondary
      // write error, which carries no diagnostic value.
      throw this.lastFailure ??
        new CodexAppServerError("CLOSED", "Codex app-server closed before initialization completed");
    }
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
            this.stderrSummary,
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

  async readAccount() {
    const result = await this.request("account/read", { refreshToken: false });
    if (!isRecord(result) || !("account" in result)) {
      throw new CodexAppServerError("INVALID_RESPONSE", "Codex returned an invalid account/read response");
    }
    return result;
  }

  async listThreads(params = {}) {
    const result = await this.request("thread/list", params);
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw new CodexAppServerError("INVALID_RESPONSE", "Codex returned an invalid thread/list response");
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

  compactThread(threadId) {
    return this.request("thread/compact/start", { threadId });
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

  noteStderr(chunk) {
    if (this.stderrSummary) return;
    const firstLine = String(chunk).split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return;
    this.stderrSummary = sanitizeStderrLine(firstLine);
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
    this.lastFailure = error;
    this.rejectPending(error);
    for (const listener of this.closeListeners) listener(error);
  }
}
