import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, ActionResult, WorkAsset } from "@reelterminal/core";
import {
  captureWorkAssetFromClip,
  captureWorkAssetFromClips,
  captureWorkAssetFromMedia,
} from "@reelterminal/core/work-assets/capture";
import { buildWorkAssetInstantiateActions } from "@reelterminal/core/work-assets/instantiate";
import { MAX_ACTIONS_PER_BATCH } from "./action-batch";
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
      /** Every instantiated clip id, in member order for "multi". */
      readonly clipIds: readonly string[];
      /** Every lane the batch touches, in track/add emission order. */
      readonly trackIds: readonly string[];
      readonly createdTrackCount: number;
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

export interface SaveMediaWorkAssetOptions {
  readonly name?: string;
  /** Source-media start in seconds; defaults to 0. */
  readonly inSec?: number;
  /** Source-media end in seconds; defaults to the media's default span. */
  readonly outSec?: number;
}

export type WorkAssetsSlice = Pick<
  ProjectState,
  | "saveClipAsWorkAsset"
  | "saveClipsAsWorkAsset"
  | "saveMediaAsWorkAsset"
  | "renameWorkAsset"
  | "deleteWorkAsset"
  | "instantiateWorkAsset"
>;

/**
 * Project-scoped work assets (`project.workAssets`). All methods commit
 * through executeActionBatch so capture, rename, delete, and instantiate are
 * each one undoable history group; the prechecks and the instantiate action
 * batch come from the shared core functions so the GUI and the agent facade
 * behave identically.
 *
 * The multi-clip forms share the same commit discipline: a multi capture is
 * ONE workAsset/create action (a multi asset is a single project entry —
 * atomic by construction), and a multi instantiation expands to at most
 * lanes + members actions (core caps: 32 + 64), far below
 * MAX_ACTIONS_PER_BATCH — the guard below turns an out-of-range expansion
 * into an explicit error instead of a silently truncated batch.
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

    saveClipsAsWorkAsset: async (clipIds, options) => {
      const { project } = get();
      if (clipIds.length < 2) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: "multi-clip capture requires at least 2 selected clips",
          details: { clipIds: [...clipIds] },
        };
      }
      const captured = captureWorkAssetFromClips(project, clipIds, {
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

    saveMediaAsWorkAsset: async (mediaId, options) => {
      const { project } = get();
      const captured = captureWorkAssetFromMedia(project, mediaId, {
        createdBy: "user",
        ...(options?.name !== undefined ? { name: options.name } : {}),
        ...(options?.inSec !== undefined ? { inSec: options.inSec } : {}),
        ...(options?.outSec !== undefined ? { outSec: options.outSec } : {}),
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
      // Multi expansions must stay inside the batch cap (core caps lanes at
      // 32 and members at 64, so this is a guardrail, not the norm); exceeding
      // it is an explicit error, never a truncated batch.
      if (built.actions.length > MAX_ACTIONS_PER_BATCH) {
        return {
          ok: false,
          code: "INVALID_PARAMS",
          message: `work asset instantiation needs ${built.actions.length} actions; at most ${MAX_ACTIONS_PER_BATCH} are supported per batch`,
          details: { workAssetId, actions: built.actions.length },
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
      window.dispatchEvent(new CustomEvent("reelterminal:preview-invalidate"));
      return {
        ok: true,
        trackId: built.trackId,
        clipId: built.clipId,
        createdTrack: built.createdTrack,
        clipIds: built.clipIds,
        trackIds: built.trackIds,
        createdTrackCount: built.createdTrackCount,
      };
    },
  };
}
