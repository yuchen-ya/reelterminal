import { expect } from "vitest";
/** External-agent tests invoke the shipped CLI in a fresh process per request. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { REELCTL_PATH } from "./paths";
import type { CommandCatalogEntry } from "../../src/reelctl/client";

export interface FacadeCallResult<T = unknown> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface ExternalAgent {
  callCommand<T = unknown>(name: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<FacadeCallResult<T>>;
  listCommands(): Promise<readonly Pick<CommandCatalogEntry, "name" | "toolName" | "description">[]>;
  schema(name: string): Promise<CommandCatalogEntry>;
  clientStderr(): string;
  close(): Promise<void>;
}

export async function connectExternalAgent(endpointFile: string): Promise<ExternalAgent> {
  const children = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  let stderr = "";
  let closed = false;

  const invoke = (args: string[], input?: unknown, timeoutMs = 120_000): Promise<any> => {
    if (closed) return Promise.reject(new Error("CLI client is closed"));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [REELCTL_PATH, ...args], {
        env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: endpointFile },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let requestStderr = "";
      children.set(child, new Promise<void>((done) => child.once("close", done)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`reelctl ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        requestStderr += chunk;
        stderr += chunk;
      });
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (code !== 0 && code !== 3) {
          reject(new Error(`reelctl exited ${code}: ${requestStderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`reelctl did not return JSON (exit ${code}): ${requestStderr}`));
        }
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  };

  await invoke(["status"]);
  return {
    callCommand: (name, args = {}, options = {}) => invoke(
      ["call", name, "--stdin", "--timeout-ms", String(options.timeoutMs ?? 120_000)],
      { arguments: args },
      options.timeoutMs,
    ),
    listCommands: async () => (await invoke(["schema"])).commands,
    schema: async (name) => (await invoke(["schema", name])).command,
    clientStderr: () => stderr,
    async close() {
      closed = true;
      const pending = [...children.values()];
      for (const child of children.keys()) child.kill();
      await Promise.all(pending);
    },
  };
}

export function value<T>(reply: FacadeCallResult<T>): T {
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  return reply.value!;
}
