import type { ImageRepairOperation, ImageRepairRegion } from "@reelterminal/core/review/image-repair";
import type { ReviewStep } from "@reelterminal/core/review/types";
import type { WorkbenchContentRevision } from "@reelterminal/core/types/workbench";
import { nextWorkbenchContentVersion } from "@reelterminal/core/actions/workbench-actions";
import { executeImageRepair, validateImageRepairRegion } from "../image-repair";
import { cropResult, currentImage, loadRepairImage, saveCanvas, type ImageSnapshot, type RepairIdentity } from "./repair";
import { requestDigest, reviewError, sameReviewValue, targetGuard } from "./guards";
import { reviewService } from "./service";
import { exportValue } from "./export";

interface DraftIdentity { target: RepairIdentity["target"]; itemId: string; draftId: string }
interface DraftBatch { region: ImageRepairRegion; operations: readonly ImageRepairOperation[]; startedAt: number; finishedAt: number }
interface DraftCanvases { base: HTMLCanvasElement; layer?: HTMLCanvasElement; current: HTMLCanvasElement }
interface RepairDraft {
  identity: RepairIdentity;
  draftId: string;
  snapshot: ImageSnapshot;
  baseId: string;
  revision: number;
  state: "open" | "committed" | "discarded";
  canvases?: DraftCanvases;
  batches: DraftBatch[];
  receipts: Map<string, { digest: string; output: ReturnType<typeof summary> }>;
  committed?: { requestId: string; revision: number; output: Record<string, unknown> };
  preview?: Awaited<ReturnType<typeof cropResult>> & { region: ImageRepairRegion; draftRevision: number };
}

// Runtime identity and this Map have the same renderer lifetime. Never revive a handle
// against a new runtime or infer its target from the GUI selection.
const drafts = new Map<string, RepairDraft>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let previews: readonly RepairDraftPreview[] = [];
export interface RepairDraftPreview extends DraftIdentity {
  draftRevision: number; inspectedRevision: number; itemVersion: number; image: Awaited<ReturnType<typeof cropResult>>; region: ImageRepairRegion;
}
export const subscribeRepairDraftPreviews = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getRepairDraftPreviews = () => previews;
function publishPreviews(): void {
  previews = [...drafts.values()].flatMap(draft => draft.state === "open" && draft.preview ? [{
    target: draft.identity.target, itemId: draft.identity.itemId, draftId: draft.draftId, draftRevision: draft.revision,
    inspectedRevision: draft.preview.draftRevision, itemVersion: draft.identity.expectedItemVersion, image: draft.preview, region: draft.preview.region,
  }] : []);
  for (const listener of listeners) listener();
}

async function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(id);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(id, current);
  await previous;
  try { return await run(); }
  finally { release(); if (pending.get(id) === current) pending.delete(id); }
}

function getDraft(input: DraftIdentity): RepairDraft {
  targetGuard(input.target, true);
  const draft = drafts.get(input.draftId);
  if (!draft) throw reviewError("NOT_FOUND", "Repair draft is absent or expired after renderer restart; create a new draft explicitly");
  if (!sameReviewValue(draft.identity.target, input.target) || draft.identity.itemId !== input.itemId) {
    throw reviewError("CONFLICT", "Repair draft belongs to a different explicit target or image");
  }
  return draft;
}
function openDraft(input: DraftIdentity, expectedRevision?: number): RepairDraft {
  const draft = getDraft(input);
  if (draft.state !== "open") throw reviewError("CONFLICT", `Repair draft is ${draft.state}`);
  if (expectedRevision !== undefined && draft.revision !== expectedRevision) throw reviewError("CONFLICT", `Repair draft is at revision ${draft.revision}`);
  return draft;
}
function summary(draft: RepairDraft, replayed = false) {
  return { target: draft.identity.target, itemId: draft.identity.itemId, draftId: draft.draftId, state: draft.state,
    draftRevision: draft.revision, nodeRevision: draft.identity.expectedNodeRevision, itemVersion: draft.identity.expectedItemVersion,
    batchCount: draft.batches.length, replayed };
}

export async function createImageRepairDraft(input: RepairIdentity & { draftId: string }) {
  return serial(input.draftId, async () => {
    targetGuard(input.target, true);
    const existing = drafts.get(input.draftId);
    if (existing) {
      getDraft(input);
      const { draftId: _id, ...identity } = input;
      if (!sameReviewValue(existing.identity, identity)) throw reviewError("CONFLICT", "draftId was used for another repair baseline");
      return summary(existing, true);
    }
    const snapshot = await currentImage(input);
    const baseId = snapshot.revision?.repairBaseMediaId ?? snapshot.resource.id;
    const [base, layer, current] = await Promise.all([loadRepairImage(baseId),
      snapshot.revision?.repairLayerMediaId ? loadRepairImage(snapshot.revision.repairLayerMediaId) : undefined,
      loadRepairImage(snapshot.resource.id)]);
    await currentImage(input);
    const { draftId, ...identity } = structuredClone(input);
    const draft: RepairDraft = { identity, draftId, snapshot, baseId, revision: 0, state: "open", canvases: { base, layer, current }, batches: [], receipts: new Map() };
    drafts.set(draftId, draft);
    return summary(draft);
  });
}

export async function applyImageRepairDraft(input: DraftIdentity & { requestId: string; expectedDraftRevision: number; region: ImageRepairRegion; operations: readonly ImageRepairOperation[] }) {
  return serial(input.draftId, async () => {
    const draft = getDraft(input);
    const digest = await requestDigest(input);
    const prior = draft.receipts.get(input.requestId);
    if (prior) {
      if (prior.digest !== digest) throw reviewError("CONFLICT", "requestId was used for a different draft batch");
      return { ...prior.output, replayed: true };
    }
    openDraft(input, input.expectedDraftRevision);
    const startedAt = Date.now();
    const patches = new Map<string, CanvasImageSource>();
    const retainedPatches = new Set([...draft.batches.flatMap(batch => batch.operations), ...input.operations]
      .flatMap(operation => operation.kind === "patch" ? [operation.resourceId] : []));
    if (retainedPatches.size > 62) throw reviewError("INVALID_PARAMS", "A repair draft supports at most 62 distinct patch resources within the processing record's 64-input limit");
    for (const resourceId of new Set(input.operations.flatMap(operation => operation.kind === "patch" ? [operation.resourceId] : []))) {
      await reviewService.freezeExport({ target: draft.identity.target, expectedNodeRevision: draft.identity.expectedNodeRevision,
        exportId: crypto.randomUUID(), mode: "version", scope: "selected", reference: { resourceId, role: "patch" } });
      const [resource] = await reviewService.getResources([resourceId]);
      if (resource.metadata?.type !== "image") throw reviewError("INVALID_PARAMS", "Patch resource must be an image retained by this node");
      patches.set(resourceId, await loadRepairImage(resourceId));
    }
    // executeImageRepair paints disposable copies. Publish only after the entire batch succeeds.
    const rendered = executeImageRepair({ ...draft.canvases!, region: input.region, operations: input.operations, patches });
    if (!rendered.changedRegion) throw reviewError("INVALID_PARAMS", "Repair batch changes no visible pixels");
    draft.canvases = { base: draft.canvases!.base, layer: rendered.layer, current: rendered.composite };
    draft.batches.push({ region: structuredClone(input.region), operations: structuredClone(input.operations), startedAt, finishedAt: Date.now() });
    draft.revision++;
    const output = summary(draft);
    draft.receipts.set(input.requestId, { digest, output });
    publishPreviews();
    return output;
  });
}

export async function inspectImageRepairDraft(input: DraftIdentity & { region: ImageRepairRegion }) {
  return serial(input.draftId, async () => {
    const draft = openDraft(input);
    const canvas = draft.canvases!.current;
    validateImageRepairRegion(input.region, canvas.width, canvas.height);
    if (!draft.preview || draft.preview.draftRevision !== draft.revision || !sameReviewValue(draft.preview.region, input.region)) {
      draft.preview = { ...await cropResult(canvas, input.region, crypto.randomUUID()), region: structuredClone(input.region), draftRevision: draft.revision };
    }
    publishPreviews();
    return { ...summary(draft), unsaved: true, region: input.region, image: draft.preview,
      mapping: { space: "source-pixels", cropOrigin: { x: input.region.x, y: input.region.y }, scale: 1, sourceWidth: canvas.width, sourceHeight: canvas.height } };
  });
}

export async function commitImageRepairDraft(input: DraftIdentity & { requestId: string; expectedDraftRevision: number }) {
  return serial(input.draftId, async () => {
    // The durable receipt outlives the in-memory draft. A restarted renderer can
    // return it after the caller explicitly discovers and supplies its new runtime.
    const receipt = await reviewService.getCommitReceipt(input.target, input.requestId);
    if (receipt) {
      const output = receipt.output;
      if (output?.state !== "committed" || output.draftId !== input.draftId || output.itemId !== input.itemId || output.draftRevision !== input.expectedDraftRevision) {
        throw reviewError("CONFLICT", "requestId was used for a different review request");
      }
      return { ...output, target: input.target, nodeRevision: receipt.revision, replayed: true };
    }
    const draft = getDraft(input);
    if (draft.committed) {
      if (draft.committed.requestId !== input.requestId || draft.committed.revision !== input.expectedDraftRevision) throw reviewError("CONFLICT", "Repair draft was already committed with another request");
      return { ...draft.committed.output, replayed: true };
    }
    openDraft(input, input.expectedDraftRevision);
    if (!draft.batches.length) throw reviewError("INVALID_PARAMS", "Apply a visible repair before committing the draft");
    const identity = draft.identity;
    const canvas = draft.canvases!;
    const resultRegion = draft.preview?.region ?? draft.batches.at(-1)!.region;
    let composite!: Awaited<ReturnType<typeof saveCanvas>>;
    let layer!: Awaited<ReturnType<typeof saveCanvas>>;
    let image!: Awaited<ReturnType<typeof cropResult>>;
    const patchIds = [...new Set(draft.batches.flatMap(batch => batch.operations.flatMap(operation => operation.kind === "patch" ? [operation.resourceId] : [])))];
    const result = await reviewService.commit({ target: identity.target, expectedNodeRevision: identity.expectedNodeRevision, requestId: input.requestId,
      actor: "agent", label: "Agent image repair draft", readScope: { itemIds: [identity.itemId] },
      request: { kind: "review.repair.draft.commit", draftId: input.draftId, draftRevision: draft.revision, itemId: identity.itemId,
        expectedItemVersion: identity.expectedItemVersion, batches: draft.batches },
      prepareResources: async () => {
        await currentImage(identity);
        composite = await saveCanvas(canvas.current, input.requestId, "repaired-image.png");
        layer = await saveCanvas(canvas.layer!, input.requestId, "repair-layer.png");
        image = await cropResult(canvas.current, resultRegion, input.requestId);
        return [composite, layer, exportValue(await window.reelterminal!.reviewFiles!.resolve(image.resourceId, true)).resource];
      },
      build: state => {
        const item = state.items.find(item => item.id === identity.itemId)!;
        if (item.version !== identity.expectedItemVersion) throw reviewError("CONFLICT", "Image version changed before draft commit");
        const previous = draft.snapshot.revision;
        const revision: WorkbenchContentRevision = { id: crypto.randomUUID(), itemId: item.id, parentVersion: item.version,
          producedVersion: nextWorkbenchContentVersion(item), createdAt: Date.now(), kind: "image-repair", mediaId: composite.id,
          repairLayerMediaId: layer.id, repairBaseMediaId: draft.baseId,
          base: previous?.repairBaseMediaId ? previous.base : previous ? { kind: "revision", revisionId: previous.id } : { kind: "source" },
          strokes: draft.batches.flatMap(batch => batch.operations.flatMap(operation => operation.kind === "brush" || operation.kind === "eraser" ? [{
            id: crypto.randomUUID(), tool: operation.kind, color: operation.kind === "brush" ? operation.color : "#000000", size: operation.size, points: operation.points,
          }] : [])),
        };
        return [{ type: "workbench/content.update", id: crypto.randomUUID(), timestamp: Date.now(), params: { revision } }];
      },
      buildSteps: (_before, after): ReviewStep[] => [{ id: crypto.randomUUID(), runId: input.requestId, nodeId: identity.target.nodeId!,
        label: "Canvas 2D image repair draft", actor: "agent", state: "completed", startedAt: draft.batches[0].startedAt, finishedAt: Date.now(),
        method: { kind: "algorithm", name: "Canvas 2D image repair", verification: "measured" },
        parameters: { draftId: draft.draftId, batchCount: draft.batches.length,
          operationCounts: draft.batches.reduce((counts, batch) => {
            for (const operation of batch.operations) counts[operation.kind]++;
            return counts;
          }, { brush: 0, eraser: 0, clone: 0, patch: 0 }), cloneSampling: "frozen-batch-start-composite" },
        inputs: [{ nodeId: identity.target.nodeId!, itemId: identity.itemId, version: identity.expectedItemVersion, role: "working-source" },
          { resourceId: draft.baseId, role: "repair-base" }, ...patchIds.map(resourceId => ({ resourceId, role: "patch" }))],
        outputs: [{ nodeId: identity.target.nodeId!, itemId: identity.itemId, version: after.items.find(item => item.id === identity.itemId)!.version, role: "result" },
          { resourceId: layer.id, role: "transparent-repair-layer" }, { resourceId: image.resourceId, role: "result-region" }],
        mapping: { kind: "image-bounds", inputIndex: 0, outputIndex: 0 },
      }],
      output: after => ({ itemId: identity.itemId, itemVersion: after.items.find(item => item.id === identity.itemId)!.version,
        draftId: draft.draftId, draftRevision: draft.revision, batchCount: draft.batches.length, state: "committed", region: resultRegion, image }),
    });
    const output = { ...result.output, target: identity.target, nodeRevision: result.revision, replayed: result.replayed };
    draft.committed = { requestId: input.requestId, revision: input.expectedDraftRevision, output };
    draft.state = "committed";
    draft.canvases = undefined;
    draft.preview = undefined;
    publishPreviews();
    return output;
  });
}

export async function discardImageRepairDraft(input: DraftIdentity) {
  return serial(input.draftId, async () => {
    const draft = getDraft(input);
    if (draft.state === "committed") throw reviewError("CONFLICT", "Committed repair drafts cannot be discarded; use formal history explicitly");
    const replayed = draft.state === "discarded";
    draft.state = "discarded";
    draft.canvases = undefined;
    draft.preview = undefined;
    publishPreviews();
    return summary(draft, replayed);
  });
}
