#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  LiveCliError,
  LiveCommandClient,
  catalogCommand,
  hasSchemaProperty,
  type CommandCatalogEntry,
  type FacadeResult,
} from "./client";
import {
  applyRequestEnvelope,
  commandHelp,
  parseFlags,
  parseInvocation,
  REELCTL_HELP,
  requireExplicitSafetyGuards,
  type ParsedInvocation,
} from "./commands";
import { compactContextResult, formatResult, successResult } from "./output";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonInput(raw: string, source: string): unknown {
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (Buffer.byteLength(content) > MAX_INPUT_BYTES) {
    throw new LiveCliError(`${source} exceeds the 16 MiB input limit`, "args", 2);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new LiveCliError(`${source} must contain valid JSON`, "args", 2);
  }
}

function withInput(invocation: ParsedInvocation): ParsedInvocation {
  if (invocation.file === undefined && !invocation.stdin) return invocation;
  let raw: string;
  try {
    raw = invocation.file === undefined
      ? readFileSync(0, "utf8")
      : readFileSync(path.resolve(invocation.file), "utf8");
  } catch {
    throw new LiveCliError(invocation.file === undefined ? "cannot read JSON from stdin" : `cannot read request file ${path.resolve(invocation.file)}`, "args", 2);
  }
  return applyRequestEnvelope(invocation, parseJsonInput(raw, invocation.file ?? "stdin"));
}

function commandNameFromText(text: string): string {
  const known: Readonly<Record<string, string>> = {
    context: "editor.get_context",
    query: "timeline.query",
    "edit validate": "edit.validate",
    "edit apply": "edit.apply",
    "media import": "media.import",
    "media inspect": "media.inspect",
    "media analyze": "media.analyze_start",
    "preview frame": "preview.render_frame",
    "history get": "history.get",
    "history undo": "history.control",
    "history redo": "history.control",
    "export start": "export.start",
    "job status": "job.status",
    "job wait": "job.status",
    "job cancel": "job.cancel",
  };
  return known[text] ?? text;
}

function printLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function failResult(message: string, code = "TIMEOUT"): FacadeResult<never> {
  return { ok: false, error: { code, message } };
}

function resultExitCode(result: FacadeResult<unknown>): number {
  if (!result.ok) return 3;
  if (isRecord(result.value) && (result.value.state === "error" || result.value.state === "failed" || result.value.state === "cancelled")) return 3;
  return 0;
}

async function readCommandEntry(client: LiveCommandClient, command: string): Promise<CommandCatalogEntry> {
  return client.catalogEntry(command);
}

function entryCanBeIdempotent(entry: CommandCatalogEntry): boolean {
  return entry.retry === "idempotent" && hasSchemaProperty(entry, "idempotencyKey");
}

function requirementItems(result: FacadeResult<unknown>): readonly Record<string, unknown>[] {
  if (!result.ok || !isRecord(result.value)) return [];
  const project = result.value.project;
  if (!isRecord(project) || !isRecord(project.requirements) || !Array.isArray(project.requirements.items)) return [];
  return project.requirements.items.filter(isRecord);
}

function requirementRef(item: Record<string, unknown>): string {
  return typeof item.number === "number" ? `Q${item.number}` : String(item.id ?? "Q?");
}

async function runRequirements(
  client: LiveCommandClient,
  argv: readonly string[],
): Promise<{ readonly result: FacadeResult<unknown>; readonly human: boolean; readonly compact: boolean }> {
  const action = argv[1];
  if (action !== "list" && action !== "get" && action !== "update") {
    throw new LiveCliError("Usage: reelctl requirements list|get|update [Q1]", "args", 2);
  }
  const parsed = parseFlags(argv.slice(2));
  const state = await client.command("project.get_state", {}, { retry: "safe", addIdempotencyKey: false });
  if (!state.ok) return { result: state, human: parsed.human, compact: parsed.compact };
  const items = requirementItems(state);
  const revision = isRecord(state.value) && typeof state.value.revision === "number" ? state.value.revision : 0;
  if (action === "list") {
    const requestedStatus = typeof parsed.flags.status === "string" ? parsed.flags.status : undefined;
    const filtered = items.filter((item) => requestedStatus === undefined || item.status === requestedStatus);
    const summaries = filtered.map((item) => ({
      ref: requirementRef(item),
      title: item.title,
      status: item.status,
      priority: item.priority,
      markerIds: item.markerIds,
      updatedAt: item.updatedAt,
    }));
    return { result: successResult({ revision, requirements: summaries }), human: parsed.human, compact: parsed.compact };
  }
  const ref = parsed.positional[0];
  if (!ref) throw new LiveCliError(`requirements ${action} requires a requirement ref such as Q1`, "args", 2);
  const item = items.find((candidate) => requirementRef(candidate).toLowerCase() === ref.toLowerCase() || candidate.id === ref);
  if (!item) return { result: { ok: false, error: { code: "NOT_FOUND", message: `Requirement ${ref} was not found` } }, human: parsed.human, compact: parsed.compact };
  if (action === "get") return { result: successResult({ revision, requirement: { ...item, ref: requirementRef(item) } }), human: parsed.human, compact: parsed.compact };

  const status = parsed.flags.status;
  const agentNote = parsed.flags.agentNote ?? parsed.flags.note;
  const rawMedia = parsed.flags.resultMediaId;
  const resultMediaIds = rawMedia === undefined ? undefined : (Array.isArray(rawMedia) ? rawMedia : [rawMedia]);
  if (status === undefined && agentNote === undefined && resultMediaIds === undefined) {
    throw new LiveCliError("requirements update needs --status, --agent-note, or --result-media-id", "args", 2);
  }
  const endpointStatus = await client.status();
  const entry = await client.catalogEntry("edit.apply");
  const result = await client.command("edit.apply", {
    ops: [{
      op: "requirement.update",
      requirementId: requirementRef(item),
      ...(status === undefined ? {} : { status }),
      ...(agentNote === undefined ? {} : { agentNote }),
      ...(resultMediaIds === undefined ? {} : { resultMediaIds }),
    }],
    expectedRevision: revision,
  }, {
    retry: entry.retry ?? "never",
    addIdempotencyKey: entryCanBeIdempotent(entry),
    ...(typeof endpointStatus.projectId === "string" ? { expectedProjectId: endpointStatus.projectId } : {}),
    ...(typeof endpointStatus.projectEpoch === "string" ? { expectedProjectEpoch: endpointStatus.projectEpoch } : {}),
  });
  return { result, human: parsed.human, compact: parsed.compact };
}

async function waitForJob(
  client: LiveCommandClient,
  invocation: ParsedInvocation,
  entry: CommandCatalogEntry,
): Promise<FacadeResult<unknown>> {
  const jobId = invocation.arguments.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new LiveCliError("job wait requires a job id", "args", 2);
  }
  const { intervalMs, timeoutMs } = invocation.wait ?? { intervalMs: 500, timeoutMs: 30 * 60 * 1000 };
  const deadline = Date.now() + timeoutMs;
  let last: FacadeResult<unknown> | null = null;
  while (Date.now() < deadline) {
    last = await client.command(entry.name, { jobId }, {
      retry: entry.retry ?? "never",
      addIdempotencyKey: entryCanBeIdempotent(entry),
      ...(invocation.expectedProjectId === undefined ? {} : { expectedProjectId: invocation.expectedProjectId }),
      ...(invocation.expectedProjectEpoch === undefined ? {} : { expectedProjectEpoch: invocation.expectedProjectEpoch }),
    });
    if (!last.ok) return last;
    const value = isRecord(last.value) ? last.value : undefined;
    const state = value?.state;
    if (state === "done" || state === "error" || state === "cancelled") {
      return last;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
  return failResult(`Timed out while waiting for job ${jobId}${last?.ok ? `; last state was ${String(isRecord(last.value) ? last.value.state : "unknown")}` : ""}`);
}

/** A command's own fields parameter wins; otherwise --fields projects output. */
function outputProjection(entry: CommandCatalogEntry, args: Record<string, unknown>, explicit?: readonly string[]): readonly string[] | undefined {
  if (hasSchemaProperty(entry, "fields") || args.fields === undefined) return explicit;
  if (!Array.isArray(args.fields) || !args.fields.every((field) => typeof field === "string")) {
    throw new LiveCliError("--fields requires a comma-separated field list", "args", 2);
  }
  const fields = args.fields as string[];
  delete args.fields;
  return explicit ?? fields;
}

async function runGenericCall(client: LiveCommandClient, argv: readonly string[]): Promise<{
  readonly result: FacadeResult<unknown>;
  readonly format: { readonly human: boolean; readonly compact: boolean; readonly outputFields?: readonly string[]; readonly outputFile?: string };
}> {
  const command = argv[1];
  if (!command) throw new LiveCliError("Usage: reelctl call <command> [--file request.json | --stdin] [--name value]", "args", 2);
  const parsed = parseFlags(argv.slice(2));
  const entry = await readCommandEntry(client, commandNameFromText(command));
  const { expectedProjectId: rawProjectId, expectedProjectEpoch: rawProjectEpoch, ...inputFlags } = parsed.flags;
  let args = { ...inputFlags };
  let expectedProjectId = typeof rawProjectId === "string" ? rawProjectId : undefined;
  let expectedProjectEpoch = typeof rawProjectEpoch === "string" ? rawProjectEpoch : undefined;
  if (parsed.file !== undefined || parsed.stdin) {
    const invocation: ParsedInvocation = {
      commandName: entry.name,
      arguments: args,
      ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
      ...(expectedProjectEpoch === undefined ? {} : { expectedProjectEpoch }),
      stdin: parsed.stdin,
      human: parsed.human,
      compact: parsed.compact,
      ...(parsed.file === undefined ? {} : { file: parsed.file }),
      ...(parsed.outputFile === undefined ? {} : { outputFile: parsed.outputFile }),
      ...(parsed.outputFields === undefined ? {} : { outputFields: parsed.outputFields }),
    };
    const input = withInput(invocation);
    args = input.arguments;
    expectedProjectId = input.expectedProjectId;
    expectedProjectEpoch = input.expectedProjectEpoch;
  }
  const outputFields = outputProjection(entry, args, parsed.outputFields);
  requireExplicitSafetyGuards(entry.name, args, expectedProjectId, expectedProjectEpoch);
  let result = await client.command(entry.name, args, {
    retry: entry.retry ?? "never",
    addIdempotencyKey: entryCanBeIdempotent(entry),
    ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
    ...(expectedProjectEpoch === undefined ? {} : { expectedProjectEpoch }),
  });
  if (entry.name === "editor.get_context" && parsed.compact) result = compactContextResult(result);
  return {
    result,
    format: {
      human: parsed.human,
      compact: parsed.compact,
      ...(outputFields === undefined ? {} : { outputFields }),
      ...(parsed.outputFile === undefined ? {} : { outputFile: parsed.outputFile }),
    },
  };
}

export interface RunOptions {
  readonly client?: LiveCommandClient;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export function cliErrorEnvelope(error: unknown): FacadeResult<never> {
  const message = error instanceof Error ? error.message : "unexpected reelctl error";
  const code = error instanceof LiveCliError
    ? error.kind === "args" ? "INVALID_PARAMS" : error.kind === "business" ? "CONFLICT" : "CONNECTION_FAILED"
    : "CONNECTION_FAILED";
  return { ok: false, error: { code, message } };
}

export async function runReelctl(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const output = options.stdout ?? printLine;
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help" && argv.length === 1) {
    output(REELCTL_HELP);
    return 0;
  }
  const client = options.client ?? new LiveCommandClient();

  if (argv[0] === "mcp") {
    if (argv[1] !== "serve") throw new LiveCliError("Usage: reelctl mcp serve", "args", 2);
    const { serveMcp } = await import("../live-mcp/adapter");
    await serveMcp(client);
    return 0;
  }

  if (argv[0] === "schema" || argv[0] === "help" && argv.length > 1) {
    const text = argv.slice(1).join(" ").trim();
    if (argv[0] === "schema") {
      const catalog = await client.catalog();
      if (!text) {
        output(JSON.stringify({
          ok: true,
          commands: catalog.commands.map(({ name, toolName, description, effects, retry }) => ({ name, toolName, description, effects, retry })),
        }));
        return 0;
      }
      const entry = catalogCommand(catalog, commandNameFromText(text));
      if (!entry) throw new LiveCliError(`Command "${text}" is not available in this ReelTerminal session`, "args", 2);
      output(JSON.stringify({ ok: true, command: entry }));
      return 0;
    }
    const entry = await readCommandEntry(client, commandNameFromText(text));
    output(commandHelp(entry));
    return 0;
  }

  if (argv[0] === "call") {
    const call = await runGenericCall(client, argv);
    output(formatResult(call.result, call.format));
    return resultExitCode(call.result);
  }

  if (argv[0] === "requirements") {
    const call = await runRequirements(client, argv);
    output(formatResult(call.result, { human: call.human, compact: call.compact }));
    return resultExitCode(call.result);
  }

  if (argv[0] === "status") {
    const status = await client.status();
    const { ok: _ok, ...value } = status;
    const result = successResult(value);
    const parsed = parseFlags(argv.slice(1));
    output(formatResult(result, {
      human: parsed.human,
      compact: parsed.compact,
      ...((parsed.outputFields ?? parsed.flags.fields) === undefined ? {} : { outputFields: (parsed.outputFields ?? parsed.flags.fields) as string[] }),
      ...(parsed.outputFile === undefined ? {} : { outputFile: parsed.outputFile }),
    }));
    return 0;
  }

  const invocation = withInput(parseInvocation(argv));
  requireExplicitSafetyGuards(invocation.commandName, invocation.arguments, invocation.expectedProjectId, invocation.expectedProjectEpoch);
  const entry = await readCommandEntry(client, invocation.commandName);
  const outputFields = outputProjection(entry, invocation.arguments, invocation.outputFields);
  let result: FacadeResult<unknown>;
  if (invocation.wait) result = await waitForJob(client, invocation, entry);
  else result = await client.command(entry.name, invocation.arguments, {
    retry: entry.retry ?? "never",
    addIdempotencyKey: entryCanBeIdempotent(entry),
    ...(invocation.expectedProjectId === undefined ? {} : { expectedProjectId: invocation.expectedProjectId }),
    ...(invocation.expectedProjectEpoch === undefined ? {} : { expectedProjectEpoch: invocation.expectedProjectEpoch }),
  });
  if (invocation.commandName === "editor.get_context" && invocation.compact) result = compactContextResult(result);
  output(formatResult(result, {
    human: invocation.human,
    compact: invocation.compact,
    ...(outputFields === undefined ? {} : { outputFields }),
    ...(invocation.outputFile === undefined ? {} : { outputFile: invocation.outputFile }),
  }));
  return resultExitCode(result);
}

async function main(): Promise<void> {
  try {
    const code = await runReelctl(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    const code = error instanceof LiveCliError ? error.exitCode : 4;
    const failure = cliErrorEnvelope(error);
    const message = error instanceof Error ? error.message : "unexpected reelctl error";
    const isMcpStream = process.argv[2] === "mcp" && process.argv[3] === "serve";
    if (!isMcpStream) process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = code;
  }
}

if (require.main === module) void main();
