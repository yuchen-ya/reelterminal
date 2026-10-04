import type { Project } from "./project";
import type { ReferenceComparisonConfig } from "./reference-comparison";
import type { Action } from "./actions";

export interface ReviewRange {
  readonly coordinateSpace: "timeline";
  readonly startFrame: number;
  readonly endFrame: number;
  readonly frameRate: number;
  readonly projectModifiedAt: number;
  readonly comparison?: ReferenceComparisonConfig;
  /** Exact rendered timeline frame/revision; absent on legacy preview captures. */
  readonly evidence?: {
    readonly projectId: string;
    readonly sourceRevision: number;
    readonly timelineFrame: number;
    readonly timeSec: number;
    readonly artifactPath: string;
  };
  /** Embedded review image. Legacy records may contain an unbound preview. */
  readonly screenshot?: string;
  readonly mappings: readonly {
    readonly clipId: string;
    readonly mediaId: string;
    readonly timelineStartSec: number;
    readonly timelineEndSec: number;
    readonly sourceStartSec: number;
    readonly sourceEndSec: number;
  }[];
}

export function createReviewRange(
  project: Project,
  startFrame: number,
  endFrame: number,
  screenshot?: string,
): ReviewRange {
  const fps = project.settings.frameRate;
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0 ||
    endFrame <= startFrame ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    endFrame > Math.ceil(project.timeline.duration * fps)
  )
    throw new Error(
      "Select a nonempty timeline frame range within the project",
    );
  const start = startFrame / fps;
  const end = endFrame / fps;
  const clips = project.timeline.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip) => clip.startTime < end && clip.startTime + clip.duration > start,
    );
  if (
    clips.some(
      (clip) =>
        clip.reversed ||
        clip.speedKeyframes?.length ||
        clip.freezeFrames?.length,
    )
  )
    throw new Error(
      "Review source mapping currently requires forward, constant-speed clips",
    );
  return {
    coordinateSpace: "timeline",
    startFrame,
    endFrame,
    frameRate: fps,
    projectModifiedAt: project.modifiedAt,
    ...(project.referenceComparison
      ? { comparison: structuredClone(project.referenceComparison) }
      : {}),
    ...(screenshot ? { screenshot } : {}),
    mappings: clips.map((clip) => {
      const timelineStartSec = Math.max(start, clip.startTime);
      const timelineEndSec = Math.min(end, clip.startTime + clip.duration);
      return {
        clipId: clip.id,
        mediaId: clip.mediaId,
        timelineStartSec,
        timelineEndSec,
        sourceStartSec:
          clip.inPoint +
          (timelineStartSec - clip.startTime) * (clip.speed ?? 1),
        sourceEndSec:
          clip.inPoint + (timelineEndSec - clip.startTime) * (clip.speed ?? 1),
      };
    }),
  };
}

export function validReviewRange(value: ReviewRange): boolean {
  return (
    !!value &&
    value.coordinateSpace === "timeline" &&
    Number.isSafeInteger(value.startFrame) &&
    value.startFrame >= 0 &&
    Number.isSafeInteger(value.endFrame) &&
    value.endFrame > value.startFrame &&
    Number.isFinite(value.frameRate) &&
    value.frameRate > 0 &&
    Number.isFinite(value.projectModifiedAt) &&
    (value.screenshot === undefined ||
      (typeof value.screenshot === "string" &&
        value.screenshot.length <= 1_400_000 &&
        /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(
          value.screenshot,
        ))) &&
    (value.evidence === undefined ||
      (!!value.evidence &&
        typeof value.evidence.projectId === "string" &&
        value.evidence.projectId.length > 0 &&
        Number.isSafeInteger(value.evidence.sourceRevision) &&
        value.evidence.sourceRevision >= 0 &&
        Number.isSafeInteger(value.evidence.timelineFrame) &&
        value.evidence.timelineFrame >= value.startFrame &&
        value.evidence.timelineFrame < value.endFrame &&
        Number.isFinite(value.evidence.timeSec) &&
        Math.abs(
          value.evidence.timeSec -
            value.evidence.timelineFrame / value.frameRate,
        ) < 1e-9 &&
        typeof value.evidence.artifactPath === "string" &&
        value.evidence.artifactPath.length > 0 &&
        typeof value.screenshot === "string")) &&
    Array.isArray(value.mappings) &&
    value.mappings.length <= 1000 &&
    value.mappings.every(
      (mapping) =>
        mapping &&
        typeof mapping.clipId === "string" &&
        typeof mapping.mediaId === "string" &&
        [
          mapping.timelineStartSec,
          mapping.timelineEndSec,
          mapping.sourceStartSec,
          mapping.sourceEndSec,
        ].every((time) => Number.isFinite(time) && time >= 0) &&
        mapping.timelineEndSec > mapping.timelineStartSec &&
        mapping.sourceEndSec > mapping.sourceStartSec,
    )
  );
}

/** Adopt an already imported, full-source candidate in one existing undo batch. */
export function reviewCandidateActions(
  project: Project,
  requirementId: string,
  mediaId: string,
  verifiedDuration: number,
): Action[] {
  if (!Number.isFinite(verifiedDuration) || verifiedDuration <= 0)
    throw new Error("Strict frame verification is required before adoption");
  const requirement = project.requirements?.items.find(
    (item) => item.id === requirementId,
  );
  const review = requirement?.reviewRange;
  const candidate = project.mediaLibrary.items.find(
    (item) => item.id === mediaId,
  );
  if (
    !review ||
    !candidate ||
    candidate.type !== "video" ||
    !requirement?.resultMediaIds?.includes(mediaId)
  )
    throw new Error("Choose a video candidate attached to this review task");
  const current = createReviewRange(
    project,
    review.startFrame,
    review.endFrame,
  );
  if (
    current.frameRate !== review.frameRate ||
    JSON.stringify(current.mappings) !== JSON.stringify(review.mappings)
  )
    throw new Error(
      "Reviewed clips changed; create a fresh review before adopting",
    );
  const sourceIds = new Set(review.mappings.map((mapping) => mapping.mediaId));
  if (sourceIds.size !== 1 || sourceIds.has(mediaId))
    throw new Error(
      "Direct adoption requires one source version and a different candidate",
    );
  const clipIds = new Set(review.mappings.map((mapping) => mapping.clipId));
  const clips = project.timeline.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clipIds.has(clip.id));
  if (clips.some((clip) => clip.outPoint > verifiedDuration + 1e-6))
    throw new Error(
      "Candidate is too short for the reviewed clips; import a full-source replacement",
    );
  const action = (type: Action["type"], params: Action["params"]): Action =>
    ({
      type,
      params,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    }) as Action;
  return [
    ...clips.map((clip) =>
      action("clip/repointSource", {
        clipId: clip.id,
        mediaId,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        duration: clip.duration,
        supersedesMediaId: clip.mediaId,
      }),
    ),
    action("media/setProduction", {
      mediaId,
      production: {
        ...(candidate.production ?? { notes: "", steps: [] }),
        status: "adopted",
      },
    }),
    action("requirement/update", { requirementId, patch: { status: "done" } }),
  ];
}
