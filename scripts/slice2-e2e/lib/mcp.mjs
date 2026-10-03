/**
 * Path (b) — a scripted stdio MCP client over the REAL built cli.js
 * (`serve`), raw NDJSON framing exactly like
 * packages/agent-transport/test/helpers.ts. Label for evidence: simulated.
 *
 * Every JSON-RPC frame (request and response) is mirrored into the recorder
 * transcript, so the transcript carries every tool call + result verbatim.
 */
import { spawn } from "node:child_process";

export class ServeClient {
  /**
   * @param cliPath absolute path to packages/agent-transport/dist/cli.js
   * @param args serve arguments (e.g. ["--media-root", ...])
   * @param env extra env (OPENREEL_AVE_*); process.env is inherited
   * @param recorder transcript recorder (optional)
   * @param label which actor this process represents (e.g. "mcp/A")
   */
  constructor({ cliPath, args = [], env = {}, recorder, label }) {
    this.recorder = recorder;
    this.label = label;
    this.nextId = 1;
    this.pending = [];
    this.waiters = [];
    this.closed = false;
    this.exitCode = null;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = spawn(process.execPath, [cliPath, "serve", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let stdoutBuffer = "";
    this.child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // stdout purity violation — record and keep going; assertions will
          // fail if it corrupts the protocol.
          void this.recorder?.record("stdout-purity-violation", { label: this.label, line });
          continue;
        }
        this.pending.push(parsed);
        const waiter = this.waiters.shift();
        if (waiter) waiter();
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("close", (code) => {
      this.exitCode = code;
      this.closed = true;
      this.resolveExit(code);
      const waiter = this.waiters.shift();
      if (waiter) waiter();
    });
  }

  async record(type, payload) {
    if (this.recorder) await this.recorder.record(type, payload);
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  read(timeoutMs = 180_000) {
    if (this.pending.length > 0) return Promise.resolve(this.pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(entry);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new Error(`[${this.label}] timed out reading MCP frame; stderr=${this.stderr.slice(-2000)}`),
        );
      }, timeoutMs);
      const entry = () => {
        clearTimeout(timer);
        if (this.pending.length > 0) resolve(this.pending.shift());
        else {
          reject(
            new Error(
              `[${this.label}] serve closed (exit ${this.exitCode}) before a frame arrived; stderr=${this.stderr.slice(-2000)}`,
            ),
          );
        }
      };
      this.waiters.push(entry);
    });
  }

  /** MCP handshake; returns the initialize result. */
  async initialize({ clientName = "reelterminal-e2e-simulated-mcp" } = {}) {
    const id = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "0" },
      },
    };
    await this.record("mcp-request", { label: this.label, request });
    this.send(request);
    const init = await this.read();
    await this.record("mcp-response", { label: this.label, response: init });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  /**
   * tools/call — resolves to the parsed FacadeResult (the single text
   * content block, B.4) and records both frames plus the raw CallToolResult.
   */
  async call(tool, params) {
    const id = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: params },
    };
    await this.record("mcp-request", { label: this.label, tool, params, request });
    this.send(request);
    const response = await this.read();
    await this.record("mcp-response", { label: this.label, tool, response });
    if (response.error !== undefined) {
      throw new Error(`[${this.label}] ${tool}: JSON-RPC protocol error ${JSON.stringify(response.error)}`);
    }
    const callResult = response.result;
    const text = callResult?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`[${this.label}] ${tool}: no text content block in result ${JSON.stringify(callResult)}`);
    }
    const facadeResult = JSON.parse(text);
    return { facadeResult, callResult };
  }

  /** Close stdin (client disconnect — the Decision 7 EOF trigger). */
  disconnect() {
    this.child.stdin.end();
  }

  /** Hard-kill (SIGKILL variant of scenario 2 step 3). */
  kill(signal) {
    this.child.kill(signal);
  }

  async waitForExit() {
    return this.exitPromise;
  }
}
