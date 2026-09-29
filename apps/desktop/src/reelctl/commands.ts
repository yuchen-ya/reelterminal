import { LiveCliError, type CommandCatalogEntry } from "./client";

export interface ParsedInvocation {
  readonly commandName: string;
  readonly entryName?: string;
  readonly arguments: Record<string, unknown>;
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
  readonly outputFields?: readonly string[];
  readonly file?: string;
  readonly stdin: boolean;
  readonly human: boolean;
  readonly compact: boolean;
  readonly outputFile?: string;
  readonly wait?: { readonly intervalMs: number; readonly timeoutMs: number };
}

const ALIASES: Readonly<Record<string, string>> = {
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

function fail(message: string): never {
  throw new LiveCliError(message, "args", 2);
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function flagValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed) as unknown; } catch { /* keep as a string */ }
  }
  return trimmed;
}

function pushFlag(target: Record<string, unknown>, key: string, value: unknown): void {
  const current = target[key];
  if (current === undefined) target[key] = value;
  else if (Array.isArray(current)) target[key] = [...current, value];
  else target[key] = [current, value];
}

export interface RawArgs {
  readonly positional: readonly string[];
  readonly flags: Record<string, unknown>;
  readonly file?: string;
  readonly stdin: boolean;
  readonly human: boolean;
  readonly compact: boolean;
  readonly outputFile?: string;
  readonly outputFields?: readonly string[];
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export function parseFlags(tokens: readonly string[]): RawArgs {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  let file: string | undefined;
  let outputFile: string | undefined;
  let stdin = false;
  let human = false;
  let compact = false;
  let outputFields: string[] | undefined;
  let intervalMs: number | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equalsAt = token.indexOf("=");
    const rawName = token.slice(2, equalsAt < 0 ? undefined : equalsAt);
    const inlineValue = equalsAt < 0 ? undefined : token.slice(equalsAt + 1);
    const normalized = kebabToCamel(rawName);
    let value: unknown = true;
    if (inlineValue !== undefined) value = flagValue(inlineValue);
    else if (tokens[index + 1] !== undefined && !tokens[index + 1]!.startsWith("--")) {
      value = flagValue(tokens[index + 1]!);
      index += 1;
    }

    switch (rawName) {
      case "file":
        if (typeof value !== "string") fail("--file needs a path");
        file = value;
        break;
      case "stdin":
        stdin = true;
        break;
      case "human":
        human = true;
        break;
      case "compact":
        compact = true;
        break;
      case "output-file":
        if (typeof value !== "string") fail("--output-file needs a path");
        outputFile = value;
        break;
      case "result-fields":
        if (typeof value !== "string") fail("--result-fields needs a comma-separated list");
        outputFields = value.split(",").map((field) => field.trim()).filter(Boolean);
        break;
      case "interval-ms":
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail("--interval-ms must be a positive number");
        intervalMs = value;
        break;
      case "timeout-ms":
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail("--timeout-ms must be a positive number");
        timeoutMs = value;
        break;
      case "project-id":
      case "expected-project-id":
        if (typeof value !== "string") fail(`--${rawName} needs a string`);
        flags.expectedProjectId = value;
        break;
      case "project-epoch":
      case "expected-project-epoch":
        if (typeof value !== "string") fail(`--${rawName} needs a string`);
        flags.expectedProjectEpoch = value;
        break;
      case "expected-revision":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail("--expected-revision must be a non-negative integer");
        flags.expectedRevision = value;
        break;
      case "idempotency-key":
        if (typeof value !== "string" || value.length === 0) fail("--idempotency-key needs a non-empty string");
        flags.idempotencyKey = value;
        break;
      case "fields":
        if (typeof value !== "string") fail("--fields needs a comma-separated list");
        pushFlag(flags, normalized, value.split(",").map((field) => field.trim()).filter(Boolean));
        break;
      default:
        pushFlag(flags, normalized, value);
    }
  }

  if (file !== undefined && stdin) fail("choose either --file or --stdin");
  return {
    positional,
    flags,
    ...(file === undefined ? {} : { file }),
    stdin,
    human,
    compact,
    ...(outputFile === undefined ? {} : { outputFile }),
    ...(outputFields === undefined ? {} : { outputFields }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function commandFromWords(words: readonly string[]): { readonly commandName: string; readonly consumed: number } {
  if (words.length === 0) fail("Missing command. Use `reelctl help` for usage.");
  for (let length = Math.min(2, words.length); length >= 1; length -= 1) {
    const joined = words.slice(0, length).join(" ");
    const commandName = ALIASES[joined];
    if (commandName !== undefined) return { commandName, consumed: length };
  }
  fail(`Unknown command "${words.join(" ")}". Use reelctl help for usage.`);
}

function normalizeArgs(commandName: string, raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };
  if (commandName === "timeline.query") {
    if (result.ref !== undefined) {
      const refs = Array.isArray(result.ref) ? result.ref : [result.ref];
      result.refs = refs.flatMap((value) => typeof value === "string" ? value.split(",").filter(Boolean) : [value]);
      delete result.ref;
    }
  }
  if (commandName === "preview.render_frame" && result.time !== undefined && result.timeSec === undefined) {
    result.timeSec = result.time;
    delete result.time;
  }
  return result;
}

export function parseInvocation(tokens: readonly string[]): ParsedInvocation {
  const { commandName, consumed } = commandFromWords(tokens);
  const parsed = parseFlags(tokens.slice(consumed));
  const args = normalizeArgs(commandName, parsed.flags);
  // These preconditions belong to the transport envelope, not the command's
  // closed argument schema. Keep them on parsed.flags for the envelope below.
  delete args.expectedProjectId;
  delete args.expectedProjectEpoch;
  if ((commandName === "media.import" || commandName === "media.inspect") && parsed.positional.length > 0) {
    if (commandName === "media.import" && args.path === undefined) args.path = parsed.positional[0];
    else if (commandName === "media.inspect" && args.mediaId === undefined) args.mediaId = parsed.positional[0];
    if (parsed.positional.length > 1) fail("Unexpected positional arguments");
  } else if ((commandName === "job.status" || commandName === "job.cancel") && parsed.positional.length > 0) {
    if (args.jobId === undefined) args.jobId = parsed.positional[0];
    if (parsed.positional.length > 1) fail("Unexpected positional arguments");
  } else if (parsed.positional.length > 0) {
    fail(`Unexpected positional argument "${parsed.positional[0]}"; use --name value flags or --file`);
  }

  if (commandName === "history.control") {
    const action = tokens[1];
    if (action !== "undo" && action !== "redo") fail("Use `reelctl history undo` or `reelctl history redo`");
    args.action = action;
  }
  if (commandName === "job.status" && tokens[1] === "wait") {
    const { intervalMs = 500, timeoutMs = 30 * 60 * 1000 } = parsed;
    return {
      commandName,
      arguments: { ...args, ...(parsed.positional[0] ? { jobId: parsed.positional[0] } : {}) },
      ...(typeof parsed.flags.expectedProjectId === "string" ? { expectedProjectId: parsed.flags.expectedProjectId } : {}),
      ...(typeof parsed.flags.expectedProjectEpoch === "string" ? { expectedProjectEpoch: parsed.flags.expectedProjectEpoch } : {}),
      ...(parsed.outputFields === undefined ? {} : { outputFields: parsed.outputFields }),
      ...(parsed.file === undefined ? {} : { file: parsed.file }),
      stdin: parsed.stdin,
      human: parsed.human,
      compact: parsed.compact,
      ...(parsed.outputFile === undefined ? {} : { outputFile: parsed.outputFile }),
      wait: { intervalMs, timeoutMs },
    };
  }

  return {
    commandName,
    arguments: args,
    ...(typeof parsed.flags.expectedProjectId === "string" ? { expectedProjectId: parsed.flags.expectedProjectId } : {}),
    ...(typeof parsed.flags.expectedProjectEpoch === "string" ? { expectedProjectEpoch: parsed.flags.expectedProjectEpoch } : {}),
    ...(parsed.outputFields === undefined ? {} : { outputFields: parsed.outputFields }),
    ...(parsed.file === undefined ? {} : { file: parsed.file }),
    stdin: parsed.stdin,
    human: parsed.human,
    compact: parsed.compact,
    ...(parsed.outputFile === undefined ? {} : { outputFile: parsed.outputFile }),
  };
}

export function applyRequestEnvelope(
  invocation: ParsedInvocation,
  payload: unknown,
): ParsedInvocation {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new LiveCliError("request JSON must be an object", "args", 2);
  }
  const record = payload as Record<string, unknown>;
  const envelopeArgs = record.arguments;
  if (record.command !== undefined && (record.command !== invocation.commandName || envelopeArgs === undefined)) {
    throw new LiveCliError("request envelope command must match the selected CLI command and include arguments", "args", 2);
  }
  if (envelopeArgs !== undefined && (!envelopeArgs || typeof envelopeArgs !== "object" || Array.isArray(envelopeArgs))) {
    throw new LiveCliError("request arguments must be an object", "args", 2);
  }
  const sourceArgs = (envelopeArgs as Record<string, unknown> | undefined) ?? record;
  const { expectedProjectId, expectedProjectEpoch, ...commandArgs } = envelopeArgs === undefined
    ? record
    : (sourceArgs as Record<string, unknown>);
  const fileProjectId = typeof record.expectedProjectId === "string" ? record.expectedProjectId : undefined;
  const fileProjectEpoch = typeof record.expectedProjectEpoch === "string" ? record.expectedProjectEpoch : undefined;
  return {
    ...invocation,
    arguments: { ...commandArgs, ...invocation.arguments },
    ...(invocation.expectedProjectId !== undefined
      ? {}
      : typeof expectedProjectId === "string" ? { expectedProjectId } : fileProjectId === undefined ? {} : { expectedProjectId: fileProjectId }),
    ...(invocation.expectedProjectEpoch !== undefined
      ? {}
      : typeof expectedProjectEpoch === "string" ? { expectedProjectEpoch } : fileProjectEpoch === undefined ? {} : { expectedProjectEpoch: fileProjectEpoch }),
  };
}

export function requireExplicitSafetyGuards(
  commandName: string,
  args: Record<string, unknown>,
  expectedProjectId: string | undefined,
  expectedProjectEpoch: string | undefined,
): void {
  if ((commandName === "edit.apply" || commandName === "history.control") && (!Number.isInteger(args.expectedRevision) || (args.expectedRevision as number) < 0)) {
    throw new LiveCliError(`${commandName} requires expectedRevision in the request or --expected-revision`, "args", 2);
  }
  if ((commandName === "edit.apply" || commandName === "history.control") && (expectedProjectId === undefined || expectedProjectEpoch === undefined)) {
    throw new LiveCliError(
      `${commandName} requires expectedProjectId and expectedProjectEpoch from reelctl context; pass --project-id and --project-epoch or include both in the request file envelope`,
      "args",
      2,
    );
  }
}

export function commandHelp(entry: CommandCatalogEntry): string {
  return [
    `${entry.name} (${entry.toolName})`,
    "",
    entry.description,
    "",
    "Input schema:",
    JSON.stringify(entry.inputSchema, null, 2),
  ].join("\n");
}

export const REELCTL_HELP = `reelctl — operate the project already open in ReelTerminal

Usage:
  reelctl status
  reelctl context [--compact]
  reelctl query --ref R3 --fields id,startTime,duration
  reelctl edit validate --file request.json
  reelctl edit apply --file request.json
  reelctl media import --file request.json
  reelctl media inspect --media-id m1 --start-sec 0 --end-sec 8
  reelctl media analyze --media-id m1 --type audioSummary
  reelctl preview frame --time 12.5
  reelctl history get | undo | redo
  reelctl export start --file request.json
  reelctl job status --job-id <id> | wait <id> [--timeout-ms 1800000] | cancel --job-id <id>
  reelctl schema <command>
  reelctl call <command> [--file request.json | --stdin] [--name value ...]
  reelctl mcp serve

Complex requests use JSON files or stdin. For edits, include expectedRevision and
copy identity.projectId and identity.projectEpoch from reelctl context into the
request envelope or pass --project-id / --project-epoch. reelctl call keeps
all catalog commands available even before a dedicated shortcut exists.
Use reelctl schema <command> or reelctl help <command> for exact arguments.

Output is one compact JSON result on stdout. --human pretty-prints it. On context,
--compact returns a concise context while preserving identity, canvasPoint and
revision fields. --result-fields projects result paths while retaining revision,
identity and pagination metadata; --output-file writes the complete response.
Diagnostics go to stderr. Exit codes: 0 success, 2
invocation error, 3 command/business failure, 4 connection/API failure.
`;

export function isKnownAlias(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALIASES, command);
}
