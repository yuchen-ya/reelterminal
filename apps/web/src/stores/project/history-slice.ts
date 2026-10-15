import type { StoreApi } from "zustand";
import type { ActionResult, Project } from "@reelterminal/core";
import type { ProjectState } from "../project-store";
import type { ProjectStoreHelpers } from "./store-helpers";
import { useUIStore } from "../ui-store";
import { getTimelineSelectionItem } from "../../utils/timeline-item-actions";
import type {
  EditingTemplateHistoryEntry,
  EditingTemplateApplicationState,
} from "./index";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export interface HistoryDeps {
  syncOverlayEnginesFromProject: ProjectStoreHelpers["syncOverlayEnginesFromProject"];
  syncProjectEffectsBridge: (next: Project, prev?: Project) => void;
  syncProjectTransitionsBridge: (next: Project, prev?: Project) => void;
  getEditingTemplateApplicationState: (
    entry: EditingTemplateHistoryEntry,
  ) => EditingTemplateApplicationState;
  removeEditingTemplateApplicationStateFromProject: (
    project: Project,
    applicationState: EditingTemplateApplicationState,
    removeEmptyTracks?: boolean,
  ) => Project;
  restoreEditingTemplateApplicationState: (
    project: Project,
    applicationState: EditingTemplateApplicationState,
  ) => Project | null;
}

export type HistorySlice = Pick<
  ProjectState,
  | "beginHistoryGroup"
  | "endHistoryGroup"
  | "undo"
  | "redo"
  | "canUndo"
  | "canRedo"
>;

export function createHistorySlice(
  set: Set,
  get: Get,
  deps: HistoryDeps,
): HistorySlice {
  const {
    syncOverlayEnginesFromProject,
    syncProjectEffectsBridge,
    syncProjectTransitionsBridge,
    getEditingTemplateApplicationState,
    removeEditingTemplateApplicationStateFromProject,
    restoreEditingTemplateApplicationState,
  } = deps;

  const applyHistoryChange = async (operation: () => Promise<ActionResult>): Promise<ActionResult> => {
    const result = await operation();
    if (result.success) get().actionHistory.breakGroup();
    const state = get();
    // Prune based on post-operation state even when the operation failed: a
    // partially applied undo (e.g. an inverse action throwing midway) can
    // still have removed clips, leaving selections pointing at ghosts.
    if (state.isForeground) {
      const ui = useUIStore.getState();
      for (const id of ui.getSelectedClipIds()) {
        if (!getTimelineSelectionItem(state, id)) ui.deselect(id);
      }
    }
    return result;
  };

  return {
    beginHistoryGroup: (description?: string, owner?: string) => {
      return get().actionExecutor.getHistory().beginGroup(description, owner);
    },

    endHistoryGroup: (groupId?: string) => {
      get().actionExecutor.getHistory().endGroup(groupId);
    },

    undo: async (options) => {
      const operation = async (): Promise<ActionResult> => {
      const {
        project,
        actionExecutor,
        actionHistory,
        templateUndoStack,
        templateRedoStack,
      } = get();

      const latestActionSequence = actionHistory.peekUndo()?.sequence ?? -1;
      const latestTemplateSequence =
        templateUndoStack.length > 0
          ? templateUndoStack[templateUndoStack.length - 1].sequence
          : -1;

      if (
        latestTemplateSequence >= 0 &&
        latestTemplateSequence > latestActionSequence
      ) {
        const entry = templateUndoStack[templateUndoStack.length - 1];
        const removedProject = removeEditingTemplateApplicationStateFromProject(
          project,
          getEditingTemplateApplicationState(entry),
        );
        const updatedProject = entry.previousState
          ? restoreEditingTemplateApplicationState(
              removedProject,
              entry.previousState,
            )
          : removedProject;

        if (!updatedProject) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS",
              message: "Failed to undo editing template update",
            },
          };
        }

        set({
          project: updatedProject,
          templateUndoStack: templateUndoStack.slice(0, -1),
          templateRedoStack: [
            ...templateRedoStack,
            { ...entry, timestamp: Date.now() },
          ],
          redoJournal: [...get().redoJournal, "template"],
        });

        return { success: true };
      }

      const result = await actionExecutor.undo(project);
      if (result.success) {
        set({
          project: { ...project, modifiedAt: Date.now() },
          redoJournal: [...get().redoJournal, "action"],
        });
        if (get().isForeground) {
          syncProjectEffectsBridge(get().project, get().project);
          syncProjectTransitionsBridge(get().project, get().project);
        }
        syncOverlayEnginesFromProject();
      }
      return result;
      };
      const submit = get().submitWorkspaceMutation;
      const apply = () => applyHistoryChange(operation);
      return submit && !options?.alreadySerialized ? submit(apply) : apply();
    },

    redo: async (options) => {
      const operation = async (): Promise<ActionResult> => {
      const {
        project,
        actionExecutor,
        templateUndoStack,
        templateRedoStack,
      } = get();

      const journal = [...get().redoJournal];
      let target: "action" | "template" | null = null;
      while (journal.length > 0) {
        const stack = journal.pop();
        if (stack === "template" && templateRedoStack.length > 0) {
          target = "template";
          break;
        }
        if (stack === "action" && actionExecutor.getHistory().canRedo()) {
          target = "action";
          break;
        }
      }
      if (!target) {
        journal.length = 0;
        target =
          templateRedoStack.length > 0
            ? "template"
            : actionExecutor.getHistory().canRedo()
              ? "action"
              : null;
      }
      if (!target) {
        return {
          success: false,
          error: { code: "INVALID_PARAMS", message: "Nothing to redo" },
        };
      }
      const nextJournal = journal;

      if (target === "template" && templateRedoStack.length > 0) {
        const entry = templateRedoStack[templateRedoStack.length - 1];
        const cleanedProject = entry.previousState
          ? removeEditingTemplateApplicationStateFromProject(
              project,
              entry.previousState,
            )
          : project;
        const updatedProject = restoreEditingTemplateApplicationState(
          cleanedProject,
          getEditingTemplateApplicationState(entry),
        );

        if (!updatedProject) {
          return {
            success: false,
            error: {
              code: "INVALID_PARAMS",
              message: "Failed to restore editing template application",
            },
          };
        }

        set({
          project: updatedProject,
          templateUndoStack: [
            ...templateUndoStack,
            { ...entry, timestamp: Date.now() },
          ],
          templateRedoStack: templateRedoStack.slice(0, -1),
          redoJournal: nextJournal,
        });

        return { success: true };
      }

      const result = await actionExecutor.redo(project);
      if (result.success) {
        set({
          project: { ...project, modifiedAt: Date.now() },
          redoJournal: nextJournal,
        });
        if (get().isForeground) {
          syncProjectEffectsBridge(get().project, get().project);
          syncProjectTransitionsBridge(get().project, get().project);
        }
        syncOverlayEnginesFromProject();
      }
      return result;
      };
      const submit = get().submitWorkspaceMutation;
      const apply = () => applyHistoryChange(operation);
      return submit && !options?.alreadySerialized ? submit(apply) : apply();
    },

    canUndo: () => {
      const { actionHistory, templateUndoStack } = get();
      return templateUndoStack.length > 0 || actionHistory.canUndo();
    },

    canRedo: () => {
      const { actionHistory, templateRedoStack } = get();
      return templateRedoStack.length > 0 || actionHistory.canRedo();
    },
  };
}
