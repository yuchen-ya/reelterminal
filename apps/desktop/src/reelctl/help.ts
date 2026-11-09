import {
  describeCommand,
  getCapabilityTools,
  listCapabilities,
  listCapabilityDomains,
} from "@reelterminal/agent-facade/capability-registry";
import { LiveCliError } from "./client";
import {
  COMMAND_ALIASES,
  commandHelp,
  REELCTL_HELP,
  resolveCommandName,
} from "./commands";

const TOOLS_USAGE = "Usage: reelctl tools [video|review|library|system|<package.id>]";
const CALL_USAGE = "Usage: reelctl call <command> [--file request.json | --stdin] [--name value]";
const ENVIRONMENT_USAGE = "Usage: reelctl environment get|set --file config.json|check|test --file speech.wav --duration 5";

function isHelpFlag(token: string): boolean {
  return token === "--help" || token === "-h";
}

function unknownCommand(tokens: readonly string[]): never {
  const example = Object.keys(COMMAND_ALIASES)[0];
  const discovery = example === undefined
    ? "Use reelctl tools to discover available commands."
    : `Use reelctl tools to discover commands or reelctl help ${example} for command help.`;
  const optionIndex = tokens.findIndex(token => token.startsWith("-"));
  const commandPath = optionIndex < 0 ? tokens : tokens.slice(0, optionIndex);
  const displayPath = commandPath.length > 0 ? commandPath : tokens.slice(0, 1);
  throw new LiveCliError(`Unknown command path "${displayPath.join(" ")}". ${discovery}`, "args", 2);
}

function facadeCommandHelp(command: string, tokens: readonly string[]): string {
  try {
    return commandHelp(describeCommand(resolveCommandName(command)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown command:")) return unknownCommand(tokens);
    throw error;
  }
}

function capabilityValue(name?: string): unknown {
  return name === undefined ? { domains: listCapabilityDomains() }
    : name.includes(".") ? getCapabilityTools(name)
      : { domain: name, capabilities: listCapabilities({ domain: name }).map(({ id, purpose, targets, activation }) => ({ id, purpose, targets, activation })) };
}

function toolsHelp(tokens: readonly string[], exact: boolean): string {
  if (exact && tokens.length > 2 || tokens.length > 2 && !tokens[2]!.startsWith("-")) return unknownCommand(tokens);
  let value: unknown;
  try {
    value = capabilityValue(tokens[1]);
  } catch {
    return unknownCommand(tokens);
  }
  return [TOOLS_USAGE, "", JSON.stringify({ ok: true, value }, null, 2)].join("\n");
}

function environmentHelp(tokens: readonly string[]): string {
  const capability = getCapabilityTools("system.environment").capability;
  const localTools = capability.localTools ?? [];
  const action = tokens[1];
  if (action !== undefined && !localTools.some(tool => tool.split(/\s+/)[1] === action)) return unknownCommand(tokens);
  return [
    ENVIRONMENT_USAGE,
    "",
    capability.purpose,
    ...localTools.map(tool => `  reelctl ${tool}`),
  ].join("\n");
}

function directCommand(tokens: readonly string[]): { readonly name: string; readonly consumed: number } | undefined {
  for (let length = Math.min(3, tokens.length); length >= 1; length -= 1) {
    const joined = tokens.slice(0, length).join(" ");
    if (Object.hasOwn(COMMAND_ALIASES, joined)) return { name: COMMAND_ALIASES[joined]!, consumed: length };
  }
  if (tokens.length === 1) return { name: tokens[0]!, consumed: 1 };
  return undefined;
}

function scopedHelp(tokens: readonly string[], exact: boolean): string | undefined {
  const kind = tokens[0];
  if (kind !== "review" && kind !== "video") return undefined;
  const action = tokens[1];
  if (action === undefined) return `Usage: reelctl ${kind} capabilities|describe|call <command>`;
  if (action === "capabilities" || action === "describe") {
    if (exact && tokens.length > 2) return unknownCommand(tokens);
    return facadeCommandHelp(action === "capabilities" ? "capabilities.get" : "session.describe", tokens);
  }
  if (action !== "call") return undefined;
  const verb = tokens[2];
  if (verb === undefined) return `Usage: reelctl ${kind} call <command> [--file request.json | --stdin]`;
  if (exact && tokens.length > 3) return unknownCommand(tokens);
  if (verb === "capabilities.get" || verb === "session.describe") return facadeCommandHelp(verb, tokens.slice(0, 3));
  if (kind === "review" ? !verb.startsWith("review.") : verb.startsWith("review.")) {
    throw new LiveCliError("The call verb must belong to the explicit workspace kind. Use reelctl tools to discover scoped commands.", "args", 2);
  }
  return facadeCommandHelp(verb, tokens.slice(0, 3));
}

function helpForTokens(tokens: readonly string[], exact: boolean): string {
  const scoped = scopedHelp(tokens, exact);
  if (scoped !== undefined) return scoped;
  switch (tokens[0]) {
    case "tools": return toolsHelp(tokens, exact);
    case "start":
      if (tokens[1] !== undefined && !tokens[1].startsWith("-")) return unknownCommand(tokens);
      return "Usage: reelctl start --target <ref copied from the GUI>";
    case "status":
      if (tokens[1] !== undefined && !tokens[1].startsWith("-")) return unknownCommand(tokens);
      return "Usage: reelctl status [--human] [--compact] [--result-fields field,...] [--output-file result.json]";
    case "environment": return environmentHelp(tokens);
    case "schema": return "Usage: reelctl schema [command|--domain <prefix>] (the schema query itself uses the live catalog)";
    case "describe": return "Usage: reelctl describe <canonical.verb> [--op <name> ...] [--detail full]";
    case "requirements": return "Usage: reelctl requirements list|get|update [Q1]";
    case "call": {
      if (tokens[1] === undefined) return CALL_USAGE;
      if (exact && tokens.length > 2) return unknownCommand(tokens);
      return facadeCommandHelp(tokens[1], tokens.slice(0, 2));
    }
  }
  const command = directCommand(tokens);
  if (command === undefined || exact && command.consumed !== tokens.length) return unknownCommand(tokens);
  return facadeCommandHelp(command.name, tokens.slice(0, command.consumed));
}

const BOOLEAN_LONG_FLAGS = new Set(["--stdin", "--human", "--compact"]);

function helpFlagIndexes(argv: readonly string[]): ReadonlySet<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (isHelpFlag(token)) {
      indexes.add(index);
      continue;
    }
    if (!token.startsWith("--") || token.includes("=") || BOOLEAN_LONG_FLAGS.has(token)) continue;
    const next = argv[index + 1];
    // Match parseFlags' separate-value grammar: a single-dash value such as
    // `-h` belongs to the preceding long flag and is not a help option.
    if (next !== undefined && !next.startsWith("--")) index += 1;
  }
  return indexes;
}

/** Resolve command help entirely from static contracts, before any business parsing or I/O. */
export function offlineHelp(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return REELCTL_HELP;
  if (argv[0] === "help") {
    const tokens = argv.slice(1).filter(token => !isHelpFlag(token));
    return tokens.length === 0 ? REELCTL_HELP : helpForTokens(tokens, true);
  }
  if (argv[0] !== undefined && isHelpFlag(argv[0])) return REELCTL_HELP;
  const helpIndexes = helpFlagIndexes(argv);
  if (helpIndexes.size === 0) return undefined;
  const tokens = argv.filter((_, index) => !helpIndexes.has(index));
  return tokens.length === 0 ? REELCTL_HELP : helpForTokens(tokens, false);
}
