/**
 * Renderer side of the material-library live bridge: the desktop main
 * process facade forwards material.* verbs here, and this module executes
 * them against the canonical user-level library service (records, journal,
 * IndexedDB) and the canonical project store (attach only).
 *
 * Concurrency: every library mutation is serialized inside the service's own
 * lane; project mutations run inside runExclusiveLiveWrite. The attach path
 * keeps a renderer commit ledger keyed by the open project, then by
 * idempotencyKey, so an IPC timeout→retry cannot double-import a material
 * into the project — and a key committed in one project cannot replay into
 * another after a project switch.
 */
import type {
  MaterialCreateRequest,
  MaterialLibraryService,
  MaterialServiceResult,
} from "../material-library/library-service";
import { getMaterialLibraryService } from "../material-library/library-service";
import { attachMaterialToProject } from "../material-library/attach";
import type { AttachMaterialSuccess } from "../material-library/attach";
import type {
  MaterialFileRef,
  MaterialListQuery,
  MaterialMediaMetadata,
  MaterialUpdatePatch,
} from "@reelterminal/core";
import { runExclusiveLiveWrite } from "./live-write-lock";
import { useProjectStore } from "../../stores/project-store";

export type MaterialBridgeError = {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type MaterialBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: MaterialBridgeError };

interface AttachLedgerEntry {
  readonly payload: string;
  readonly result: AttachMaterialSuccess;
}

/** Per-project ledger closing the attach timeout/retry window. */
const attachLedger = new Map<string, Map<string, AttachLedgerEntry>>();

function toBridgeReply<T>(
  result: MaterialServiceResult<T>,
): MaterialBridgeReply {
  if (result.ok) return { ok: true, result: result.value };
  return {
    ok: false,
    error: {
      code: result.code,
      message: result.message,
      ...(result.details ? { details: result.details } : {}),
    },
  };
}

function bridgeError(error: MaterialBridgeError): MaterialBridgeReply {
  return { ok: false, error };
}

/** Handles one main→renderer material-library request (exported for tests). */
export async function handleMaterialLibraryRequest(req: {
  readonly verb?: unknown;
  readonly params?: unknown;
}): Promise<MaterialBridgeReply> {
  const verb = typeof req.verb === "string" ? req.verb : "";
  const rawParams =
    typeof req.params === "object" && req.params !== null
      ? (req.params as Record<string, unknown>)
      : {};
  try {
    switch (verb) {
      case "list": {
        const query: MaterialListQuery = {
          page: typeof rawParams.page === "number" ? rawParams.page : 1,
          pageSize: typeof rawParams.pageSize === "number" ? rawParams.pageSize : 50,
          ...(isString(rawParams.kind)
            ? { kind: rawParams.kind as MaterialListQuery["kind"] }
            : {}),
          ...(isString(rawParams.status)
            ? { status: rawParams.status as MaterialListQuery["status"] }
            : {}),
          ...(isString(rawParams.tag) ? { tag: rawParams.tag } : {}),
          ...(isString(rawParams.query) ? { query: rawParams.query } : {}),
          ...(isString(rawParams.sort)
            ? { sort: rawParams.sort as MaterialListQuery["sort"] }
            : {}),
        };
        return toBridgeReply(await getMaterialLibraryService().list(query));
      }
      case "get": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "material.get requires id" });
        }
        const result = await getMaterialLibraryService().get(rawParams.id);
        return toBridgeReply(
          result.ok
            ? { ok: true as const, value: { material: result.value } }
            : result,
        );
      }
      case "create": {
        const request = createRequestFromBridge(rawParams);
        const result = await getMaterialLibraryService().create(
          request,
          "agent",
          "material.create",
        );
        const reply = toBridgeReply(result);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      case "update": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "material.update requires id" });
        }
        const patch = patchFromBridge(rawParams);
        const result = await getMaterialLibraryService().update(
          rawParams.id,
          patch,
          "agent",
          typeof rawParams.expectedRevision === "number"
            ? rawParams.expectedRevision
            : undefined,
          "material.update",
        );
        const reply = toBridgeReply(result);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      case "batchUpdate": {
        const updates = Array.isArray(rawParams.updates) ? rawParams.updates : [];
        const items = updates.map((item) => {
          const entry =
            typeof item === "object" && item !== null
              ? (item as Record<string, unknown>)
              : {};
          return {
            id: isString(entry.id) ? entry.id : "",
            patch: patchFromBridge(entry),
            ...(typeof entry.expectedRevision === "number"
              ? { expectedRevision: entry.expectedRevision }
              : {}),
          };
        });
        const result = await getMaterialLibraryService().batchUpdate(
          items,
          "agent",
          "material.batch_update",
        );
        const reply = toBridgeReply(result);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      case "remove": {
        if (!isString(rawParams.id)) {
          return bridgeError({ code: "INVALID_PARAMS", message: "material.remove requires id" });
        }
        const result = await getMaterialLibraryService().remove(
          rawParams.id,
          { force: rawParams.force === true },
          "agent",
          "material.remove",
        );
        const reply = toBridgeReply(result);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      case "undo": {
        const result = await getMaterialLibraryService().undo(
          isString(rawParams.entryId) ? rawParams.entryId : undefined,
          "agent",
        );
        const reply = toBridgeReply(result);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      case "attach": {
        const reply = await handleAttach(rawParams);
        notifyLibraryChanged(reply.ok);
        return reply;
      }
      default:
        return bridgeError({
          code: "INVALID_PARAMS",
          message: `Unknown material bridge verb: ${verb || "(none)"}`,
        });
    }
  } catch (error) {
    return bridgeError({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Agent-side mutations land outside React gestures; nudge any mounted
 * Library panel so batch results are visible the moment they commit.
 */
function notifyLibraryChanged(success: boolean): void {
  if (!success || typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("reelterminal:material-library-changed"));
  } catch {
    // Never fail a committed mutation because a UI event could not fire.
  }
}

async function handleAttach(
  rawParams: Record<string, unknown>,
): Promise<MaterialBridgeReply> {
  const materialId = rawParams.materialId;
  if (!isString(materialId)) {
    return bridgeError({
      code: "INVALID_PARAMS",
      message: "material.attach requires materialId",
    });
  }
  const idempotencyKey = isString(rawParams.idempotencyKey)
    ? rawParams.idempotencyKey
    : undefined;
  const payload = JSON.stringify({
    materialId,
    startSec: rawParams.startSec ?? null,
    endSec: rawParams.endSec ?? null,
    addClip: rawParams.addClip ?? null,
  });

  return runExclusiveLiveWrite(async () => {
    // Same per-project bucketing as the live-bridge ledgers: a key committed
    // in one project must never replay into another after a project switch.
    const projectId = useProjectStore.getState().project.id;
    const projectLedger = idempotencyKey
      ? attachLedger.get(projectId)
      : undefined;
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

    const result = await attachMaterialToProject({
      materialId,
      ...(typeof rawParams.startSec === "number" ? { startSec: rawParams.startSec } : {}),
      ...(typeof rawParams.endSec === "number" ? { endSec: rawParams.endSec } : {}),
      ...(typeof rawParams.addClip === "boolean" ? { addClip: rawParams.addClip } : {}),
      ...(typeof rawParams.expectedRevision === "number"
        ? { expectedRevision: rawParams.expectedRevision }
        : {}),
      actor: "agent",
    });
    if (!result.ok) {
      return bridgeError({
        code: result.code,
        message: result.message,
        ...(result.details ? { details: result.details } : {}),
      });
    }
    if (idempotencyKey) {
      let ledger = attachLedger.get(projectId);
      if (!ledger) {
        ledger = new Map();
        attachLedger.set(projectId, ledger);
      }
      ledger.set(idempotencyKey, { payload, result: result.value });
      if (ledger.size > 500) {
        const oldest = ledger.keys().next().value;
        if (oldest !== undefined) ledger.delete(oldest);
      }
    }
    window.dispatchEvent(new CustomEvent("reelterminal:preview-invalidate"));
    return { ok: true, result: result.value };
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function patchFromBridge(
  raw: Record<string, unknown>,
): MaterialUpdatePatch {
  return {
    ...(isString(raw.title) ? { title: raw.title } : {}),
    ...(isString(raw.aiSummary) ? { aiSummary: raw.aiSummary } : {}),
    ...(stringArray(raw.tags) ? { tags: stringArray(raw.tags) ?? [] } : {}),
    ...(isString(raw.organizeStatus) && (raw.organizeStatus === "inbox" || raw.organizeStatus === "organized")
      ? { organizeStatus: raw.organizeStatus }
      : {}),
    ...(isString(raw.description) ? { description: raw.description } : {}),
  };
}

function createRequestFromBridge(
  raw: Record<string, unknown>,
): MaterialCreateRequest {
  const fileRef =
    typeof raw.fileRef === "object" && raw.fileRef !== null
      ? (raw.fileRef as MaterialFileRef)
      : undefined;
  const metadata =
    typeof raw.metadata === "object" && raw.metadata !== null
      ? (raw.metadata as MaterialMediaMetadata)
      : undefined;
  return {
    kind: isString(raw.kind)
      ? (raw.kind as MaterialCreateRequest["kind"])
      : ("link" as MaterialCreateRequest["kind"]),
    ...(isString(raw.title) ? { title: raw.title } : {}),
    ...(stringArray(raw.tags) ? { tags: stringArray(raw.tags) ?? [] } : {}),
    ...(isString(raw.organizeStatus) &&
    (raw.organizeStatus === "inbox" || raw.organizeStatus === "organized")
      ? { organizeStatus: raw.organizeStatus }
      : {}),
    ...(isString(raw.aiSummary) ? { aiSummary: raw.aiSummary } : {}),
    ...(isString(raw.origin) ? { origin: raw.origin } : {}),
    ...(isString(raw.url) ? { url: raw.url } : {}),
    ...(isString(raw.description) ? { description: raw.description } : {}),
    ...(isString(raw.parentMaterialId) ? { parentMaterialId: raw.parentMaterialId } : {}),
    ...(typeof raw.startSec === "number" ? { startSec: raw.startSec } : {}),
    ...(typeof raw.endSec === "number" ? { endSec: raw.endSec } : {}),
    ...(isString(raw.skillName) ? { skillName: raw.skillName } : {}),
    ...(isString(raw.prompt) ? { prompt: raw.prompt } : {}),
    ...(stringArray(raw.steps) ? { steps: stringArray(raw.steps) ?? [] } : {}),
    ...(stringArray(raw.inputs) ? { inputs: stringArray(raw.inputs) ?? [] } : {}),
    ...(isString(raw.mediaType)
      ? { mediaType: raw.mediaType as MaterialCreateRequest["mediaType"] }
      : {}),
    ...(fileRef ? { fileRef } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/** Test seam: resolve the service the bridge will use. */
export function materialBridgeService(): MaterialLibraryService {
  return getMaterialLibraryService();
}
