import { reviewCandidateActions } from "@reelterminal/core/types/review-range";
import { useProjectStore } from "../stores/project-store";

/** The only GUI adoption path: verify actual source files, then recheck the project. */
export async function adoptReviewCandidate(
  requirementId: string,
  candidateMediaId: string,
  label: string,
): Promise<void> {
  const api = (window.reelterminal ?? window.openreel)?.production;
  if (!api)
    throw new Error(
      "Strict candidate adoption requires the desktop FFprobe backend",
    );
  const before = useProjectStore.getState();
  const requirement = before.project.requirements?.items.find(
    (item) => item.id === requirementId,
  );
  const sourceIds = new Set(
    requirement?.reviewRange?.mappings.map((mapping) => mapping.mediaId),
  );
  if (sourceIds.size !== 1)
    throw new Error(
      "Direct adoption requires a single reviewed source version",
    );
  const verified = await api.verifyReplacement({
    projectId: before.project.id,
    expectedRevision: before.projectRevision,
    sourceMediaId: [...sourceIds][0],
    candidateMediaId,
  });
  const current = useProjectStore.getState();
  if (
    current.project.id !== before.project.id ||
    current.projectRevision !== before.projectRevision ||
    current.project !== before.project
  )
    throw new Error(
      "Project changed during strict candidate verification; review again",
    );
  const actions = reviewCandidateActions(
    current.project,
    requirementId,
    candidateMediaId,
    verified.durationSec,
  );
  const outcome = current.executeActionBatch(actions, {
    groupLabel: label,
    historyOwner: "user",
  });
  if (!outcome.result.success)
    throw new Error(
      outcome.result.error?.message ?? "Candidate adoption failed",
    );
}
