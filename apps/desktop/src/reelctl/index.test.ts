import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliErrorEnvelope, runReelctl } from "./index";
import { LiveCliError, type CommandCatalog, type CommandCatalogEntry, type LiveCommandClient } from "./client";
import { compactContextResult, formatResult } from "./output";
import { COMMAND_ALIASES, parseInvocation, requireExplicitSafetyGuards } from "./commands";
import { encodeAgentTarget } from "../shared/agent-target";

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
    inputSchema: {
      type: "object",
      properties: { idempotencyKey: { type: "string" }, expectedRevision: { type: "integer" }, ops: { type: "array" }, projectId: { type: "string" }, workspaceId: { type: "string" } },
      ...(name === "edit.apply" ? { required: ["projectId", "workspaceId", "expectedRevision"] } :
        name === "project.get_state" ? { required: ["projectId", "workspaceId"] } : {}),
    },
    outputSchema: { type: "object" }, effects: [retry === "safe" ? "read" : "write"], retry,
  };
}

function makeClient(commands: CommandCatalogEntry[], result: unknown = { ok: true, value: { revision: 9 } }): LiveCommandClient {
  return {
    status: vi.fn().mockResolvedValue({ ok: true, apiVersion: 1, instanceId: "i", projectId: "p", workspaceId: "w", projectEpoch: "e", access: "write" }),
    catalog: vi.fn().mockResolvedValue({ ok: true, apiVersion: 1, commands } satisfies CommandCatalog),
    catalogEntry: vi.fn().mockImplementation(async (name: string) => {
      const found = commands.find((candidate) => candidate.name === name || candidate.toolName === name);
      if (!found) throw new Error(`unknown test command: ${name}`);
      return found;
    }),
    command: vi.fn().mockResolvedValue(result),
  } as unknown as LiveCommandClient;
}

describe("reelctl command parsing and safety", () => {
  it("discovers short domain and capability cards offline and selects only the requested op contract", async () => {
    const api = makeClient([]);
    const stdout: string[] = [];
    await runReelctl(["tools"], { client: api, stdout: line => stdout.push(line) });
    await runReelctl(["tools", "review"], { client: api, stdout: line => stdout.push(line) });
    await runReelctl(["tools", "review.image-repair"], { client: api, stdout: line => stdout.push(line) });
    await runReelctl(["describe", "edit.apply", "--op", "clip.trim", "--op", "track.add"], { client: api, stdout: line => stdout.push(line) });
    expect(JSON.parse(stdout[0]!).value.domains.map((domain: { id: string }) => domain.id)).toEqual(["video", "review", "library", "system"]);
    expect(stdout[0]!.length).toBeLessThan(1000);
    expect(stdout.slice(0, 3).join("\n")).not.toContain("inputSchema");
    const contract = JSON.parse(stdout[3]!).value;
    expect(contract.inputSchema.properties.ops.items.anyOf.map((variant: { properties: { op: { const: string } } }) => variant.properties.op.const).sort()).toEqual(["clip.trim", "track.add"]);
    expect(contract.outputSchema).toBeUndefined();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.catalog).not.toHaveBeenCalled();
    expect(api.catalogEntry).not.toHaveBeenCalled();
    expect(api.command).not.toHaveBeenCalled();
    await expect(runReelctl(["tools", "unknown"])).rejects.toMatchObject({ exitCode: 2 });
    await expect(runReelctl(["describe", "edit_apply"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("uses the same alias table for call, schema and help including frame-processing aliases", async () => {
    const stdout: string[] = [];
    const commands = [...new Set(Object.values(COMMAND_ALIASES))].map(name => entry(name, name.replaceAll(".", "_")));
    const api = makeClient(commands);
    for (const alias of ["image align", "motion track", "mask refine", "patch propagate"]) {
      await runReelctl(["call", alias], { client: api, stdout: line => stdout.push(line) });
      expect(api.command).toHaveBeenLastCalledWith(COMMAND_ALIASES[alias], {}, expect.any(Object));
      await runReelctl(["schema", ...alias.split(" ")], { client: api, stdout: line => stdout.push(line) });
      expect(JSON.parse(stdout.at(-1)!).command.name).toBe(COMMAND_ALIASES[alias]);
      await runReelctl(["help", ...alias.split(" ")], { client: api, stdout: line => stdout.push(line) });
      expect(stdout.at(-1)).toContain(`Compatibility aliases: ${alias}`);
    }
    await expect(runReelctl(["call", "image_align"], { client: api })).rejects.toMatchObject({ exitCode: 2 });
    expect(api.catalog).not.toHaveBeenCalled();
  });

  it("starts only the copied target without fetching catalog or current selection", async () => {
    const api = makeClient([]);
    const start = vi.fn().mockResolvedValue({ ok: true, value: { connected: true, access: "read-only" } });
    Object.assign(api, { start });
    const target = encodeAgentTarget({ kind: "video", projectId: "fixed-project", workspaceId: "fixed-workspace", instanceId: "runtime", hostInstanceId: "host" });
    const stdout: string[] = [];
    expect(await runReelctl(["start", "--target", target], { client: api, stdout: line => stdout.push(line) })).toBe(0);
    expect(start).toHaveBeenCalledWith(target);
    expect(api.status).not.toHaveBeenCalled();
    expect(api.catalog).not.toHaveBeenCalled();
    await expect(runReelctl(["start", "--target", "current"], { client: api })).rejects.toMatchObject({ exitCode: 2 });
  });
  it("resolves three-word repair commands without consuming flags or changing legacy commands", () => {
    expect(parseInvocation(["review", "repair", "inspect", "--file", "crop.json"])).toMatchObject({ commandName: "review.repair.inspect", file: "crop.json", arguments: {} });
    expect(parseInvocation(["review", "repair", "apply", "--file", "batch.json"])).toMatchObject({ commandName: "review.repair.apply", file: "batch.json" });
    expect(parseInvocation(["review", "frames", "capture", "--file", "frame.json"])).toMatchObject({ commandName: "review.frames.capture", file: "frame.json" });
    expect(parseInvocation(["review", "context"]).commandName).toBe("review.context");
    expect(parseInvocation(["frames", "extract", "--start-frame", "2"]).arguments).toEqual({ startFrame: 2 });
    expect(parseInvocation(["context", "--compact"]).compact).toBe(true);
    expect(() => parseInvocation(["review", "repair", "inspect", "unexpected"])).toThrow(/Unexpected positional/);
  });

  it("dispatches repair files and resolves the same dedicated alias for help and schema", async () => {
    const file = path.join(tempDir(), "repair.json");
    const request = { target: { kind: "review", nodeId: "node" }, expectedNodeRevision: 2, itemId: "image", expectedItemVersion: 1,
      region: { space: "source-pixels", x: 10, y: 20, width: 40, height: 30 } };
    writeFileSync(file, JSON.stringify(request));
    const api = makeClient([entry("review.repair.inspect", "review_repair_inspect")]);
    const output: string[] = [];
    await runReelctl(["review", "repair", "inspect", "--file", file], { client: api, stdout: line => output.push(line) });
    expect(api.command).toHaveBeenCalledWith("review.repair.inspect", request, expect.any(Object));
    await runReelctl(["schema", "review", "repair", "inspect"], { client: api, stdout: line => output.push(line) });
    expect(api.catalogEntry).toHaveBeenLastCalledWith("review.repair.inspect");
    await runReelctl(["help", "review", "repair", "inspect"], { client: api, stdout: line => output.push(line) });
    expect(output.at(-1)).toContain("review.repair.inspect");
  });
  it("does not advertise or dispatch the removed MCP adapter", async () => {
    const output: string[] = [];
    const client = makeClient([]);
    expect(await runReelctl(["--help"], { client, stdout: (line) => output.push(line) })).toBe(0);
    expect(output.join("\n")).not.toContain("mcp serve");
    await expect(runReelctl(["mcp", "serve"], { client })).rejects.toThrow();
    expect(client.command).not.toHaveBeenCalled();
  });

  it("supports the approved command shortcuts and array query selectors", () => {
    const query = parseInvocation(["query", "--ref", "R3", "--ref", "A2", "--fields", "id,startTime,duration"]);
    expect(query).toMatchObject({
      commandName: "timeline.query",
      arguments: { refs: ["R3", "A2"], fields: ["id", "startTime", "duration"] },
    });
    expect(parseInvocation(["preview", "frame", "--time", "12.5"]).arguments).toEqual({ timeSec: 12.5 });
    expect(parseInvocation(["job", "wait", "job-1"]).arguments).toEqual({ jobId: "job-1" });
    expect(parseInvocation(["mask", "refine"]).commandName).toBe("mask.refine");
    expect(parseInvocation(["patch", "propagate"]).commandName).toBe("patch.propagate");
  });

  it("keeps data targets separate from open-view guards", () => {
    const invocation = parseInvocation(["history", "undo", "--expected-revision", "12", "--project-id", "p", "--workspace-id", "w", "--expected-project-id", "view-p", "--project-epoch", "epoch"]);
    expect(invocation).toMatchObject({ expectedProjectId: "view-p", expectedProjectEpoch: "epoch" });
    expect(invocation.arguments).toEqual({ action: "undo", expectedRevision: 12, projectId: "p", workspaceId: "w" });
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
    const editEntry = entry("edit.apply", "edit_apply", "idempotent");
    expect(() => requireExplicitSafetyGuards("edit.apply", { ops: [], projectId: "p", workspaceId: "w" }, editEntry))
      .toThrow(/expectedRevision/);
    expect(() => requireExplicitSafetyGuards("edit.apply", { ops: [], expectedRevision: 4 }, editEntry))
      .toThrow(/projectId/);
    expect(() => requireExplicitSafetyGuards("edit.apply", { ops: [], projectId: "p", workspaceId: "w", expectedRevision: 4 }, editEntry))
      .not.toThrow();
  });

  it("prints help without looking for a live endpoint", async () => {
    const stdout: string[] = [];
    await expect(runReelctl(["--help"], { stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(stdout[0]).toContain("reelctl status");
  });

  it("advertises a review-only cleanup entry for the exact visible workspace", async () => {
    const api = makeClient([]);
    const stdout: string[] = [];
    await expect(runReelctl(["status"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(JSON.parse(stdout[0]!).value.cleanupReview).toEqual({
      command: "media.cleanup.review", arguments: { projectId: "p", workspaceId: "w" },
    });
    expect(api.command).not.toHaveBeenCalled();
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
      expectedProjectEpoch: "epoch-old",
      arguments: { projectId: "project-old", workspaceId: "workspace-old", expectedRevision: 12, ops: [{ op: "clip.trim", clipId: "clip-1", outPoint: 4 }] },
    }));
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    const stdout: string[] = [];
    await expect(runReelctl(["edit", "apply", "--file", file], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith(
      "edit.apply",
      { projectId: "project-old", workspaceId: "workspace-old", expectedRevision: 12, ops: [{ op: "clip.trim", clipId: "clip-1", outPoint: 4 }] },
      expect.objectContaining({ expectedProjectEpoch: "epoch-old", retry: "idempotent" }),
    );
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, value: { revision: 9 } });
  });

  it("makes generic call obey the same edit guards and output formatting", async () => {
    const file = path.join(tempDir(), "request.json");
    writeFileSync(file, JSON.stringify({
      expectedProjectEpoch: "e",
      arguments: { projectId: "p", workspaceId: "w", expectedRevision: 3, ops: [] },
    }));
    const api = makeClient([entry("edit.apply", "edit_apply", "idempotent")]);
    const stdout: string[] = [];
    await expect(runReelctl(["call", "edit.apply", "--file", file, "--human"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith("edit.apply", { projectId: "p", workspaceId: "w", expectedRevision: 3, ops: [] }, expect.objectContaining({ expectedProjectEpoch: "e" }));
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

  it("lists compact requirements through the requirement-only query", async () => {
    const api = makeClient([entry("requirements.list", "requirements_list")]);
    (api.command as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: {
        revision: 4,
        requirements: [{ ref: "Q1", title: "Opening", status: "ready", priority: "high", markerIds: ["m1"], updatedAt: 12 }],
      },
    });
    const stdout: string[] = [];
    await expect(runReelctl(["requirements", "list", "--status", "ready", "--compact"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith("requirements.list", { projectId: "p", workspaceId: "w", status: "ready" }, expect.objectContaining({ expectedProjectId: "p", expectedProjectEpoch: "e" }));
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, value: { revision: 4, requirements: [{ ref: "Q1", title: "Opening", status: "ready", priority: "high", markerIds: ["m1"], updatedAt: 12 }] } });
  });

  it("uses explicit target ids when status omits the workspace id", async () => {
    const api = makeClient([entry("requirements.list", "requirements_list")]);
    (api.status as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, apiVersion: 1, instanceId: "i", projectId: "p", workspaceId: null, projectEpoch: "e", access: "write",
    });
    (api.command as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { revision: 2, requirements: [{ ref: "Q1", title: "Solo", status: "ready", priority: "normal", markerIds: [], updatedAt: 3 }] },
    });
    const stdout: string[] = [];
    await expect(runReelctl(["requirements", "list", "--compact", "--project-id", "target-p", "--workspace-id", "target-w"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenCalledWith("requirements.list", { projectId: "target-p", workspaceId: "target-w" }, expect.any(Object));
    expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, value: { revision: 2, requirements: [{ ref: "Q1", title: "Solo", status: "ready", priority: "normal", markerIds: [], updatedAt: 3 }] } });
  });

  it("updates a requirement through one revision-guarded edit.apply", async () => {
    const api = makeClient([
      entry("requirements.get", "requirements_get"),
      entry("edit.apply", "edit_apply", "idempotent"),
    ]);
    (api.command as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, value: { revision: 7, requirement: { id: "internal", ref: "Q3", title: "Audio", status: "ready", markerIds: [] } } })
      .mockResolvedValueOnce({ ok: true, value: { revision: 8 } });
    const stdout: string[] = [];
    await expect(runReelctl(["requirements", "update", "Q3", "--status", "in_progress", "--agent-note", "Started"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(api.command).toHaveBeenLastCalledWith(
      "edit.apply",
      { projectId: "p", workspaceId: "w", ops: [{ op: "requirement.update", requirementId: "Q3", status: "in_progress", agentNote: "Started" }], expectedRevision: 7 },
      expect.objectContaining({ expectedProjectEpoch: "e", retry: "idempotent" }),
    );
  });

  it("preserves an explicit stale revision and surfaces the edit conflict", async () => {
    const api = makeClient([entry("requirements.get", "requirements_get"), entry("edit.apply", "edit_apply", "idempotent")]);
    (api.command as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, value: { revision: 7, requirement: { ref: "Q3" } } })
      .mockResolvedValueOnce({ ok: false, error: { code: "CONFLICT", message: "Revision changed" } });
    const stdout: string[] = [];
    await expect(runReelctl(["requirements", "update", "Q3", "--status", "in_progress", "--expected-revision", "6"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(3);
    expect(api.command).toHaveBeenLastCalledWith("edit.apply", expect.objectContaining({ expectedRevision: 6 }), expect.objectContaining({ expectedProjectEpoch: "e" }));
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
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
        projectRevision: 11, contextRevision: 7, identity: { projectId: "p", projectEpoch: "e", workspaceId: "w", workspaceInstanceId: "runtime-1" },
        canvasPoint: { x: 4, y: 8 }, playheadSeconds: 2, fullProject: { huge: true },
        requirements: { ready: 1, inProgress: 0, ids: ["Q1"] },
      },
    });
    expect(compact).toEqual({
      ok: true,
      value: {
        projectRevision: 11, contextRevision: 7, identity: { projectId: "p", projectEpoch: "e", workspaceId: "w", workspaceInstanceId: "runtime-1" },
        canvasPoint: { x: 4, y: 8 }, playheadSeconds: 2,
        requirements: { ready: 1, inProgress: 0, ids: ["Q1"] },
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

describe("reelctl schema domain filtering", () => {
  const catalogCommands = [
    entry("audio.process.normalize", "audio_process_normalize"),
    entry("audio.process.register", "audio_process_register"),
    entry("media.import", "media_import"),
    entry("edit.apply", "edit_apply", "idempotent"),
    entry("capabilities.get", "capabilities_get"),
  ];

  it("filters the schema index by a catalog domain", async () => {
    const api = makeClient(catalogCommands);
    const stdout: string[] = [];
    await expect(runReelctl(["schema", "--domain", "audio"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    const payload = JSON.parse(stdout[0]!) as { ok: boolean; domain: string; domains: string[]; commands: { name: string }[] };
    expect(payload.ok).toBe(true);
    expect(payload.domain).toBe("audio");
    expect(payload.domains).toEqual(["audio", "capabilities", "edit", "media"]);
    expect(payload.commands.map((command) => command.name)).toEqual(["audio.process.normalize", "audio.process.register"]);
    expect(api.catalog).toHaveBeenCalledTimes(1);
  });

  it("supports the --domain=name form", async () => {
    const api = makeClient(catalogCommands);
    const stdout: string[] = [];
    await expect(runReelctl(["schema", "--domain=media"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    const payload = JSON.parse(stdout[0]!) as { domain: string; commands: { name: string }[] };
    expect(payload.domain).toBe("media");
    expect(payload.commands.map((command) => command.name)).toEqual(["media.import"]);
  });

  it("lists domains on the unfiltered index", async () => {
    const api = makeClient(catalogCommands);
    const stdout: string[] = [];
    await expect(runReelctl(["schema"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    const payload = JSON.parse(stdout[0]!) as { domains: string[]; commands: { name: string }[] };
    expect(payload.domains).toEqual(["audio", "capabilities", "edit", "media"]);
    expect(payload.commands).toHaveLength(5);
  });

  it("rejects an unknown domain with the available domains", async () => {
    const api = makeClient(catalogCommands);
    let failure: unknown;
    try {
      await runReelctl(["schema", "--domain", "nope"], { client: api });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "args", exitCode: 2 });
    expect((failure as LiveCliError).message).toContain("Unknown schema domain \"nope\"");
    expect((failure as LiveCliError).message).toContain("audio, capabilities, edit, media");
  });

  it("keeps single-command schema exact and refuses combining name with --domain", async () => {
    const api = makeClient(catalogCommands);
    const stdout: string[] = [];
    await expect(runReelctl(["schema", "audio.process.normalize"], { client: api, stdout: (line) => stdout.push(line) })).resolves.toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, command: { name: "audio.process.normalize" } });
    await expect(runReelctl(["schema", "--domain", "audio", "media.import"], { client: api }))
      .rejects.toMatchObject({ kind: "args", exitCode: 2 });
    await expect(runReelctl(["schema", "--domain"], { client: api })).rejects.toMatchObject({ kind: "args", exitCode: 2 });
    await expect(runReelctl(["schema", "--domain", "audio", "--domain", "media"], { client: api }))
      .rejects.toMatchObject({ kind: "args", exitCode: 2 });
  });
});

describe("reelctl review discovery", () => {
  it("routes review describe to the review-scoped session workflow", async () => {
    const result = { ok: true, value: { kind: "review", notes: ["Read review context and review capabilities, then schema <command>."] } };
    const api = makeClient([entry("session.describe", "session_describe")], result);
    const stdout: string[] = [];
    expect(await runReelctl(["review", "describe"], { client: api, stdout: (line) => stdout.push(line) })).toBe(0);
    expect(api.command).toHaveBeenCalledWith("session.describe", { kind: "review" }, expect.any(Object));
    expect(JSON.parse(stdout[0]!)).toEqual(result);
  });

  it("preserves command and nested field guidance in schema and help", async () => {
    const reviewEntry = {
      ...entry("review.ingest", "review_ingest"),
      description: "Read review.get for the revision, then organize real review items.",
      inputSchema: {
        type: "object",
        properties: { items: { type: "array", items: { type: "object", properties: {
          title: { type: "string", description: "Keep the item title compact; put background on the batch." },
        } } } },
      },
    };
    const api = makeClient([reviewEntry]);
    const stdout: string[] = [];
    expect(await runReelctl(["schema", "review.ingest"], { client: api, stdout: (line) => stdout.push(line) })).toBe(0);
    expect(JSON.parse(stdout[0]!).command).toEqual(reviewEntry);
    expect(await runReelctl(["help", "review.ingest"], { client: api, stdout: (line) => stdout.push(line) })).toBe(0);
    expect(stdout[1]).toContain(reviewEntry.description);
    expect(stdout[1]).toContain("Keep the item title compact");
    expect(api.command).not.toHaveBeenCalled();
  });
});
