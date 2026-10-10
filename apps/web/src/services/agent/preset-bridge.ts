import { projectGuardError, projectLedgerScope, type ProjectGuard } from "./project-guard";
/**
 * Renderer side of the preset-library live bridge: the desktop main process
 * facade forwards preset.* verbs here, and this module executes them against
 * the canonical user-level preset service (records + IndexedDB) and the
 * canonical project store (apply only).
 *
 * Concurrency: preset CRUD is serialized inside the service's own lane;
 * apply runs inside runExclusiveLiveWrite and keeps a renderer commit
 * ledger keyed by the open project, then by idempotencyKey, so an IPC
 * timeout→retry cannot double-apply a preset — and a key committed in one
 * project cannot replay into another after a project switch.
 *
 * Visibility: the service fires `reelterminal:custom-presets-updated` after
 * every committed change, so the GUI preset panels re-render the moment an
 * agent creates, renames, or deletes a preset — no polling either way.
 */
// Import the value from its defining subpath: importing the facade index
// here would pull the whole agent-facade (including Node-only modules such
// as media/path-roots) into the browser bundle.
import { presetApplyTargetProblem, type PresetListItem } from "@reelterminal/agent-facade/preset-verbs";
import type {
  CustomPresetRecord,
  PresetKind,
} from "@reelterminal/core/presets/types";
import { PRESET_KINDS } from "@reelterminal/core/presets/types";
import {
  getCustomPresetService,
  type CustomPresetUpdateInput,
} from "../custom-presets/preset-service";
import {
  expandPresetActions,
  type PresetApplyTarget,
} from "../custom-presets/apply";
import { workspaceManager } from "../workspace-manager";
import { runExclusiveLiveWrite } from "./live-write-lock";
import { codedError, managerErrorCode } from "./bridge-error";
import { createReplyLedger } from "./reply-ledger";

/** Same owner tag the live action channel uses for agent-made history. */
const AGENT_HISTORY_OWNER = "agent";

export type PresetBridgeError = {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type PresetBridgeReply =
  | { readonly ok: true; result: unknown }
  | { readonly ok: false; error: PresetBridgeError };

/** Per-project ledger closing the apply timeout/retry window. */
const applyLedger = createReplyLedger<Record<string, unknown>>();

function bridgeError(error: PresetBridgeError): PresetBridgeReply {
  return { ok: false, error };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/** Metadata projection: parameter bytes stay out of listings by default. */
function toListItem(
  record: CustomPresetRecord,
  includePayload: boolean,
): PresetListItem {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    tags: [...record.tags],
    ...(record.builtinBaseId !== undefined
      ? { builtinBaseId: record.builtinBaseId }
      : {}),
    hasThumbnail: record.thumbnailDataUrl !== undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    ...(includePayload
      ? { payload: structuredClone(record.payload) as unknown as Record<string, unknown> }
      : {}),
  };
}

function serviceError(
  outcome: { ok: false; code: string; message: string; details?: Record<string, unknown> },
): PresetBridgeReply {
  return bridgeError({
    code: outcome.code,
    message: outcome.message,
    ...(outcome.details ? { details: outcome.details } : {}),
  });
}

/**
 * Structural re-check of the kind-tagged target. The predicate itself lives
 * in agent-facade (`presetApplyTargetProblem`) so the renderer and the facade
 * layer can never drift apart; here we only re-tag it as a bridge error and
 * narrow the already-validated record into the local target type.
 */
function parseApplyTarget(raw: unknown):
  | { ok: true; target: PresetApplyTarget }
  | { ok: false; error: PresetBridgeError } {
  const problem = presetApplyTargetProblem(raw);
  if (problem !== null) {
    return { ok: false, error: { code: "INVALID_PARAMS", message: problem } };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "graphics") {
    return {
      ok: true,
      target: {
        kind: "graphics",
        ...(record.trackId !== undefined ? { trackId: record.trackId as string } : {}),
        ...(record.startTime !== undefined ? { startTime: record.startTime as number } : {}),
        ...(record.durationSec !== undefined ? { durationSec: record.durationSec as number } : {}),
      },
    };
  }
  if (kind === "text") {
    return {
      ok: true,
      target: { kind: "text", mode: "updateStyle", clipId: record.clipId as string },
    };
  }
  if (kind === "effect") {
    return { ok: true, target: { kind: "effect", clipIds: record.clipIds as string[] } };
  }
  return {
    ok: true,
    target: {
      kind: "transition",
      clipAId: record.clipAId as string,
      ...(record.clipBId !== undefined ? { clipBId: record.clipBId as string } : {}),
    },
  };
}

async function handleApply(
  rawParams: Record<string, unknown>,
  guard: ProjectGuard = {},
): Promise<PresetBridgeReply> {
  const presetId = rawParams.presetId;
  if (!isString(presetId) || presetId.length === 0) {
    return bridgeError({
      code: "INVALID_PARAMS",
      message: "preset.apply requires presetId",
    });
  }
  const parsed = parseApplyTarget(rawParams.target);
  if (!parsed.ok) return bridgeError(parsed.error);
  const target = parsed.target;

  const expectedRevision =
    typeof rawParams.expectedRevision === "number"
      ? rawParams.expectedRevision
      : undefined;
  const idempotencyKey = isString(rawParams.idempotencyKey)
    ? rawParams.idempotencyKey
    : undefined;
  const payload = JSON.stringify({
    presetId,
    target,
  });

  if (!guard.targetProjectId || !guard.targetWorkspaceId) {
    return bridgeError({ code: "INVALID_PARAMS", message: "preset.apply requires explicit projectId and workspaceId" });
  }
  const workspaceTarget = { projectId: guard.targetProjectId, workspaceId: guard.targetWorkspaceId };

  return runExclusiveLiveWrite(async () => {
    const conflict = projectGuardError(guard);
    if (conflict) return conflict;
    const runtime = await workspaceManager.getWorkspaceContext(workspaceTarget);
    if (guard.targetWorkspaceInstanceId !== undefined && guard.targetWorkspaceInstanceId !== runtime.instanceId) {
      return bridgeError({ code: "CONFLICT", message: "Workspace runtime changed since the targeted read" });
    }
    const store = runtime.store.getState();
    // Same per-project bucketing as the other live ledgers: a key committed
    // in one project must never replay into another after a project switch.
    const projectId = projectLedgerScope(workspaceTarget);
    const prior = idempotencyKey ? applyLedger.lookup(projectId, idempotencyKey) : undefined;
    if (prior) {
      if (prior.payload !== payload) {
        return bridgeError({
          code: "CONFLICT",
          message: `idempotency key "${idempotencyKey}" was already committed with a different payload`,
        });
      }
      return { ok: true, result: { ...prior.result, replayed: true } };
    }

    // CAS at commit time (the facade already checked the revision it read):
    // a concurrent human or agent edit wins and the stale apply retries.
    if (expectedRevision !== undefined && runtime.revision !== expectedRevision) {
      return bridgeError({
        code: "CONFLICT",
        message: `Workspace revision mismatch: expected ${expectedRevision}, current ${runtime.revision}. Re-read state and retry.`,
        details: { currentRevision: runtime.revision },
      });
    }

    const plannedRevision = runtime.revision;
    const preset = await getCustomPresetService().get(presetId);
    const latestRuntime = await workspaceManager.getWorkspaceContext(workspaceTarget);
    if (projectGuardError(guard) || projectLedgerScope(workspaceTarget) !== projectId ||
        latestRuntime.instanceId !== runtime.instanceId || latestRuntime.revision !== plannedRevision) {
      return bridgeError({ code: "CONFLICT", message: "Workspace changed while loading the preset" });
    }
    if (!preset.ok) return serviceError(preset);

    const expanded = expandPresetActions({
      preset: preset.value,
      target,
      project: store.project,
    });
    if (!expanded.ok) {
      return bridgeError({
        code: expanded.code,
        message: expanded.message,
        ...(expanded.details ? { details: expanded.details } : {}),
      });
    }

    let batch: ReturnType<typeof store.executeActionBatch>;
    try {
      batch = await workspaceManager.withWorkspaceWrite(workspaceTarget, expectedRevision ?? plannedRevision, async (context) => {
        if (context.instanceId !== runtime.instanceId) throw codedError("CONFLICT", "Workspace runtime changed before preset commit");
        return context.store.getState().executeActionBatch(expanded.actions, {
          groupLabel: expanded.groupLabel,
          historyOwner: AGENT_HISTORY_OWNER,
        });
      });
    } catch (error) {
      if (managerErrorCode(error) === "CONFLICT") {
        const message = error instanceof Error ? error.message : String(error);
        return bridgeError({ code: "CONFLICT", message: `Workspace preset conflict: ${message}` });
      }
      throw error;
    }
    if (!batch.result.success) {
      return bridgeError({
        code: "APPLY_FAILED",
        message: batch.result.error?.message ?? "preset apply failed",
        details: { appliedBeforeError: batch.applied },
      });
    }

    // Agent edits land outside the GUI gesture paths; nudge the preview.
    if (store.isForeground) window.dispatchEvent(new CustomEvent("reelterminal:preview-invalidate"));

    let transitionId: string | undefined;
    const first = expanded.actions[0]?.params as
      | { transition?: { id?: string } }
      | undefined;
    if (target.kind === "transition" && isString(first?.transition?.id)) {
      transitionId = first.transition.id;
    }
    // Graphics targets create a NEW SVG clip; the applied projection
    // surfaces the created clip id (and its track) so the caller can
    // address the result in follow-up edits.
    let graphicsClipId: string | undefined;
    let graphicsTrackId: string | undefined;
    if (target.kind === "graphics") {
      for (const action of expanded.actions) {
        if (action.type === "svg/create") {
          const clip = action.params as { clip?: { id?: string; trackId?: string } };
          if (isString(clip.clip?.id)) graphicsClipId = clip.clip.id;
          if (isString(clip.clip?.trackId)) graphicsTrackId = clip.clip.trackId;
        }
      }
    }
    const appliedClipIds =
      target.kind === "text"
        ? [target.clipId]
        : target.kind === "effect"
          ? [...target.clipIds]
          : target.kind === "transition"
            ? target.clipBId !== undefined
              ? [target.clipAId, target.clipBId]
              : [target.clipAId]
            : graphicsClipId !== undefined
              ? [graphicsClipId]
              : [];
    const result: Record<string, unknown> = {
      presetId,
      projectId: store.project.id,
      projectName: store.project.name,
      revision: runtime.store.getState().workspaceRevision,
      applied: {
        kind: target.kind,
        clipIds: appliedClipIds,
        ...(transitionId !== undefined ? { transitionId } : {}),
        ...(graphicsTrackId !== undefined ? { trackId: graphicsTrackId } : {}),
      },
    };

    if (idempotencyKey) {
      applyLedger.commit(projectId, idempotencyKey, { payload, result });
    }
    return { ok: true, result };
  }, workspaceTarget);
}

/** Handles one main→renderer preset-library request (exported for tests). */
export async function handlePresetLibraryRequest(req: {
  readonly guard?: ProjectGuard;
  readonly verb?: unknown;
  readonly params?: unknown;
}): Promise<PresetBridgeReply> {
  const verb = typeof req.verb === "string" ? req.verb : "";
  const rawParams =
    typeof req.params === "object" && req.params !== null
      ? (req.params as Record<string, unknown>)
      : {};
  const service = getCustomPresetService();
  try {
    switch (verb) {
      case "list": {
        const kind = isString(rawParams.kind) ? (rawParams.kind as PresetKind) : undefined;
        if (kind !== undefined && !(PRESET_KINDS as readonly string[]).includes(kind)) {
          return bridgeError({
            code: "INVALID_PARAMS",
            message: `unknown preset kind: ${kind}`,
          });
        }
        const query = isString(rawParams.query) ? rawParams.query : undefined;
        const includePayload = rawParams.includePayload === true;
        const result = await service.list(kind, query);
        if (!result.ok) return serviceError(result);
        return {
          ok: true,
          result: {
            presets: result.value.presets.map((record) =>
              toListItem(record, includePayload),
            ),
            total: result.value.presets.length,
          },
        };
      }
      case "get": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "preset.get requires id" });
        }
        const result = await service.get(rawParams.id);
        if (!result.ok) return serviceError(result);
        return { ok: true, result: { preset: result.value } };
      }
      case "create": {
        if (!isString(rawParams.kind) || !isString(rawParams.name)) {
          return bridgeError({
            code: "INVALID_PARAMS",
            message: "preset.create requires kind and name",
          });
        }
        if (typeof rawParams.payload !== "object" || rawParams.payload === null) {
          return bridgeError({
            code: "INVALID_PARAMS",
            message: "preset.create requires a payload object",
          });
        }
        const result = await service.create({
          kind: rawParams.kind as PresetKind,
          name: rawParams.name,
          payload: rawParams.payload,
          ...(stringArray(rawParams.tags) ? { tags: stringArray(rawParams.tags) } : {}),
          ...(isString(rawParams.builtinBaseId)
            ? { builtinBaseId: rawParams.builtinBaseId }
            : {}),
          ...(isString(rawParams.thumbnailDataUrl)
            ? { thumbnailDataUrl: rawParams.thumbnailDataUrl }
            : {}),
        });
        if (!result.ok) return serviceError(result);
        return { ok: true, result: { preset: result.value } };
      }
      case "update": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "preset.update requires id" });
        }
        const patch: CustomPresetUpdateInput = {
          ...(isString(rawParams.name) ? { name: rawParams.name } : {}),
          ...(stringArray(rawParams.tags) ? { tags: stringArray(rawParams.tags) } : {}),
          ...(typeof rawParams.payload === "object" && rawParams.payload !== null
            ? { payload: rawParams.payload }
            : {}),
          ...(isString(rawParams.thumbnailDataUrl)
            ? { thumbnailDataUrl: rawParams.thumbnailDataUrl }
            : {}),
          ...(typeof rawParams.expectedRevision === "number"
            ? { expectedRevision: rawParams.expectedRevision }
            : {}),
        };
        const result = await service.update(rawParams.id, patch);
        if (!result.ok) return serviceError(result);
        return { ok: true, result: { preset: result.value } };
      }
      case "remove": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "preset.remove requires id" });
        }
        // Projects keep their applied parameter copies; deleting a preset
        // never touches them, so no force flag exists here.
        const result = await service.remove(rawParams.id);
        if (!result.ok) return serviceError(result);
        return { ok: true, result: { ...result.value } };
      }
      case "apply": {
        return await handleApply(rawParams, req.guard);
      }
      default:
        return bridgeError({
          code: "INVALID_PARAMS",
          message: `Unknown preset bridge verb: ${verb || "(none)"}`,
        });
    }
  } catch (error) {
    return bridgeError({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
