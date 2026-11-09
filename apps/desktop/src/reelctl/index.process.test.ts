import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const validPlan = [{ op: "clip.trim", clipId: "clip-1", outPoint: 4 }];
const invalidPlan = [{ op: "clip.remove", clipId: "missing" }];
const validResponse = {
  ok: true,
  value: {
    valid: true,
    revision: 12,
    conflicts: [],
    warnings: [{ code: "TRIM_WARNING", message: "warning is preserved" }],
    normalizedOps: validPlan,
  },
};
const invalidResponse = {
  ok: true,
  value: {
    valid: false,
    revision: 12,
    conflicts: [{ code: "NOT_FOUND", message: "Clip missing does not exist", opIndex: 0 }],
    warnings: [{ code: "DELETE_WARNING", message: "warning is preserved" }],
    normalizedOps: invalidPlan,
  },
};

let runDir: string;
let cliPath: string;
let endpointPath: string;
let missingEndpoint: string;
let server: Server;
let requests: { readonly method: string; readonly path: string; readonly command?: string }[] = [];

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), "utf8");
}

function respond(response: import("node:http").ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

beforeAll(async () => {
  runDir = mkdtempSync(path.join(os.tmpdir(), "reelctl-process-test-"));
  missingEndpoint = path.join(runDir, "missing-endpoint.json");
  cliPath = path.join(runDir, "reelctl.cjs");
  await build({
    entryPoints: [path.resolve(__dirname, "index.ts")],
    outfile: cliPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["electron", "esbuild", "playwright-core", "mediabunny", "onnxruntime-node"],
    logLevel: "silent",
  });

  server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && requestPath === "/v1/status") {
      requests.push({ method: request.method, path: requestPath });
      respond(response, {
        ok: true, apiVersion: 1, instanceId: "process-test", projectId: "p", workspaceId: "w",
        projectEpoch: "epoch", projectRevision: 12, access: "write",
      });
      return;
    }
    if (request.method === "GET" && requestPath === "/v1/catalog/edit.validate") {
      requests.push({ method: request.method, path: requestPath });
      respond(response, {
        ok: true,
        apiVersion: 1,
        command: {
          name: "edit.validate",
          toolName: "edit_validate",
          description: "Validate an edit plan",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string" }, workspaceId: { type: "string" },
              expectedRevision: { type: "integer" }, ops: { type: "array" },
            },
            required: ["projectId", "workspaceId", "expectedRevision", "ops"],
          },
          effects: ["read"],
          retry: "safe",
        },
      });
      return;
    }
    if (request.method === "POST" && requestPath === "/v1/command") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          command?: string;
          arguments?: { ops?: { op?: string; clipId?: string }[] };
        };
        requests.push({ method: request.method!, path: requestPath, ...(body.command === undefined ? {} : { command: body.command }) });
        if (body.command !== "edit.validate") {
          respond(response, { ok: false, error: { code: "UNEXPECTED_COMMAND", message: "Only edit.validate is accepted by this fixture" } }, 400);
          return;
        }
        const invalid = body.arguments?.ops?.some(op => op.op === "clip.remove" && op.clipId === "missing") === true;
        respond(response, invalid ? invalidResponse : validResponse);
      });
      return;
    }
    respond(response, { ok: false, error: { code: "NOT_FOUND", message: "Unknown fixture route" } }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
  endpointPath = path.join(runDir, "endpoint.json");
  writeJson(endpointPath, {
    token: "test-token-never-printed",
    commandApi: { url: `http://127.0.0.1:${address.port}/v1`, version: 1 },
  });
}, 30_000);

afterEach(() => {
  requests = [];
});

afterAll(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  if (runDir) rmSync(runDir, { recursive: true, force: true });
});

function runCli(args: readonly string[], endpoint: string, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: endpoint, REELTERMINAL_REQUEST_TIMEOUT_MS: "2000" },
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
}

function runCliWithOpenStdin(args: readonly string[], endpoint: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: endpoint },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("reelctl help waited for stdin instead of exiting"));
    }, 10_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("reelctl real-process offline help", () => {
  const commandCases = [
    { args: ["frames", "extract", "--help"], command: "frames.extract" },
    { args: ["frames", "extract", "-h"], command: "frames.extract" },
    { args: ["edit", "validate", "--help"], command: "edit.validate" },
    { args: ["media", "inspect", "--help"], command: "media.inspect" },
    { args: ["call", "frames.extract", "--help"], command: "frames.extract" },
    { args: ["video", "call", "media.inspect", "--help"], command: "media.inspect" },
    { args: ["review", "frames", "capture", "--help"], command: "review.frames.capture" },
    { args: ["help", "frames", "extract"], command: "frames.extract" },
  ];

  it("returns zero for the full known help matrix with a missing endpoint", () => {
    const top = runCli(["--help"], missingEndpoint);
    expect(top.status, top.stderr).toBe(0);
    expect(top.stdout).toContain("reelctl — operate explicit ReelTerminal targets");
    for (const { args, command } of commandCases) {
      const result = runCli(args, missingEndpoint);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout, args.join(" ")).toContain(`${command} (`);
      expect(result.stdout).toContain(`Canonical invocation: reelctl call ${command} --file request.json`);
      expect(result.stdout).toContain("Input schema:");
      expect(result.stderr).toBe("");
    }
  });

  it("does not read a request file or wait for stdin before help", async () => {
    const missingRequest = path.join(runDir, "missing-request.json");
    const fileHelp = runCli(["frames", "extract", "--file", missingRequest, "--help"], missingEndpoint);
    expect(fileHelp.status, fileHelp.stderr).toBe(0);
    expect(fileHelp.stdout).toContain("frames.extract (frames_extract)");

    const stdinHelp = await runCliWithOpenStdin(["frames", "extract", "--stdin", "--help"], missingEndpoint);
    expect(stdinHelp.code, stdinHelp.stderr).toBe(0);
    expect(stdinHelp.stdout).toContain("frames.extract (frames_extract)");
  }, 20_000);

  it("returns two and discovery guidance for unknown paths without endpoint access", () => {
    for (const args of [
      ["frames", "unknown", "--help"],
      ["call", "media.unknown", "-h"],
      ["help", "frames", "unknown"],
    ]) {
      const result = runCli(args, missingEndpoint);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      expect(result.stderr).toMatch(/Unknown command path/i);
      expect(result.stderr).toMatch(/reelctl (?:tools|help)/);
    }
  });

  it("keeps local wrapper help offline", () => {
    for (const args of [
      ["tools", "system.environment", "--help"],
      ["start", "--help"],
      ["status", "-h"],
      ["environment", "check", "--help"],
    ]) {
      const result = runCli(args, missingEndpoint);
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`reelctl ${args[0]}`);
    }
  });
});

describe("reelctl real-process edit.validate exit codes", () => {
  const entries = [
    ["call", "edit.validate"],
    ["edit", "validate"],
    ["video", "call", "edit.validate"],
  ] as const;

  function requestFile(name: string, ops: unknown): string {
    const file = path.join(runDir, name);
    writeJson(file, {
      command: "edit.validate",
      arguments: { projectId: "p", workspaceId: "w", expectedRevision: 12, ops },
    });
    return file;
  }

  it("C01: valid plans exit zero and preserve the facade response", async () => {
    const file = requestFile("valid.json", validPlan);
    for (const entry of entries) {
      const result = await runCliWithOpenStdin([...entry, "--file", file], endpointPath);
      expect(result.code, `${entry.join(" ")}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(validResponse);
    }
    expect(requests.filter(request => request.command !== undefined).map(request => request.command)).toEqual([
      "edit.validate", "edit.validate", "edit.validate",
    ]);
  });

  it("C02: invalid plans exit three with NOT_FOUND conflicts and no apply", async () => {
    const file = requestFile("invalid.json", invalidPlan);
    for (const entry of entries) {
      const result = await runCliWithOpenStdin([...entry, "--file", file], endpointPath);
      expect(result.code, `${entry.join(" ")}\n${result.stderr}`).toBe(3);
      expect(JSON.parse(result.stdout)).toEqual(invalidResponse);
    }
    const commands = requests.filter(request => request.command !== undefined).map(request => request.command);
    expect(commands).toEqual(["edit.validate", "edit.validate", "edit.validate"]);
    expect(commands).not.toContain("edit.apply");
  });

  it("keeps a separate short help-looking value in a real business request", async () => {
    const result = await runCliWithOpenStdin([
      "call", "edit.validate",
      "--project-id", "p", "--workspace-id", "w", "--expected-revision", "12",
      "--ops", "[]", "--note", "-h",
    ], endpointPath);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(validResponse);
    expect(requests.map(request => request.command)).toContain("edit.validate");
  });
});
