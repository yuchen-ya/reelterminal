import { app } from "electron";
import { readEnvAlias } from "../shared/env-alias";

const REPORT_TIMEOUT_MS = 4000;

const REPORTABLE_TYPES = new Set([
  "uncaughtException",
  "unhandledRejection",
  "render-process-gone",
  "child-process-gone",
  "startup-failure",
  "renderer-error",
  "window-error",
  "unhandledrejection",
  "react-error",
]);

export interface CrashReportInput {
  type: string;
  source: string;
  message: string;
  stack?: string;
  context?: unknown;
}

function reportEndpoint(): string | null {
  const configured = readEnvAlias(
    process.env,
    "REELTERMINAL_CRASH_ENDPOINT",
    "OPENREEL_CRASH_ENDPOINT",
  );
  if (!configured?.trim()) return null;

  try {
    const endpoint = new URL(configured.trim());
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    ) {
      return null;
    }
    return endpoint.toString();
  } catch {
    return null;
  }
}

function safeReportType(type: unknown): string {
  return typeof type === "string" && REPORTABLE_TYPES.has(type)
    ? type
    : "unknown";
}

function appVersionSafe(): string {
  try {
    return app.getVersion();
  } catch {
    return "unknown";
  }
}

export function describeError(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message || value.name || "Error", stack: value.stack };
  }
  if (typeof value === "object" && value !== null) {
    const maybe = value as { message?: unknown; stack?: unknown };
    if (typeof maybe.message === "string") {
      return {
        message: maybe.message,
        stack: typeof maybe.stack === "string" ? maybe.stack : undefined,
      };
    }
    try {
      return { message: JSON.stringify(value) };
    } catch {
      return { message: String(value) };
    }
  }
  return { message: String(value) };
}

async function send(report: CrashReportInput): Promise<void> {
  const endpoint = reportEndpoint();
  if (!endpoint) return;

  try {
    const payload = {
      type: safeReportType(report.type),
      appVersion: appVersionSafe(),
      platform: process.platform,
      electronVersion: process.versions.electron,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // A failed report cannot escalate a local error.
  }
}

export function reportError(report: CrashReportInput): void {
  void send(report);
}

export function initCrashReporter(): void {
  process.on("uncaughtException", (error) => {
    console.error("[main] uncaughtException:", error);
    reportError({ type: "uncaughtException", source: "main", ...describeError(error) });
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[main] unhandledRejection:", reason);
    reportError({ type: "unhandledRejection", source: "main", ...describeError(reason) });
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    console.error("[main] render-process-gone:", details);
    reportError({
      type: "render-process-gone",
      source: "renderer",
      message: `render process gone: ${details.reason} (exitCode ${details.exitCode})`,
      context: details,
    });
  });
  app.on("child-process-gone", (_event, details) => {
    console.error("[main] child-process-gone:", details);
    reportError({
      type: "child-process-gone",
      source: details.type ?? "child",
      message: `child process gone: ${details.reason} (exitCode ${details.exitCode ?? "?"})`,
      context: details,
    });
  });
}
