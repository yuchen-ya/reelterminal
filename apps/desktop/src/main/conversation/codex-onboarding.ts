import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  readonly accessFile?: (candidate: string, mode?: number) => Promise<void>;
  readonly createClient?: (options: {
    command: string;
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

function executableCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.OPENREEL_CODEX_COMMAND;
  const candidates = [
    explicit,
    ...(env.PATH ?? "").split(path.delimiter).map((entry) =>
      entry ? path.join(entry, process.platform === "win32" ? "codex.exe" : "codex") : "",
    ),
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".volta", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

async function resolveCodexCommand(
  env: NodeJS.ProcessEnv,
  accessFile: (candidate: string, mode?: number) => Promise<void>,
): Promise<string | null> {
  for (const candidate of executableCandidates(env)) {
    // A bare explicit command is useful for hermetic tests and PATH-based
    // managed deployments. Other candidates are verified before spawning.
    if (candidate === env.OPENREEL_CODEX_COMMAND && !path.isAbsolute(candidate)) {
      return candidate;
    }
    try {
      await accessFile(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking through the bounded candidate list.
    }
  }
  return null;
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
  const accessFile = deps.accessFile ?? access;
  const inspectExternalAdapter =
    deps.inspectExternalAdapter ?? readConversationEndpointDescriptor;
  const createClient =
    deps.createClient ??
    ((options) => new CodexAppServerClient(options) as AppServerClient);
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

    const command = await resolveCodexCommand(env, accessFile);
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

    const client = createClient({ command, env });
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
    } catch {
      return {
        codex: failed("codex-unavailable"),
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
      const command = await resolveCodexCommand(env, accessFile);
      if (!command) throw new Error("CODEX_MISSING");
      await accessFile(deps.liveMcpConnector, fsConstants.R_OK).catch(() => {
        throw new Error("LIVE_CONNECTOR_MISSING");
      });

      if (args.createThread) await ensureDirectory(deps.newThreadCwd);
      const previous = adapter;
      const started = await startAdapter({
        codexCommand: command,
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
