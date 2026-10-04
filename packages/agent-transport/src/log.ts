/**
 * stderr logging for the agent transport.
 *
 * stdout is reserved for protocol bytes only (MCP frames in `serve`, step
 * JSON lines in `run`, the `doctor` report) — EVERY log lands here, as
 * single-line JSON `{ts, level, scope, msg, ...}`, level-gated by
 * `--log-level` / `REELTERMINAL_TRANSPORT_LOG` (error | info | debug; default
 * info). Dependency `console.*` is redirected onto this writer by cli.ts.
 */

export type LogLevel = "error" | "info" | "debug";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  info: 1,
  debug: 2,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

/** One single-line JSON log to stderr. Never throws. */
export function log(
  level: LogLevel,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (!enabled(level)) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...fields,
  };
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // stderr gone (e.g. closed pipe during shutdown) — nothing to do.
  }
}

export function logError(scope: string, msg: string, fields?: Record<string, unknown>): void {
  log("error", scope, msg, fields);
}
export function logInfo(scope: string, msg: string, fields?: Record<string, unknown>): void {
  log("info", scope, msg, fields);
}
export function logDebug(scope: string, msg: string, fields?: Record<string, unknown>): void {
  log("debug", scope, msg, fields);
}

/**
 * Decision 6: dependency `console.*` is redirected to stderr so a chatty
 * transitive module can never corrupt the protocol stream on fd 1. Called
 * once at CLI startup, before any dependency code runs.
 */
export function redirectConsoleToStderr(): void {
  const write = (level: LogLevel, args: unknown[]): void => {
    const parts = args.map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    });
    try {
      process.stderr.write(`[console.${level}] ${parts.join(" ")}\n`);
    } catch {
      // ignore
    }
  };
  const originalError = console.error.bind(console);
  console.log = (...args: unknown[]) => write("info", args);
  console.info = (...args: unknown[]) => write("info", args);
  console.debug = (...args: unknown[]) => write("debug", args);
  console.warn = (...args: unknown[]) => write("info", args);
  console.error = (...args: unknown[]) => {
    originalError(...(args as Parameters<typeof console.error>));
  };
  console.trace = (...args: unknown[]) => write("debug", args);
}
