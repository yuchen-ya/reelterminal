/**
 * Shared test helpers: spawn the real built CLI, an MCP client over stdio,
 * and preflight gates (Chromium / ffmpeg) with printed skip reasons.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CLI = path.join(packageDir, "dist", "cli.js");

export function chromiumAvailable(): boolean {
  // The Playwright-managed browser registry: resolved from the
  // runtime-chromium dependency exactly as the runtime resolves it.
  try {
    const { createRequire } = require("node:module");
    const req = createRequire(
      path.join(packageDir, "../runtime-chromium/package.json"),
    );
    const { chromium } = req("playwright-core");
    return existsSync(chromium.executablePath());
  } catch {
    console.warn(
      "[helpers] chromium preflight could not resolve playwright-core — treating as unavailable",
    );
    return false;
  }
}

export function ffmpegAvailable(): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(path.join(dir, "ffmpeg")) && existsSync(path.join(dir, "ffprobe"))) {
      return true;
    }
  }
  return false;
}

export interface Roots {
  mediaRoot: string;
  artifactRoot: string;
  projectRoot: string;
  cleanup: () => Promise<void>;
}

export async function makeRoots(): Promise<Roots> {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "ave-media-"));
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "ave-artifacts-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "ave-projects-"));
  return {
    mediaRoot,
    artifactRoot,
    projectRoot,
    cleanup: async () => {
      await rm(mediaRoot, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}

export interface CliHandle {
  child: ChildProcess & { stdout: any; stderr: any; stdin: any };
  stdout: string;
  stderr: string;
  exitCode: Promise<number>;
  write: (line: string) => void;
  endStdin: () => void;
}

export function spawnCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): CliHandle {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: packageDir,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle: CliHandle = {
    child,
    stdout: "",
    stderr: "",
    exitCode: Promise.resolve(-1),
    write: (line: string) => {
      child.stdin.write(line);
    },
    endStdin: () => child.stdin.end(),
  };
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    handle.stdout += chunk;
  });
  child.stderr!.on("data", (chunk: string) => {
    handle.stderr += chunk;
  });
  handle.exitCode = new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });
  return handle;
}

export interface McpClient {
  send: (message: Record<string, unknown>) => void;
  read: (timeoutMs?: number) => Promise<Record<string, any>>;
  handle: CliHandle;
}

/** Minimal NDJSON MCP client over a spawned serve process. */
export function startServe(
  args: readonly string[] = [],
  env: Record<string, string | undefined> = {},
): McpClient {
  const handle = spawnCli(["serve", ...args], env);
  const pending: Record<string, any>[] = [];
  let notify: (() => void) | null = null;
  handle.child.stdout.on("data", (chunk: string) => {
    handle.stdout += chunk;
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        pending.push(parsed);
        const n = notify;
        notify = null;
        n?.();
      } catch {
        // non-JSON stdout is a purity violation asserted by tests
      }
    }
  });
  return {
    handle,
    send: (message) => handle.write(`${JSON.stringify(message)}\n`),
    read: (timeoutMs = 120_000) =>
      new Promise((resolve, reject) => {
        if (pending.length > 0) return resolve(pending.shift() as Record<string, any>);
        const timer = setTimeout(() => {
          notify = null;
          reject(new Error(`timed out reading MCP frame; stdout=${handle.stdout}`));
        }, timeoutMs);
        notify = () => {
          clearTimeout(timer);
          resolve(pending.shift() as Record<string, any>);
        };
      }),
  };
}

export interface InitializeResult {
  id: number;
  result: {
    serverInfo: Record<string, unknown>;
    capabilities: Record<string, unknown>;
  };
}

export async function initialize(client: McpClient, protocolVersion = "2025-06-18"): Promise<InitializeResult> {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "agent-transport-test", version: "0" },
    },
  });
  const init = (await client.read()) as InitializeResult;
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return init;
}

import { createRequire as nodeCreateRequire } from "node:module";
const require = nodeCreateRequire(import.meta.url);
