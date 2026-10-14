import { writeFile } from "node:fs/promises";

interface ResourceLogs {
  readonly mainStdout: readonly string[];
  readonly mainStderr: readonly string[];
  readonly rendererConsole: readonly string[];
}

/** Persist owned-process logs before a successful soak removes its profile. */
export async function writeResourceLogs(prefix: string, output: ResourceLogs): Promise<void> {
  for (const key of ["mainStdout", "mainStderr", "rendererConsole"] as const) {
    const text = output[key].join(key === "rendererConsole" ? "\n" : "");
    await writeFile(`${prefix}.${key}.redacted.log`, text.replace(/\b[a-f0-9]{64}\b/gi, "[redacted]"));
  }
}
