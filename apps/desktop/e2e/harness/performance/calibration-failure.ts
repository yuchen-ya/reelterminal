import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";

interface CalibrationFailureInput {
  artifact: string;
  error: unknown;
  stage: string;
  controls: unknown;
  runs: unknown;
  build?: unknown;
  environment?: unknown;
  retainedProfile?: string;
  output?: Readonly<Record<string, readonly string[]>>;
  screenshot?: () => Promise<unknown>;
  startupDiagnostics?: () => Promise<unknown>;
}

const redact = (text: string) => text.replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
const errorDetails = (error: unknown) => ({
  message: redact(String(error)),
  stack: error instanceof Error && error.stack ? redact(error.stack) : null,
});

async function boundedDiagnostic(read: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("startup diagnostic deadline exceeded")), timeoutMs);
      }),
    ]);
    return { status: "available", value };
  } catch (error) {
    return { status: "unavailable", error: errorDetails(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Only structural state; never project contents, endpoint descriptors or URL queries. */
export async function captureCalibrationStartup(page: Page, openLabel: string, timeoutMs = 2_000): Promise<unknown> {
  const [documentState, openButtonCount] = await Promise.all([
    boundedDiagnostic(() => page.evaluate(() => ({
      url: `${location.origin}${location.pathname}`,
      readyState: document.readyState,
      rootPresent: Boolean(document.getElementById("root")),
      rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
      libraryPresent: Boolean(document.querySelector('[data-testid="project-library"]')),
      editorPresent: Boolean(document.querySelector('[data-testid="agent-access-status"]')),
      locale: document.documentElement.lang || navigator.language,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    })), timeoutMs),
    boundedDiagnostic(() => page.getByRole("button", { name: openLabel, exact: true }).count(), timeoutMs),
  ]);
  return JSON.parse(redact(JSON.stringify({ sampledAt: new Date().toISOString(), documentState, openButtonCount })));
}

/** Persist the primary failure before any optional, possibly hung screenshot. */
export async function writeCalibrationFailure(input: CalibrationFailureInput): Promise<void> {
  await mkdir(path.dirname(input.artifact), { recursive: true });
  const base = input.artifact.replace(/\.json$/, "");
  await writeFile(input.artifact, JSON.stringify({
    schema: "reelterminal.probe-calibration/v1", status: "invalid",
    failure: errorDetails(input.error), stage: input.stage,
    controls: input.controls, runs: input.runs, build: input.build,
    environment: input.environment, retained_profile: input.retainedProfile,
  }, null, 2));
  for (const [key, lines] of Object.entries(input.output ?? {})) {
    await writeFile(`${base}.${key}.redacted.log`, redact(lines.join("\n")));
  }
  if (input.startupDiagnostics) {
    const diagnostics = await boundedDiagnostic(input.startupDiagnostics, 4_500);
    await writeFile(`${base}.startup.json`, JSON.stringify(diagnostics, null, 2));
  }
  try { await input.screenshot?.(); }
  catch (error) {
    await writeFile(`${base}.screenshot-error.json`, JSON.stringify(errorDetails(error), null, 2));
  }
}
