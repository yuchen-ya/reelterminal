import type { AgentMediaTaskOverrides } from "./types";

/** Output folder recorded with a task so an artifact can later be imported. */
export function taskOutputDirectory(
  recommendedRoot: string,
  taskId: string,
): string {
  const separator = recommendedRoot.includes("\\") ? "\\" : "/";
  const trimmedRoot = recommendedRoot.replace(/[\\/]+$/, "");
  return [trimmedRoot, "jobs", taskId, "output"].join(separator);
}

/** A music task may specify its brief in the requirements or override fields. */
export function taskHasRequirementText(
  requirementsText?: string,
  overrides?: AgentMediaTaskOverrides,
): boolean {
  if (typeof requirementsText === "string" && requirementsText.trim().length > 0) {
    return true;
  }
  if (!overrides) return false;
  if (typeof overrides.language === "string" && overrides.language.trim()) return true;
  if (
    typeof overrides.targetDurationSeconds === "number" &&
    Number.isFinite(overrides.targetDurationSeconds) &&
    overrides.targetDurationSeconds > 0
  ) {
    return true;
  }
  return typeof overrides.styleHint === "string" && Boolean(overrides.styleHint.trim());
}

export type TaskArtifactSelection =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly code: "NO_ARTIFACT_FILE";
      readonly message: string;
    };

/** Pick the newest scan candidate when reviewing a previously created task. */
export function pickTaskArtifactFromScan(scanned: {
  readonly files: readonly { readonly path: string }[];
}): TaskArtifactSelection {
  const first = scanned.files[0];
  return first
    ? { ok: true, path: first.path }
    : {
        ok: false,
        code: "NO_ARTIFACT_FILE",
        message: "任务预铸产物目录中没有可导入的音频文件",
      };
}
