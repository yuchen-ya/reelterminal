/**
 * Process configuration.
 *
 * Flags beat env; no config files. Roots must be ABSOLUTE (Decision 6):
 * at startup each root must exist, be a directory, and is canonicalized to
 * its `realpath` form. A relative, missing, or non-directory root is a
 * STARTUP REFUSAL (exit 2), never a cwd-relative resolution and never a
 * `~` expansion. Zero roots of a class is honest and allowed — the
 * corresponding verbs then fail UNSUPPORTED at the facade.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { logError, type LogLevel } from "./log";

export const CONFIG_DEFAULTS = {
  mediaRootsEnv: "REELTERMINAL_AVE_MEDIA_ROOTS",
  artifactRootEnv: "REELTERMINAL_AVE_ARTIFACT_ROOT",
  projectRootsEnv: "REELTERMINAL_AVE_PROJECT_ROOTS",
  deliveryRootsEnv: "REELTERMINAL_AVE_DELIVERY_ROOTS",
  logLevelEnv: "REELTERMINAL_TRANSPORT_LOG",
} as const;

/** Roots as parsed from flags/env, before validation + canonicalization. */
export interface RawRoots {
  readonly mediaRoots: readonly string[];
  readonly artifactRoot?: string;
  readonly projectRoots: readonly string[];
  readonly deliveryRoots: readonly string[];
}

export interface TransportConfig {
  readonly mediaRoots: readonly string[];
  readonly artifactRoot?: string;
  readonly projectRoots: readonly string[];
  readonly deliveryRoots: readonly string[];
  readonly logLevel: LogLevel;
}

/** A startup refusal: printed as one stderr JSON log, exit 2. */
export class ConfigRefusal extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConfigRefusal";
    this.details = details;
  }
}

interface ParsedArgv {
  readonly roots: RawRoots;
  readonly logLevel?: LogLevel;
  readonly workflowPath?: string;
  readonly keepGoing: boolean;
}

/**
 * The commands need no
 * framework. Repeatable: --media-root, --project-root. Single: --artifact-root,
 * --log-level, --workflow. Boolean: --keep-going.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const mediaRoots: string[] = [];
  const projectRoots: string[] = [];
  const deliveryRoots: string[] = [];
  let artifactRoot: string | undefined;
  let logLevel: LogLevel | undefined;
  let workflowPath: string | undefined;
  let keepGoing = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      if (i >= argv.length) {
        throw new ConfigRefusal(`flag ${arg} requires a value`);
      }
      return argv[i];
    };
    switch (arg) {
      case "--media-root":
        mediaRoots.push(value());
        break;
      case "--project-root":
        projectRoots.push(value());
        break;
      case "--delivery-root":
        deliveryRoots.push(value());
        break;
      case "--artifact-root": {
        const v = value();
        if (artifactRoot !== undefined) {
          throw new ConfigRefusal(
            "--artifact-root given more than once (it accepts exactly one root)",
            { first: artifactRoot, second: v },
          );
        }
        artifactRoot = v;
        break;
      }
      case "--log-level": {
        const v = value();
        if (v !== "error" && v !== "info" && v !== "debug") {
          throw new ConfigRefusal(
            `--log-level must be error|info|debug (got "${v}")`,
          );
        }
        if (logLevel !== undefined) {
          throw new ConfigRefusal("--log-level given more than once");
        }
        logLevel = v;
        break;
      }
      case "--workflow": {
        const v = value();
        if (workflowPath !== undefined) {
          throw new ConfigRefusal("--workflow given more than once");
        }
        workflowPath = v;
        break;
      }
      case "--keep-going":
        keepGoing = true;
        break;
      default:
        throw new ConfigRefusal(`unknown argument "${arg}"`);
    }
  }
  return {
    roots: {
      mediaRoots,
      ...(artifactRoot !== undefined ? { artifactRoot } : {}),
      projectRoots,
      deliveryRoots,
    },
    ...(logLevel !== undefined ? { logLevel } : {}),
    ...(workflowPath !== undefined ? { workflowPath } : {}),
    keepGoing,
  };
}

function splitEnvList(raw: string, envName: string): string[] {
  const parts = raw.split(path.delimiter);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      throw new ConfigRefusal(
        `${envName} contains an empty segment (check for stray "${path.delimiter}" separators)`,
        { env: envName, value: raw },
      );
    }
    out.push(part);
  }
  return out;
}

/** Flags beat env (B.5): env fills only the classes flags left empty. */
export function mergeEnvRoots(
  roots: RawRoots,
  env: NodeJS.ProcessEnv = process.env,
): RawRoots {
  const mediaRoots =
    roots.mediaRoots.length > 0
      ? [...roots.mediaRoots]
      : (() => {
          const raw = env[CONFIG_DEFAULTS.mediaRootsEnv];
          return raw === undefined
            ? []
            : splitEnvList(raw, CONFIG_DEFAULTS.mediaRootsEnv);
        })();
  const projectRoots =
    roots.projectRoots.length > 0
      ? [...roots.projectRoots]
      : (() => {
          const raw = env[CONFIG_DEFAULTS.projectRootsEnv];
          return raw === undefined
            ? []
            : splitEnvList(raw, CONFIG_DEFAULTS.projectRootsEnv);
        })();
  let artifactRoot = roots.artifactRoot;
  const rawArtifact = env[CONFIG_DEFAULTS.artifactRootEnv];
  if (artifactRoot === undefined && rawArtifact !== undefined) {
    artifactRoot = rawArtifact;
  }
  const deliveryRoots =
    roots.deliveryRoots.length > 0
      ? [...roots.deliveryRoots]
      : (() => {
          const raw = env[CONFIG_DEFAULTS.deliveryRootsEnv];
          return raw === undefined
            ? []
            : splitEnvList(raw, CONFIG_DEFAULTS.deliveryRootsEnv);
        })();
  return {
    mediaRoots,
    ...(artifactRoot !== undefined ? { artifactRoot } : {}),
    projectRoots,
    deliveryRoots,
  };
}

/** Flags beat env for the log level too (B.5); an invalid env value refuses startup. */
export function mergeEnvLogLevel(
  logLevel: LogLevel | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  if (logLevel !== undefined) return logLevel;
  const raw = env[CONFIG_DEFAULTS.logLevelEnv];
  if (raw === undefined) return "info";
  if (raw !== "error" && raw !== "info" && raw !== "debug") {
    throw new ConfigRefusal(
      `${CONFIG_DEFAULTS.logLevelEnv} must be error|info|debug (got "${raw}")`,
      { env: CONFIG_DEFAULTS.logLevelEnv, value: raw },
    );
  }
  return raw;
}

/**
 * Startup validation of ONE root (Decision 6): absolute (never `~`-expanded),
 * exists, is a directory, stored in realpath form. Refusal message names the
 * exact reason.
 */
export async function canonicalizeRoot(
  raw: string,
  rootClass: "mediaRoot" | "artifactRoot" | "projectRoot" | "deliveryRoot",
): Promise<string> {
  if (raw.length === 0) {
    throw new ConfigRefusal(`${rootClass}: empty path given`, { root: raw });
  }
  if (raw === "~" || raw.startsWith("~/")) {
    throw new ConfigRefusal(
      `${rootClass}: "${raw}" — '~' is never expanded; pass an absolute path`,
      { root: raw },
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new ConfigRefusal(
      `${rootClass}: "${raw}" is not an absolute path — relative roots are refused, never resolved against the process cwd`,
      { root: raw },
    );
  }
  const st = await stat(raw).catch(() => null);
  if (st === null) {
    throw new ConfigRefusal(
      `${rootClass}: "${raw}" does not exist (roots are never auto-created by the transport)`,
      { root: raw },
    );
  }
  if (!st.isDirectory()) {
    throw new ConfigRefusal(`${rootClass}: "${raw}" is not a directory`, {
      root: raw,
    });
  }
  return realpath(raw);
}

/**
 * Validate + canonicalize all four root classes. Throws ConfigRefusal on
 * the first offending root (startup refusal, exit 2).
 */
export async function resolveConfig(
  roots: RawRoots,
  logLevel: LogLevel | undefined,
): Promise<TransportConfig> {
  const mediaRoots = await Promise.all(
    roots.mediaRoots.map((root) => canonicalizeRoot(root, "mediaRoot")),
  );
  const projectRoots = await Promise.all(
    roots.projectRoots.map((root) => canonicalizeRoot(root, "projectRoot")),
  );
  const deliveryRoots = await Promise.all(
    roots.deliveryRoots.map((root) => canonicalizeRoot(root, "deliveryRoot")),
  );
  const artifactRoot =
    roots.artifactRoot !== undefined
      ? await canonicalizeRoot(roots.artifactRoot, "artifactRoot")
      : undefined;
  return {
    mediaRoots,
    ...(artifactRoot !== undefined ? { artifactRoot } : {}),
    projectRoots,
    deliveryRoots,
    logLevel: logLevel ?? "info",
  };
}

/** Refuse like resolveConfig does, as one stderr log + exit 2. */
export function refuseStartup(refusal: unknown, scope: string): never {
  const error =
    refusal instanceof ConfigRefusal
      ? refusal
      : refusal instanceof Error
        ? refusal
        : new ConfigRefusal(String(refusal));
  logError(scope, error.message, {
    ...(error instanceof ConfigRefusal ? error.details : {}),
    exitCode: 2,
  });
  process.exit(2);
}
