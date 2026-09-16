import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, ActionResult, WorkAsset } from "@openreel/core";
import { captureWorkAssetFromClip } from "@openreel/core/work-assets/capture";
import { buildWorkAssetInstantiateActions } from "@openreel/core/work-assets/instantiate";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type SaveClipWorkAssetResult =
  | { readonly ok: true; readonly asset: WorkAsset }
  | {
      readonly ok: false;
      readonly code:
        | "NOT_FOUND"
        | "MEDIA_NOT_FOUND"
        | "UNSUPPORTED"
        | "INVALID_PARAMS";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export type InstantiateWorkAssetResult =
  | {
      readonly ok: true;
      readonly trackId: string;
      readonly clipId: string;
      readonly createdTrack: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "NOT_FOUND"
        | "MEDIA_NOT_FOUND"
        | "CONFLICT"
        | "INVALID_PARAMS";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface InstantiateWorkAssetOptions {
  readonly trackId?: string;
  readonly startTime?: number;
}

export interface SaveClipWorkAssetOptions {
  readonly name?: string;
}

export type WorkAssetsSlice = Pick<
  ProjectState,
  "saveClipAsWorkAsset" | "renameWorkAsset" | "deleteWorkAsset" | "instantiateWorkAsset"
>;

/**
 * Project-scoped work assets (`project.workAssets`). All four methods commit
 * through executeActionBatch so capture, rename, delete, and instantiate are
 * each one undoable history group; the prechecks and the instantiate action
 * batch come from the shared core functions so the GUI and the agent facade
 * behave identically.
 */
export function createWorkAssetsSlice(_set: Set, get: Get): WorkAssetsSlice {
  const commitSingleAction = async (
    action: Action,
    groupLabel: string,
  ): Promise<ActionResult> => {
    const { executeActionBatch } = get();
    return executeActionBatch([action], {
      groupLabel,
      historyOwner: "human",
    }).result;
  };

  return {
    saveClipAsWorkAsset: async (clipId, options) => {
      const { project } = get();
      const captured = captureWorkAssetFromClip(project, clipId, {
        createdBy: "user",
        ...(options?.name !== undefined ? { name: options.name } : {}),
      });
      if (!captured.ok) return captured;
      const action: Action = {
        type: "workAsset/create",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { asset: captured.asset },
      };
      const result = await commitSingleAction(
        action,
        `Save work asset "${captured.asset.name}"`,
      );
      if (!result.success) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: result.error?.message ?? "workAsset/create failed",
          ...(result.error?.details ? { details: result.error.details } : {}),
        };
      }
      return captured;
    },

    renameWorkAsset: async (workAssetId, name) => {
      const action: Action = {
        type: "workAsset/rename",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { workAssetId, name },
      };
      return commitSingleAction(action, "Rename work asset");
    },

    deleteWorkAsset: async (workAssetId) => {
      const action: Action = {
        type: "workAsset/delete",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { workAssetId },
      };
      return commitSingleAction(action, "Delete work asset");
    },

    instantiateWorkAsset: async (workAssetId, options) => {
      const { project, executeActionBatch } = get();
      const built = buildWorkAssetInstantiateActions(project, workAssetId, {
        ...(options?.trackId !== undefined ? { trackId: options.trackId } : {}),
        ...(options?.startTime !== undefined
          ? { startTime: options.startTime }
          : {}),
      });
      if (!built.ok) {
        return {
          ok: false,
          code: built.code,
          message: built.message,
          ...(built.details ? { details: built.details } : {}),
        };
      }
      const asset = (project.workAssets ?? []).find(
        (candidate) => candidate.id === workAssetId,
      );
      const batch = executeActionBatch(built.actions, {
        groupLabel: `Add work asset "${asset?.name ?? workAssetId}" to timeline`,
        historyOwner: "human",
      });
      if (!batch.result.success) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: batch.result.error?.message ?? "workAsset instantiate failed",
          ...(batch.result.error?.details
            ? { details: batch.result.error.details }
            : {}),
        };
      }
      window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));
      return {
        ok: true,
        trackId: built.trackId,
        clipId: built.clipId,
        createdTrack: built.createdTrack,
      };
    },
  };
}
