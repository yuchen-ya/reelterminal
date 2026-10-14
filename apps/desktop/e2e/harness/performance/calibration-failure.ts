import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
}

const redact = (text: string) => text.replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
const errorDetails = (error: unknown) => ({
  message: redact(String(error)),
  stack: error instanceof Error && error.stack ? redact(error.stack) : null,
});

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
  try { await input.screenshot?.(); }
  catch (error) {
    await writeFile(`${base}.screenshot-error.json`, JSON.stringify(errorDetails(error), null, 2));
  }
}
