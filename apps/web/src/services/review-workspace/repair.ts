import type { ImageRepairOperation, ImageRepairRegion } from "@reelterminal/core/review/image-repair";
import type { FileResource, ReviewContext, ReviewStep } from "@reelterminal/core/review/types";
import { nextWorkbenchContentVersion } from "@reelterminal/core/actions/workbench-actions";
import type { WorkbenchContentRevision, WorkbenchItem, WorkbenchSpatialAnnotation } from "@reelterminal/core/types/workbench";
import { canvasToPngBlob, createImageCanvas, executeImageRepair, validateImageRepairRegion } from "../image-repair";
import { reviewService } from "./service";
import { reviewError, requestDigest, sameReviewValue } from "./guards";
import { exportValue } from "./export";
import { prepareReviewBlob } from "./files";

type Target = ReviewContext["target"];
export interface RepairBaseline {
  target: Target;
  itemId: string;
  itemVersion: number;
  nodeRevision: number;
  region: ImageRepairRegion;
  resourceId: string;
  imageSha256: string;
  annotationsSha256: string;
}
export interface RepairIdentity {
  target: Target;
  expectedNodeRevision: number;
  itemId: string;
  expectedItemVersion: number;
}
export interface ImageSnapshot {
  item: WorkbenchItem;
  resource: FileResource;
  revision?: WorkbenchContentRevision;
  nodeRevision: number;
}

export async function currentImage(input: RepairIdentity): Promise<ImageSnapshot> {
  const { node, item } = await reviewService.getItem(input.target, input.itemId);
  if (node.revision !== input.expectedNodeRevision || item.version !== input.expectedItemVersion) {
    throw reviewError("CONFLICT", "Review node or image version changed; inspect the explicit target again");
  }
  if (item.content.type !== "image") {
    throw reviewError("UNSUPPORTED", "Image repair requires an image item; capture an exact video frame first");
  }
  const revision = item.revisions.find(entry => entry.producedVersion === item.version);
  const [resource] = await reviewService.getResources([revision?.mediaId ?? item.content.mediaId]);
  return { item, resource, revision, nodeRevision: node.revision };
}

export async function loadRepairImage(resourceId: string): Promise<HTMLCanvasElement> {
  const native = window.reelterminal?.reviewFiles;
  if (!native) {
    throw reviewError("UNSUPPORTED", "Native review media is unavailable");
  }
  exportValue(await native.resolve(resourceId, true));
  const image = new Image();
  image.src = `app://reelterminal/review-media/${resourceId}`;
  await image.decode();
  const canvas = createImageCanvas(image.naturalWidth, image.naturalHeight);
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas;
}

export async function saveCanvas(canvas: HTMLCanvasElement, operationId: string, name: string): Promise<FileResource> {
  return prepareReviewBlob(await canvasToPngBlob(canvas), name, operationId, crypto.randomUUID(), "agent", undefined, true);
}

export async function cropResult(canvas: HTMLCanvasElement, region: ImageRepairRegion, operationId: string) {
  const crop = createImageCanvas(region.width, region.height);
  crop.getContext("2d")!.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  const resource = await saveCanvas(crop, operationId, "repair-region.png");
  const resolved = exportValue(await window.reelterminal!.reviewFiles!.resolve(resource.id, true));
  return { path: resolved.path, mime: "image/png", width: region.width, height: region.height, resourceId: resource.id };
}

function intersectingAnnotations(annotations: readonly WorkbenchSpatialAnnotation[], region: ImageRepairRegion, width: number, height: number) {
  return annotations.filter(annotation => {
    const x = annotation.x * width;
    const y = annotation.y * height;
    const otherX = annotation.tool === "box" ? x + (annotation.w ?? 0) * width : (annotation.endX ?? annotation.x) * width;
    const otherY = annotation.tool === "box" ? y + (annotation.h ?? 0) * height : (annotation.endY ?? annotation.y) * height;
    return Math.max(x, otherX) >= region.x && Math.min(x, otherX) <= region.x + region.width &&
      Math.max(y, otherY) >= region.y && Math.min(y, otherY) <= region.y + region.height;
  });
}

async function publishedRegionFeedback(input: RepairIdentity & { handoffId?: string; limit?: number; cursor?: string; region: ImageRepairRegion }, width: number, height: number) {
  if (!input.handoffId) {
    if (input.cursor) {
      throw reviewError("INVALID_PARAMS", "Feedback pagination requires an explicit handoffId");
    }
    return { feedback: [], feedbackHasMore: false };
  }
  const { handoff } = await reviewService.getHandoff(input.target, input.handoffId);
  if (handoff.historicalOnly) {
    throw reviewError("CONFLICT", "Historical handoffs are evidence, not an active image repair context");
  }
  const published = handoff.items.find(item => item.itemId === input.itemId && item.itemVersion === input.expectedItemVersion);
  if (!published) {
    throw reviewError("CONFLICT", "The published handoff does not contain this exact image version");
  }
  const issues = (published.issues ?? []).filter(issue => {
    const target = issue.target;
    if (target.kind !== "pixel-region") return false;
    const left = target.x * width;
    const top = target.y * height;
    return left + (target.w ?? 0) * width >= input.region.x && left <= input.region.x + input.region.width &&
      top + (target.h ?? 0) * height >= input.region.y && top <= input.region.y + input.region.height;
  });
  const scope = await requestDigest({ nodeId: input.target.nodeId, handoffId: input.handoffId, itemId: input.itemId,
    itemVersion: input.expectedItemVersion, region: input.region });
  let offset = 0;
  if (input.cursor) {
    const parts = input.cursor.split(":");
    const [prefix, cursorScope, index] = parts;
    if (parts.length !== 3 || prefix !== "feedback" || cursorScope !== scope || !/^\d+$/.test(index ?? "") || !Number.isSafeInteger(Number(index))) {
      throw reviewError("INVALID_PARAMS", "Feedback cursor belongs to another snapshot, item or region");
    }
    offset = Number(index);
    if (offset > issues.length) {
      throw reviewError("INVALID_PARAMS", "Feedback cursor is outside this snapshot");
    }
  }
  const limit = input.limit ?? 100;
  const feedback = issues.slice(offset, offset + limit).map(issue => ({ id: issue.feedbackId, issueId: issue.issueId,
    itemVersion: issue.itemVersion, text: issue.text.slice(0, 1000), textTruncated: issue.text.length > 1000, target: issue.target, intent: issue.intent }));
  const feedbackHasMore = offset + feedback.length < issues.length;
  return { feedbackSource: { handoffId: input.handoffId, itemVersion: published.itemVersion, publishedAt: handoff.publishedAt }, feedback, feedbackHasMore,
    ...(feedbackHasMore ? { feedbackCursor: `feedback:${scope}:${offset + feedback.length}` } : {}) };
}

export async function inspectImageRepair(input: RepairIdentity & { region: ImageRepairRegion; baseline?: RepairBaseline; handoffId?: string; limit?: number; cursor?: string }) {
  const snapshot = await currentImage(input);
  const { resource, item, revision } = snapshot;
  const facts = resource.metadata;
  if (!facts || facts.type !== "image") {
    throw reviewError("UNSUPPORTED", "Verified image metadata is required");
  }
  exportValue(await window.reelterminal!.reviewFiles!.resolve(resource.id, true));
  validateImageRepairRegion(input.region, facts.width, facts.height);
  const annotations = intersectingAnnotations(item.content.type === "image" ? item.content.annotations : [], input.region, facts.width, facts.height);
  const publishedFeedback = await publishedRegionFeedback(input, facts.width, facts.height);
  const baseline: RepairBaseline = { target: input.target, itemId: item.id, itemVersion: item.version, nodeRevision: snapshot.nodeRevision,
    region: input.region, resourceId: resource.id, imageSha256: resource.sha256!, annotationsSha256: await requestDigest({ annotations, ...publishedFeedback }) };
  const prior = input.baseline;
  const matchingScope = prior && sameReviewValue(prior.target, input.target) && prior.itemId === item.id && sameReviewValue(prior.region, input.region);
  const sameImage = matchingScope && prior.resourceId === resource.id && prior.imageSha256 === baseline.imageSha256 && prior.itemVersion === item.version;
  const unchanged = sameImage && prior?.annotationsSha256 === baseline.annotationsSha256;
  const image = sameImage ? undefined : await cropResult(await loadRepairImage(resource.id), input.region, crypto.randomUUID());
  // Metadata is a snapshot: detect races while native image decoding/export was in flight.
  await currentImage(input);
  return { target: input.target, nodeRevision: snapshot.nodeRevision, itemId: item.id, itemVersion: item.version,
    state: !prior ? "initial" : unchanged ? "unchanged" : "refresh", region: input.region,
    mapping: { space: "source-pixels", cropOrigin: { x: input.region.x, y: input.region.y }, scale: 1, sourceWidth: facts.width, sourceHeight: facts.height },
    annotations, ...publishedFeedback, baseline, ...(image ? { image } : {}),
    repairLayer: revision?.repairLayerMediaId ? "retained" : "new-layer-over-current-image",
    limitations: ["Baseline is a client conditional-read token, not proof of visual observation or repair quality. It applies only to this exact image and region; replaced content refreshes the complete crop."] };
}

export async function applyImageRepair(input: RepairIdentity & { requestId: string; region: ImageRepairRegion; operations: readonly ImageRepairOperation[] }) {
  let prepared: {
    snapshot: ImageSnapshot;
    baseId: string;
    composite: FileResource;
    layer: FileResource;
    image: Awaited<ReturnType<typeof cropResult>>;
    changedRegion: ImageRepairRegion | null;
    startedAt: number;
  };
  const patchIds = [...new Set(input.operations.flatMap(operation => operation.kind === "patch" ? [operation.resourceId] : []))];
  const result = await reviewService.commit({ target: input.target, expectedNodeRevision: input.expectedNodeRevision, requestId: input.requestId,
    actor: "agent", label: "Agent image repair", request: { kind: "review.repair.apply", itemId: input.itemId, expectedItemVersion: input.expectedItemVersion, region: input.region, operations: input.operations }, readScope: { itemIds: [input.itemId] },
    prepareResources: async () => {
      const startedAt = Date.now();
      const snapshot = await currentImage(input);
      const baseId = snapshot.revision?.repairBaseMediaId ?? snapshot.resource.id;
      const [base, layer, current] = await Promise.all([loadRepairImage(baseId), snapshot.revision?.repairLayerMediaId ? loadRepairImage(snapshot.revision.repairLayerMediaId) : undefined,
        snapshot.resource.id === baseId ? undefined : loadRepairImage(snapshot.resource.id)]);
      validateImageRepairRegion(input.region, base.width, base.height);
      const patches = new Map<string, CanvasImageSource>();
      for (const resourceId of patchIds) {
        await reviewService.freezeExport({ target: input.target, expectedNodeRevision: input.expectedNodeRevision, exportId: crypto.randomUUID(), mode: "version", scope: "selected", reference: { resourceId, role: "patch" } });
        const [resource] = await reviewService.getResources([resourceId]);
        if (resource.metadata?.type !== "image") {
          throw reviewError("INVALID_PARAMS", "Patch resource must be an image retained by this node");
        }
        patches.set(resourceId, await loadRepairImage(resourceId));
      }
      const rendered = executeImageRepair({ base, layer, current, region: input.region, operations: input.operations, patches });
      if (!rendered.changedRegion) {
        throw reviewError("INVALID_PARAMS", "Repair batch changes no visible pixels");
      }
      const composite = await saveCanvas(rendered.composite, input.requestId, "repaired-image.png");
      const nextLayer = await saveCanvas(rendered.layer, input.requestId, "repair-layer.png");
      const image = await cropResult(rendered.composite, input.region, input.requestId);
      prepared = { snapshot, baseId, composite, layer: nextLayer, image, changedRegion: rendered.changedRegion, startedAt };
      const cropResource = exportValue(await window.reelterminal!.reviewFiles!.resolve(image.resourceId, true)).resource;
      return [composite, nextLayer, cropResource];
    },
    build: state => {
      const item = state.items.find(item => item.id === input.itemId)!;
      if (item.version !== input.expectedItemVersion) {
        throw reviewError("CONFLICT", "Image version changed before repair commit");
      }
      const previous = prepared.snapshot.revision;
      const revision: WorkbenchContentRevision = { id: crypto.randomUUID(), itemId: item.id, parentVersion: item.version,
        producedVersion: nextWorkbenchContentVersion(item), createdAt: Date.now(), kind: "image-repair", mediaId: prepared.composite.id,
        repairLayerMediaId: prepared.layer.id, repairBaseMediaId: prepared.baseId,
        base: previous?.repairBaseMediaId ? previous.base : previous ? { kind: "revision", revisionId: previous.id } : { kind: "source" },
        strokes: input.operations.flatMap(operation => operation.kind === "brush" || operation.kind === "eraser" ? [{ id: crypto.randomUUID(), tool: operation.kind, color: operation.kind === "brush" ? operation.color : "#000000", size: operation.size, points: operation.points }] : []),
      };
      return [{ type: "workbench/content.update", id: crypto.randomUUID(), timestamp: Date.now(), params: { revision } }];
    },
    buildSteps: (_before, after): ReviewStep[] => [{ id: crypto.randomUUID(), runId: input.requestId, nodeId: input.target.nodeId!,
      label: "Canvas 2D image repair", actor: "agent", state: "completed", startedAt: prepared.startedAt, finishedAt: Date.now(),
      method: { kind: "algorithm", name: "Canvas 2D image repair", verification: "measured" },
      parameters: { region: { ...input.region }, operations: input.operations.map(operation => operation.kind), cloneSampling: "frozen-batch-start-composite" },
      inputs: [{ nodeId: input.target.nodeId!, itemId: input.itemId, version: input.expectedItemVersion, role: "working-source" }, { resourceId: prepared.baseId, role: "repair-base" }, ...patchIds.map(resourceId => ({ resourceId, role: "patch" }))],
      outputs: [{ nodeId: input.target.nodeId!, itemId: input.itemId, version: after.items.find(item => item.id === input.itemId)!.version, role: "result" }, { resourceId: prepared.layer.id, role: "transparent-repair-layer" }, { resourceId: prepared.image.resourceId, role: "result-region" }],
      mapping: { kind: "image-bounds", inputIndex: 0, outputIndex: 0 },
    }],
    output: after => ({ itemId: input.itemId, itemVersion: after.items.find(item => item.id === input.itemId)!.version, changedRegion: prepared.changedRegion, region: input.region, image: prepared.image }),
  });
  return { ...result.output, target: input.target, nodeRevision: result.revision, replayed: result.replayed };
}
