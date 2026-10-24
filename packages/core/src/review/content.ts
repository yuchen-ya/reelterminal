import type { WorkbenchItemContent } from "../types/workbench";

/** Presentation annotations do not replace an immutable content body. */
export function splitReviewContent(content: WorkbenchItemContent): { body: WorkbenchItemContent; presentation: Partial<WorkbenchItemContent> } {
  if (content.type === "image") return { body: { ...content, annotations: [], strokes: [] }, presentation: { annotations: content.annotations, strokes: content.strokes } };
  if (content.type === "video") return { body: { ...content, markers: [] }, presentation: { markers: content.markers } };
  if (content.type === "text") {
    const { duplicateProposal, ...body } = content;
    return { body, presentation: duplicateProposal ? { duplicateProposal } : {} };
  }
  return { body: content, presentation: {} };
}

/** Observation attachments in frozen history must travel with node packages too. */
export function reviewObservationResources(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return ids;
  const object = value as Record<string, unknown>;
  if (object.kind === "model-view") for (const key of ["resourceId", "screenshotResourceId"]) if (typeof object[key] === "string") ids.add(object[key]);
  for (const entry of Object.values(object)) if (entry && typeof entry === "object") reviewObservationResources(entry, ids);
  return ids;
}
