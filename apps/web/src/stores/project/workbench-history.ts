import { uiMessage as canonicalMessage } from "../../i18n/messages";
import type { ProjectState } from "../project-store";

/** Match the exact next project undo unit, including its contiguous group. */
export function workbenchHistoryAvailability(
  state: ProjectState,
  direction: "undo" | "redo",
): { allowed: boolean; reason: string } {
  const blocked = (reason: string) => ({ allowed: false, reason });
  if (state.project.reviewMigration) return blocked(canonicalMessage("The migration backup is read-only. Use the independent review task to edit its history."));
  const history = state.actionHistory;
  const next = direction === "undo" ? history.peekUndo() : history.peekRedo();
  if (direction === "undo") {
    const template = state.templateUndoStack.at(-1);
    if (template && template.sequence > (next?.sequence ?? -1)) return blocked(canonicalMessage("The next history entry is a video template. Undo it in the video editor."));
  } else {
    const branch = [...state.redoJournal].reverse().find(entry =>
      entry === "template" ? state.templateRedoStack.length > 0 : history.canRedo())
      ?? (state.templateRedoStack.length ? "template" : history.canRedo() ? "action" : null);
    if (branch === "template") return blocked(canonicalMessage("The next history entry is a video template. Redo it in the video editor."));
  }
  if (!next) return blocked(direction === "undo" ? canonicalMessage("No review action to undo") : canonicalMessage("No review action to redo"));
  const entries = direction === "undo" ? history.getHistoryEntries() : history.getRedoEntries();
  const unit = [next];
  if (next.groupId) {
    for (let index = entries.length - 2; index >= 0 && entries[index].groupId === next.groupId; index--) {
      unit.push(entries[index]);
    }
  }
  if (unit.some(entry =>
    !entry.action.type.startsWith("workbench/") || !entry.inverseAction?.type.startsWith("workbench/"))) {
    return blocked(canonicalMessage("The next history entry contains video or mixed actions. Use the video editor; review history will not skip it."));
  }
  return { allowed: true, reason: "" };
}
