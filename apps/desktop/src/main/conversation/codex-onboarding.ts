import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readEnvAlias } from "../../shared/env-alias";
import type {
  CodexConversationThreadSummary,
  ConversationSetupCheck,
  ConversationSetupStartArgs,
  ConversationSetupState,
} from "../../shared/conversation-setup";
import {
  ConversationDescriptorError,
  readConversationEndpointDescriptor,
} from "./loopback-connector";

// The production adapter is dependency-free ESM kept beside its conformance
// fixtures. tsup follows this relative import and bundles it into desktop main.
// @ts-expect-error The adapter is intentionally JavaScript and exports its runtime API.
import { startCodexConversationAdapter } from "../../../../../scripts/conversation-adapter/codex-adapter.mjs";
// @ts-expect-error The bounded App Server client is intentionally JavaScript.
import { CodexAppServerClient } from "../../../../../scripts/conversation-adapter/codex-app-server-client.mjs";

type ManagedAdapter = Awaited<ReturnType<typeof startCodexConversationAdapter>>;

interface AppServerClient {
  start(): Promise<unknown>;
  readAccount(): Promise<unknown>;
  listThreads(params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodexOnboardingDeps {
  readonly descriptorFilePath: string;
  readonly visualStateRoot: string;
  readonly liveMcpConnector: string;
  readonly newThreadCwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Executable discovery platform; defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  readonly accessFile?: (candidate: string, mode?: number) => Promise<void>;
  readonly createClient?: (options: {
    command: string;
    argsPrefix?: readonly string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => AppServerClient;
  readonly startAdapter?: (options: Record<string, unknown>) => Promise<ManagedAdapter>;
  readonly inspectExternalAdapter?: (filePath: string) => Promise<unknown>;
  readonly ensureDirectory?: (directory: string) => Promise<void>;
}

export interface CodexOnboardingHost {
  inspect(): Promise<ConversationSetupState>;
  start(args: ConversationSetupStartArgs): Promise<ConversationSetupState>;
  dispose(): Promise<void>;
}

const ready = (code: string): ConversationSetupCheck => ({ state: "ready", code });
const missing = (code: string): ConversationSetupCheck => ({ state: "missing", code });
const failed = (code: string): ConversationSetupCheck => ({ state: "error", code });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, max) : null;
}

function threadStatusActive(value: unknown): boolean {
  if (typeof value === "string") return value === "active";
  return isRecord(value) && value.type === "active";
}

export function summarizeCodexThreads(value: unknown): CodexConversationThreadSummary[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  return data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length > 512) return [];
    const name = bounded(item.name, 120);
    const preview = bounded(item.preview, 180);
    const timestamp =
      typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
          ? item.createdAt
          : null;
    return [{
      id: item.id,
      title: name ?? preview ?? "Codex conversation",
      preview: preview && preview !== name ? preview : null,
      updatedAt: timestamp,
      active: threadStatusActive(item.status),
    }];
  });
}

function accountIsReady(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.account)) return true;
  return value.account === null && value.requiresOpenaiAuth === false;
}

interface ResolvedCodexCommand {
  readonly command: string;
  /**
   * Arguments ahead of the `app-server` subcommand. Set when discovery
   * resolved a Windows .cmd shim to its real Node CLI entry, for example
   * `node <npm-global>/node_modules/@openai/codex/bin/codex.js`.
   */
  readonly argsPrefix?: readonly string[];
}

function executableCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const windows = platform === "win32";
  const explicit = readEnvAlias(env, "REELTERMINAL_CODEX_COMMAND", "OPENREEL_CODEX_COMMAND");
  const candidates = [
    explicit,
    // Windows ships both a winget codex.exe and npm-global codex.cmd shims;
    // accept each PATH directory's executable forms before falling back.
    ...(env.PATH ?? "").split(path.delimiter).flatMap((entry) =>
      entry
        ? windows
          ? [path.join(entry, "codex.exe"), path.join(entry, "codex.cmd")]
          : [path.join(entry, "codex")]
        : [],
    ),
    ...(windows && env.APPDATA
      ? [path.join(env.APPDATA, "npm", "codex.exe"), path.join(env.APPDATA, "npm", "codex.cmd")]
      : []),
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".volta", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

// Node >= 18.20 / >= 20.12 refuses to spawn .cmd/.bat files without a shell
// (EINVAL; older 18.x/20.x patch lines did not), and a shell would re-parse
// the App Server's JSON `-c` arguments. npm global shims all execute
// `<dir>/node_modules/@openai/codex/bin/codex.js`, so resolve that
// target and launch it with Node directly instead of through the shim.
async function resolveNpmCmdShim(
  shimPath: string,
  accessFile: (candidate: string, mode?: number) => Promise<void>,
): Promise<ResolvedCodexCommand | null> {
  const shimDir = path.dirname(shimPath);
  const cliEntry = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    await accessFile(cliEntry, fsConstants.R_OK);
  } catch {
    return null;
  }
  let nodeCommand = "node";
  try {
    const localNode = path.join(shimDir, "node.exe");
    await accessFile(localNode, fsConstants.X_OK);
    nodeCommand = localNode;
  } catch {
    // Fall back to `node` resolved through PATH.
  }
  return { command: nodeCommand, argsPrefix: [cliEntry] };
}

async function resolveCodexCommand(
  env: NodeJS.ProcessEnv,
  accessFile: (candidate: string, mode?: number) => Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedCodexCommand | null> {
  for (const candidate of executableCandidates(env, platform)) {
    // A bare explicit command is useful for hermetic tests and PATH-based
    // managed deployments. Other candidates are verified before spawning.
    if (
      candidate === readEnvAlias(env, "REELTERMINAL_CODEX_COMMAND", "OPENREEL_CODEX_COMMAND") &&
      !path.isAbsolute(candidate)
    ) {
      return { command: candidate };
    }
    try {
      await accessFile(candidate, fsConstants.X_OK);
    } catch {
      // Keep looking through the bounded candidate list.
      continue;
    }
    if (platform === "win32" && candidate.toLowerCase().endsWith(".cmd")) {
      const resolvedShim = await resolveNpmCmdShim(candidate, accessFile);
      if (resolvedShim) return resolvedShim;
      continue;
    }
    return { command: candidate };
  }
  return null;
}

/**
 * Map an App Server client failure to a setup check. Discovery failure stays
 * "codex-missing"; everything the client reports splits into launch failures
 * (spawn error, nonzero exit, handshake timeout) and protocol errors
 * (handshake/response shape, plus the CLOSED transport failures the launch
 * codes do not cover, including a drop in the initialize→initialized gap),
 * so the UI can tell "not installed" apart from "installed but cannot
 * start" and "started but incompatible".
 */
function codexFailureFrom(error: unknown): ConversationSetupCheck {
  if (error instanceof Error && error.name === "CodexAppServerError") {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    const launchFailure =
      code === "SPAWN_FAILED" || code === "PROCESS_EXIT" || code === "REQUEST_TIMEOUT";
    return {
      state: "error",
      code: launchFailure ? "codex-launch-failed" : "codex-protocol-error",
      ...(typeof detail === "string" && detail ? { detail } : {}),
    };
  }
  return failed("codex-unavailable");
}

function externalCheckFrom(error?: unknown): ConversationSetupCheck {
  if (!error) return ready("adapter-ready");
  if (
    error instanceof ConversationDescriptorError &&
    error.message === "No external Agent adapter is configured"
  ) {
    return missing("adapter-missing");
  }
  return failed("adapter-invalid");
}

export function createCodexOnboardingHost(deps: CodexOnboardingDeps): CodexOnboardingHost {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const accessFile = deps.accessFile ?? access;
  const inspectExternalAdapter =
    deps.inspectExternalAdapter ?? readConversationEndpointDescriptor;
  const createClient =
    deps.createClient ??
    ((options) =>
      new CodexAppServerClient({
        command: options.command,
        ...(options.argsPrefix?.length
          ? { commandArgs: [...options.argsPrefix, "app-server"] }
          : {}),
        cwd: options.cwd,
        env: options.env,
      }) as AppServerClient);
  const startAdapter = deps.startAdapter ?? startCodexConversationAdapter;
  const ensureDirectory = deps.ensureDirectory ?? ((directory: string) =>
    mkdir(directory, { recursive: true, mode: 0o700 }).then(() => undefined));
  let adapter: ManagedAdapter | null = null;
  let operation: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operation.then(work, work);
    operation = next.then(() => undefined, () => undefined);
    return next;
  };

  const inspectUnlocked = async (): Promise<ConversationSetupState> => {
    let externalAdapter: ConversationSetupCheck;
    try {
      await inspectExternalAdapter(deps.descriptorFilePath);
      externalAdapter = ready("adapter-ready");
    } catch (error) {
      externalAdapter = externalCheckFrom(error);
    }

    let liveConnector: ConversationSetupCheck;
    try {
      await accessFile(deps.liveMcpConnector, fsConstants.R_OK);
      liveConnector = ready("connector-ready");
    } catch {
      liveConnector = missing("connector-missing");
    }

    const command = await resolveCodexCommand(env, accessFile, platform);
    if (!command) {
      return {
        codex: missing("codex-missing"),
        authentication: missing("auth-unknown"),
        liveConnector,
        externalAdapter,
        threads: [],
        managedSessionId: adapter?.threadId ?? null,
      };
    }

    const client = createClient({
      command: command.command,
      ...(command.argsPrefix ? { argsPrefix: command.argsPrefix } : {}),
      env,
    });
    try {
      await client.start();
      const [account, threads] = await Promise.all([
        client.readAccount(),
        client.listThreads({
          limit: 30,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["cli", "vscode", "appServer"],
        }),
      ]);
      return {
        codex: ready("codex-ready"),
        authentication: accountIsReady(account)
          ? ready("auth-ready")
          : missing("auth-required"),
        liveConnector,
        externalAdapter,
        threads: summarizeCodexThreads(threads),
        managedSessionId: adapter?.threadId ?? null,
      };
    } catch (error) {
      return {
        codex: codexFailureFrom(error),
        authentication: missing("auth-unknown"),
        liveConnector,
        externalAdapter,
        threads: [],
        managedSessionId: adapter?.threadId ?? null,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  return {
    inspect: () => enqueue(inspectUnlocked),
    start: (args) => enqueue(async () => {
      if (args.provider === "external") return inspectUnlocked();
      if ((args.createThread === true) === Boolean(args.threadId)) {
        throw new Error("Choose one existing Codex conversation or create a new one");
      }
      const command = await resolveCodexCommand(env, accessFile, platform);
      if (!command) throw new Error("CODEX_MISSING");
      await accessFile(deps.liveMcpConnector, fsConstants.R_OK).catch(() => {
        throw new Error("LIVE_CONNECTOR_MISSING");
      });

      if (args.createThread) await ensureDirectory(deps.newThreadCwd);
      const previous = adapter;
      const started = await startAdapter({
        codexCommand: command.command,
        ...(command.argsPrefix ? { codexArgsPrefix: [...command.argsPrefix] } : {}),
        descriptorPath: deps.descriptorFilePath,
        liveMcpConnector: deps.liveMcpConnector,
        visualStateRoot: deps.visualStateRoot,
        liveMcpCommand: process.execPath,
        liveMcpElectronRunAsNode: Boolean(process.versions.electron),
        env,
        ...(args.createThread
          ? { createThread: true, cwd: deps.newThreadCwd }
          : { threadId: args.threadId }),
      });
      adapter = started;
      // The new adapter atomically owns the descriptor before this point.
      // Closing the previous adapter is ownership-checked and cannot remove it.
      await previous?.close().catch(() => undefined);
      return inspectUnlocked();
    }),
    dispose: () => enqueue(async () => {
      const current = adapter;
      adapter = null;
      await current?.close().catch(() => undefined);
    }),
  };
}
