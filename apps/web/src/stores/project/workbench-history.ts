import type { ProjectState } from "../project-store";

/** Match the exact next project undo unit, including its contiguous group. */
export function workbenchHistoryAvailability(
  state: ProjectState,
  direction: "undo" | "redo",
): { allowed: boolean; reason: string } {
  const blocked = (reason: string) => ({ allowed: false, reason });
  if (state.project.reviewMigration) return blocked("迁移备份为只读，请在独立审阅任务中操作历史");
  const history = state.actionHistory;
  const next = direction === "undo" ? history.peekUndo() : history.peekRedo();
  if (direction === "undo") {
    const template = state.templateUndoStack.at(-1);
    if (template && template.sequence > (next?.sequence ?? -1)) return blocked("下一步是视频模板历史，请在视频编辑器中撤销");
  } else {
    const branch = [...state.redoJournal].reverse().find(entry =>
      entry === "template" ? state.templateRedoStack.length > 0 : history.canRedo())
      ?? (state.templateRedoStack.length ? "template" : history.canRedo() ? "action" : null);
    if (branch === "template") return blocked("下一步是视频模板历史，请在视频编辑器中重做");
  }
  if (!next) return blocked(direction === "undo" ? "没有可撤销的审阅操作" : "没有可重做的审阅操作");
  const entries = direction === "undo" ? history.getHistoryEntries() : history.getRedoEntries();
  const unit = [next];
  if (next.groupId) {
    for (let index = entries.length - 2; index >= 0 && entries[index].groupId === next.groupId; index--) {
      unit.push(entries[index]);
    }
  }
  if (unit.some(entry =>
    !entry.action.type.startsWith("workbench/") || !entry.inverseAction?.type.startsWith("workbench/"))) {
    return blocked("下一步历史包含视频或混合操作，请在视频编辑器中操作；审阅不会跳过该历史");
  }
  return { allowed: true, reason: "" };
}
