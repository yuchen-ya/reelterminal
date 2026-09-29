import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliErrorEnvelope, runReelctl } from "./index";
import { LiveCliError, type CommandCatalog, type CommandCatalogEntry, type LiveCommandClient } from "./client";
import { compactContextResult, formatResult } from "./output";
import { parseInvocation, requireExplicitSafetyGuards } from "./commands";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reelctl-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function entry(name: string, toolName: string, retry: CommandCatalogEntry["retry"] = "safe"): CommandCatalogEntry {
  return {
    name, toolName, description: `${name} description`,
    inputSchema: { type: "object", properties: { idempotencyKey: { type: "string" }, expectedRevision: { type: "integer" }, ops: { type: "array" } } },
    outputSchema: { type: "object" }, effects: [retry === "safe" ? "read" : "write"], retry,
  };
}

function makeClient(commands: CommandCatalogEntry[], result: unknown = { ok: true, value: { revision: 9 } }): LiveCommandClient {
  return {
    status: vi.fn().mockResolvedValue({ ok: true, apiVersion: 1, instanceId: "i", projectId: "p", projectEpoch: "e", access: "write" }),
    catalog: vi.fn().mockResolvedValue({ ok: true, apiVersion: 1, commands } satisfies CommandCatalog),
    catalogEntry: vi.fn().mockImplementation(async (name: string) => {
      const found = commands.find((candidate) => candidate.name === name || candidate.toolName === name);
      if (!found) throw new Error(`unknown test command: ${name}`);
      return found;
    }),
    command: vi.fn().mockResolvedValue(result),
    artifact: vi.fn(),
  } as unknown as LiveCommandClient;
}

describe("reelctl command parsing and safety", () => {
  it("supports the approved command shortcuts and array query selectors", () => {
    const query = parseInvocation(["query", "--ref", "R3", "--ref", "A2", "--fields", "id,startTime,duration"]);
    expect(query).toMatchObject({
      commandName: "timeline.query",
      arguments: { refs: ["R3", "A2"], fields: ["id", "startTime", "duration"] },
    });
    expect(parseInvocation(["preview", "frame", "--time", "12.5"]).arguments).toEqual({ timeSec: 12.5 });
    expect(parseInvocation(["job", "wait", "job-1"]).arguments).toEqual({ jobId: "job-1" });
  });

  it("keeps identity flags out of the closed history argument schema", () => {
    const invocation = parseInvocation(["history", "undo", "--expected-revision", "12", "--project-id", "p", "--project-epoch", "epoch"]);
    expect(invocation).toMatchObject({ expectedProjectId: "p", expectedProjectEpoch: "epoch" });
    expect(invocation.arguments).toEqual({ action: "undo", expectedRevision: 12 });
  });

  it("supports --fields output projection without sending it to a closed command", async () => {
    const api = makeClient([entry("editor.get_context", "editor_get_context")], {
      ok: true, value: { projectRevision: 9, identity: { projectId: "p", projectEpoch: "e" }, playheadSeconds: 2, selectedClipIds: ["clip"] },
    });
    const stdout: string[] = [];
    await runReelctl(["context", "--fields", "playheadSeconds"], { client: api, stdout: (line) => stdout.push(line) });
    expect(api.command).toHaveBeenCalledWith("editor.get_context", {}, expect.any(Object));
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, value: { projectRevision: 9, identity: { projectId: "p", projectEpoch: "e" }, playheadSeconds: 2 } });
  });

  it("requires revisions and explicit project identity for editor mutations", () => {
    expect(() => requireExplicitSafetyGuards("edit.apply", { ops: [] }, "p", "e"))
      .toThrow(/expectedRevision/);
    expect(() => requireExplicitSafetyGuards("history.control", { action: "undo", expectedRevision: 4 }, undefined, undefined))
      .toThrow(/expectedProjectId/);
    expect(() => requireExplicitSafetyGuards("edit.apply", { ops: [], expectedRevision: 4 }, "p", "e"))
      .not.toThrow();
  });

  it("prints help without looking for a live endpoint", async () => {
    const stdout: string[] = [];
    await expect(runReelctl(["--help"], { stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(stdout[0]).toContain("reelctl status");
  });

  it("returns stable JSON envelopes for invocation and connection errors", () => {
    expect(cliErrorEnvelope(new Error("connection refused"))).toEqual({
      ok: false, error: { code: "CONNECTION_FAILED", message: "connection refused" },
    });
    const argumentFailure = cliErrorEnvelope(new LiveCliError("missing revision", "args", 2));
    expect(argumentFailure).toEqual({ ok: false, error: { code: "INVALID_PARAMS", message: "missing revision" } });
  });

  it("does not apply a file intended for a different command", async () => {
    const file = path.join(tempDir(), "validate-only.json");
    writeFileSync(file, JSON.stringify({ command: "edit.validate", arguments: { ops: [] } }));
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    await expect(runReelctl(["edit", "apply", "--file", file], { client: api })).rejects.toMatchObject({ kind: "args", exitCode: 2 });
    expect(api.command).not.toHaveBeenCalled();
  });

  it("loads file envelopes, requires safety guards, and sends a guarded atomic edit", async () => {
    const file = path.join(tempDir(), "changes.json");
    writeFileSync(file, JSON.stringify({
      expectedProjectId: "project-old",
      expectedProjectEpoch: "epoch-old",
      arguments: { expectedRevision: 12, ops: [{ op: "clip.trim", clipId: "clip-1", outPoint: 4 }] },
    }));
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    const stdout: string[] = [];
    await expect(runReelctl(["edit", "apply", "--file", file], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith(
      "edit.apply",
      { expectedRevision: 12, ops: [{ op: "clip.trim", clipId: "clip-1", outPoint: 4 }] },
      expect.objectContaining({ expectedProjectId: "project-old", expectedProjectEpoch: "epoch-old", retry: "idempotent" }),
    );
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, value: { revision: 9 } });
  });

  it("makes generic call obey the same edit guards and output formatting", async () => {
    const file = path.join(tempDir(), "request.json");
    writeFileSync(file, JSON.stringify({
      expectedProjectId: "p", expectedProjectEpoch: "e",
      arguments: { expectedRevision: 3, ops: [] },
    }));
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    const stdout: string[] = [];
    await expect(runReelctl(["call", "edit.apply", "--file", file, "--human"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith("edit.apply", { expectedRevision: 3, ops: [] }, expect.objectContaining({ expectedProjectId: "p", expectedProjectEpoch: "e" }));
    expect(stdout[0]).toContain("\n");
  });

  it("waits for a terminal job status across command calls", async () => {
    const api = makeClient([entry("job.status", "job_status")]);
    (api.command as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, value: { jobId: "job-1", state: "running" } })
      .mockResolvedValueOnce({ ok: true, value: { jobId: "job-1", state: "done", result: { path: "x" } } });
    const stdout: string[] = [];
    await expect(runReelctl(["job", "wait", "job-1", "--interval-ms", "1", "--timeout-ms", "1000"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, value: { state: "done" } });
  });
});

describe("reelctl output contracts", () => {
  it("keeps revisions and identity when projecting result fields", () => {
    const result = formatResult({
      ok: true,
      value: { revision: 8, contextRevision: 5, identity: { projectId: "p", projectEpoch: "e" }, state: "done", path: "/tmp/out" },
    }, { human: false, compact: false, outputFields: ["state"] });
    expect(JSON.parse(result)).toEqual({
      ok: true,
      value: { revision: 8, contextRevision: 5, identity: { projectId: "p", projectEpoch: "e" }, state: "done" },
    });
  });

  it("writes exact bytes and preserves a failure envelope for --output-file", () => {
    const file = path.join(tempDir(), "result.json");
    const formatted = formatResult({ ok: false, error: { code: "CONFLICT", message: "stale" } }, {
      human: false, compact: false, outputFile: file,
    });
    const receipt = JSON.parse(formatted) as { ok: boolean; error: { code: string; message: string; savedTo: string; sizeBytes: number; sha256: string } };
    const bytes = readFileSync(file);
    expect(receipt).toMatchObject({ ok: false, error: { code: "CONFLICT", message: "stale", savedTo: file } });
    expect(JSON.parse(bytes.toString("utf8"))).toEqual({ ok: false, error: { code: "CONFLICT", message: "stale" } });
    expect(receipt.error.sizeBytes).toBe(bytes.length);
    expect(receipt.error.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("compacts editor context without dropping user-selected canvas or guards", () => {
    const compact = compactContextResult({
      ok: true,
      value: {
        projectRevision: 11, contextRevision: 7, identity: { projectId: "p", projectEpoch: "e" },
        canvasPoint: { x: 4, y: 8 }, playheadSeconds: 2, fullProject: { huge: true },
      },
    });
    expect(compact).toEqual({
      ok: true,
      value: {
        projectRevision: 11, contextRevision: 7, identity: { projectId: "p", projectEpoch: "e" },
        canvasPoint: { x: 4, y: 8 }, playheadSeconds: 2,
      },
    });
  });

  it("reports a missing request file as an invocation error", async () => {
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    const missing = path.join(tempDir(), "missing.json");
    await expect(runReelctl(["edit", "apply", "--file", missing], { client: api })).rejects.toMatchObject({
      kind: "args",
      exitCode: 2,
    });
  });
});
