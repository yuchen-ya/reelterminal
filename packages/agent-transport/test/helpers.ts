/**
 * Shared test helpers: spawn the real built CLI,
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
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (
      dir &&
      (existsSync(path.join(dir, "ffmpeg")) || existsSync(path.join(dir, "ffmpeg.exe"))) &&
      (existsSync(path.join(dir, "ffprobe")) || existsSync(path.join(dir, "ffprobe.exe")))
    ) {
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
    windowsHide: true,
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

import { createRequire as nodeCreateRequire } from "node:module";
const require = nodeCreateRequire(import.meta.url);
