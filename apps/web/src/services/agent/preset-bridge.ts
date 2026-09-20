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
 * Visibility: the service fires `openreel:custom-presets-updated` after
 * every committed change, so the GUI preset panels re-render the moment an
 * agent creates, renames, or deletes a preset — no polling either way.
 */
import type { PresetListItem } from "@reelterminal/agent-facade";
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
import { getProjectRevision, useProjectStore } from "../../stores/project-store";
import { runExclusiveLiveWrite } from "./live-write-lock";

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

interface ApplyLedgerEntry {
  readonly payload: string;
  readonly result: Record<string, unknown>;
}

/** Per-project ledger closing the apply timeout/retry window. */
const applyLedger = new Map<string, Map<string, ApplyLedgerEntry>>();

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

/** Structural re-check of the kind-tagged target (mirrors the facade layer). */
function parseApplyTarget(raw: unknown):
  | { ok: true; target: PresetApplyTarget }
  | { ok: false; error: PresetBridgeError } {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      error: { code: "INVALID_PARAMS", message: "preset.apply requires a target object" },
    };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "graphics") {
    if (
      record.trackId !== undefined &&
      (!isString(record.trackId) || record.trackId.length === 0)
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message:
            "graphics trackId must be a non-empty graphics track id; omit it to target the first graphics track (one is created when none exists)",
        },
      };
    }
    if (
      record.startTime !== undefined &&
      (typeof record.startTime !== "number" ||
        !Number.isFinite(record.startTime) ||
        record.startTime < 0)
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "graphics startTime must be a finite number >= 0 (timeline seconds)",
        },
      };
    }
    if (
      record.durationSec !== undefined &&
      (typeof record.durationSec !== "number" ||
        !Number.isFinite(record.durationSec) ||
        record.durationSec <= 0)
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message:
            "graphics durationSec must be a finite number > 0 (seconds); omit it for the default 5s",
        },
      };
    }
    return {
      ok: true,
      target: {
        kind: "graphics",
        ...(record.trackId !== undefined ? { trackId: record.trackId as string } : {}),
        ...(record.startTime !== undefined ? { startTime: record.startTime } : {}),
        ...(record.durationSec !== undefined ? { durationSec: record.durationSec } : {}),
      },
    };
  }
  if (kind === "text") {
    if (record.mode !== "updateStyle" || !isString(record.clipId) || record.clipId.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message:
            'text targets support {"kind":"text","mode":"updateStyle","clipId":...} — create a text clip first, then restyle it from the preset',
        },
      };
    }
    return {
      ok: true,
      target: { kind: "text", mode: "updateStyle", clipId: record.clipId },
    };
  }
  if (kind === "effect") {
    const clipIds = stringArray(record.clipIds);
    if (!clipIds || clipIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "effect target requires a non-empty clipIds array",
        },
      };
    }
    return { ok: true, target: { kind: "effect", clipIds } };
  }
  if (kind === "transition") {
    if (!isString(record.clipAId) || record.clipAId.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "transition target requires clipAId (the clip whose out-point transitions)",
        },
      };
    }
    if (
      record.clipBId !== undefined &&
      (!isString(record.clipBId) || record.clipBId.length === 0)
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "transition clipBId must be a non-empty clip id",
        },
      };
    }
    return {
      ok: true,
      target: {
        kind: "transition",
        clipAId: record.clipAId,
        ...(record.clipBId !== undefined ? { clipBId: record.clipBId as string } : {}),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "INVALID_PARAMS",
      message: `unknown target kind "${String(kind)}" (expected text | effect | transition | graphics)`,
    },
  };
}

async function handleApply(
  rawParams: Record<string, unknown>,
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
    expectedRevision: expectedRevision ?? null,
  });

  return runExclusiveLiveWrite(async () => {
    const store = useProjectStore.getState();
    if (!store.hasOpenProject) {
      return bridgeError({ code: "NO_PROJECT", message: "No project is open" });
    }
    // Same per-project bucketing as the other live ledgers: a key committed
    // in one project must never replay into another after a project switch.
    const projectId = store.project.id;
    const projectLedger = idempotencyKey ? applyLedger.get(projectId) : undefined;
    const prior = idempotencyKey ? projectLedger?.get(idempotencyKey) : undefined;
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
    if (expectedRevision !== undefined && getProjectRevision() !== expectedRevision) {
      return bridgeError({
        code: "CONFLICT",
        message: `Project revision mismatch: expected ${expectedRevision}, current ${getProjectRevision()}. Re-read state and retry.`,
        details: { currentRevision: getProjectRevision() },
      });
    }

    const preset = await getCustomPresetService().get(presetId);
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

    const batch = useProjectStore.getState().executeActionBatch(expanded.actions, {
      groupLabel: expanded.groupLabel,
      historyOwner: AGENT_HISTORY_OWNER,
    });
    if (!batch.result.success) {
      return bridgeError({
        code: "APPLY_FAILED",
        message: batch.result.error?.message ?? "preset apply failed",
        details: { appliedBeforeError: batch.applied },
      });
    }

    // Agent edits land outside the GUI gesture paths; nudge the preview.
    window.dispatchEvent(new CustomEvent("openreel:preview-invalidate"));

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
      revision: getProjectRevision(),
      applied: {
        kind: target.kind,
        clipIds: appliedClipIds,
        ...(transitionId !== undefined ? { transitionId } : {}),
        ...(graphicsTrackId !== undefined ? { trackId: graphicsTrackId } : {}),
      },
    };

    if (idempotencyKey) {
      let ledger = applyLedger.get(store.project.id);
      if (!ledger) {
        ledger = new Map();
        applyLedger.set(store.project.id, ledger);
      }
      ledger.set(idempotencyKey, { payload, result });
      if (ledger.size > 500) {
        const oldest = ledger.keys().next().value;
        if (oldest !== undefined) ledger.delete(oldest);
      }
    }
    return { ok: true, result };
  });
}

/** Handles one main→renderer preset-library request (exported for tests). */
export async function handlePresetLibraryRequest(req: {
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
        return await handleApply(rawParams);
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
