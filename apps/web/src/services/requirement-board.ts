import type { RequirementReference } from "@reelterminal/core";
import { useProjectStore } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import { useTimelineStore } from "../stores/timeline-store";
import { getAgentReferenceTargetsForProject } from "../stores/agent-reference-targets";
import { markAgentReferences } from "../stores/editor-context-store";

export function openBoardForEntities(entityIds: readonly string[]): void {
  const { project } = useProjectStore.getState();
  const targets = getAgentReferenceTargetsForProject(project).filter((target) =>
    entityIds.includes(target.entityId),
  );
  const references = markAgentReferences(targets);
  useUIStore.getState().openModal("requirement-board", {
    referenceIds: references.map((reference) => reference.entityId),
  });
}

export function locateRequirementReference(
  reference: RequirementReference,
): boolean {
  const { project } = useProjectStore.getState();
  const target = getAgentReferenceTargetsForProject(project).find(
    (item) =>
      item.entityId === reference.entityId && item.kind === reference.kind,
  );
  if (!target) return false;
  if (target.kind === "workAsset") {
    useUIStore.getState().closeModal();
    window.dispatchEvent(
      new CustomEvent("reelterminal:live-reveal-media", {
        detail: { id: target.entityId, workAsset: true },
      }),
    );
    return true;
  }
  const media = project.mediaLibrary.items.find(
    (item) => item.id === target.entityId,
  );
  const text = project.textClips?.find((item) => item.id === target.entityId);
  const track = project.timeline.tracks.find((item) =>
    item.clips.some((clip) => clip.id === target.entityId),
  );
  useUIStore.getState().select({
    id: target.entityId,
    type: media ? "media" : text ? "text-clip" : track ? "clip" : "shape-clip",
    trackId: track?.id ?? text?.trackId,
  });
  if (target.timing.startSeconds !== null)
    useTimelineStore.getState().seekTo(target.timing.startSeconds);
  useUIStore.getState().closeModal();
  if (media)
    window.dispatchEvent(
      new CustomEvent("reelterminal:live-reveal-media", {
        detail: { id: media.id },
      }),
    );
  return true;
}
