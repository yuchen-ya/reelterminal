/** Display legacy generated originals naturally without renaming their files. */
export function sourceTitle(relativePath: string): string {
  const name = relativePath.replace(/\\/g, "/").split("/").at(-1) ?? relativePath;
  return name.replace(/^original-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
}
import { isTextTaskUnit, type TaskReviewUnit } from "../../../../../desktop/src/shared/task-review";


export function unitTitle(unit: TaskReviewUnit): string {
  if (isTextTaskUnit(unit)) return unit.text;
  if (unit.kind === "region") return unit.label;
  if (unit.kind === "video-frame") return `视频帧${unit.frameIndex === undefined ? "" : ` #${unit.frameIndex}`} · PTS ${unit.ptsTimeSec.toFixed(3)}s`;
  return unit.kind === "image" ? "图片" : "视频";
}

export function sourcePath(root: string, relativePath: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]$/, "") + separator + relativePath.replace(/[\\/]/g, separator);
}
