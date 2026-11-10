import { t } from "../../../i18n";
import type { TaskDecisionStatus } from "../../../../../desktop/src/shared/task-review";

/** Shared short verdict labels for decisions (moved out of UnitReviewScene). */
export const statusLabels: Record<TaskDecisionStatus, string> = {
  get kept() { return t("Keep"); },
  get rework() { return t("Rework"); },
  get discarded() { return t("Discard"); },
};

/** Display legacy generated originals naturally without renaming their files. */
export function sourceTitle(relativePath: string): string {
  const name = relativePath.replace(/\\/g, "/").split("/").at(-1) ?? relativePath;
  return name.replace(/^original-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
}
import { isTextTaskUnit, type TaskReviewUnit } from "../../../../../desktop/src/shared/task-review";


export function unitTitle(unit: TaskReviewUnit): string {
  if (isTextTaskUnit(unit)) return unit.text;
  if (unit.kind === "region") return unit.label;
  if (unit.kind === "video-frame") return t("Video frame{{v0}} · PTS {{v1}}s", { v0: unit.frameIndex === undefined ? "" : ` #${unit.frameIndex}`, v1: unit.ptsTimeSec.toFixed(3) });
  return unit.kind === "image" ? t("reviewUi.image") : t("Video");
}

export function sourcePath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]$/, "") + separator + relativePath.replace(/[\\/]/g, separator);
}
