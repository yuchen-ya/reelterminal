import type { Project } from "@reelterminal/core/types/project";
import { stableStringify } from "./idempotency";
import { FacadeError } from "./errors";
import type {
  ProjectChange,
  ProjectChangesParams,
  ProjectChangesResult,
} from "./types";

/** One renderer/session-local bounded journal. It is deliberately not persisted. */
export const MAX_RETAINED_CHANGE_REVISIONS = 256;
export const DEFAULT_PROJECT_CHANGES_LIMIT = 50;
export const MAX_PROJECT_CHANGES_LIMIT = 200;

interface RevisionChanges {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly changes: readonly ProjectChange[];
}

type EntitySnapshot = Readonly<Record<string, unknown>>;

interface IndexedEntity {
  readonly entityType: ProjectChange["entityType"];
  readonly entityId: string;
  readonly value: EntitySnapshot;
}

function indexProject(project: Project): Map<string, IndexedEntity> {
  const index = new Map<string, IndexedEntity>();
  const put = (
    entityType: ProjectChange["entityType"],
    entityId: string,
    value: EntitySnapshot,
  ): void => {
    index.set(`${entityType}:${entityId}`, { entityType, entityId, value });
  };

  put("project", project.id, {
    name: project.name,
    settings: project.settings,
    modifiedAt: project.modifiedAt,
  });
  for (const [trackIndex, track] of project.timeline.tracks.entries()) {
    put("track", track.id, {
      type: track.type,
      name: track.name,
      index: trackIndex,
      locked: track.locked,
      hidden: track.hidden,
      muted: track.muted,
      solo: track.solo,
    });
    for (const clip of track.clips) {
      put("clip", clip.id, {
        trackId: clip.trackId,
        mediaId: clip.mediaId,
        startTime: clip.startTime,
        duration: clip.duration,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        volume: clip.volume,
        speed: clip.speed,
        reversed: clip.reversed,
        fade: clip.fade,
        transform: clip.transform,
        keyframes: clip.keyframes,
        automation: clip.automation,
        colorGrading: clip.colorGrading,
      });
    }
    for (const transition of track.transitions ?? []) {
      put("transition", transition.id, {
        trackId: track.id,
        clipAId: transition.clipAId,
        clipBId: transition.clipBId,
        edge: transition.edge,
        type: transition.type,
        duration: transition.duration,
        params: transition.params,
      });
    }
  }
  for (const text of project.textClips ?? []) {
    put("text", text.id, {
      trackId: text.trackId,
      text: text.text,
      startTime: text.startTime,
      duration: text.duration,
      style: text.style,
      transform: text.transform,
      keyframes: text.keyframes,
    });
  }
  // SVG overlays diff like every other overlay family; the raw markup is
  // summarized by its content length so a content swap shows up as a field
  // change without journaling megabytes of markup.
  for (const svg of project.svgClips ?? []) {
    put("svg", svg.id, {
      trackId: svg.trackId,
      startTime: svg.startTime,
      duration: svg.duration,
      svgContentBytes: svg.svgContent.length,
      viewBox: svg.viewBox,
      transform: svg.transform,
      keyframes: svg.keyframes,
      colorStyle: svg.colorStyle,
      entryAnimation: svg.entryAnimation,
      exitAnimation: svg.exitAnimation,
    });
  }
  for (const media of project.mediaLibrary.items) {
    put("media", media.id, {
      name: media.name,
      displayName: media.displayName,
      type: media.type,
      originalUrl: media.originalUrl,
      sourceFile: media.sourceFile,
      metadata: media.metadata,
    });
  }
  for (const marker of project.markers?.items ?? []) {
    put("marker", marker.id, {
      number: marker.number,
      target: marker.target,
      label: marker.label,
      color: marker.color,
      createdAt: marker.createdAt,
    });
  }
  for (const subtitle of project.timeline.subtitles ?? []) {
    put("subtitle", subtitle.id, {
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      text: subtitle.text,
      style: subtitle.style,
    });
  }
  return index;
}

function changedFields(before: EntitySnapshot, after: EntitySnapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => stableStringify(before[key]) !== stableStringify(after[key]))
    .sort();
}

/** Structural, entity-level diff used by both the headless and renderer journals. */
export function diffProjectChanges(
  before: Project,
  after: Project,
  revision: number,
): ProjectChange[] {
  const prior = indexProject(before);
  const next = indexProject(after);
  const changes: ProjectChange[] = [];
  for (const [key, entity] of next) {
    const old = prior.get(key);
    if (!old) {
      changes.push({
        revision,
        change: "added",
        entityType: entity.entityType,
        entityId: entity.entityId,
        fields: ["*"],
      });
      continue;
    }
    const fields = changedFields(old.value, entity.value);
    if (fields.length > 0) {
      changes.push({
        revision,
        change: "updated",
        entityType: entity.entityType,
        entityId: entity.entityId,
        fields,
      });
    }
  }
  for (const [key, entity] of prior) {
    if (!next.has(key)) {
      changes.push({
        revision,
        change: "removed",
        entityType: entity.entityType,
        entityId: entity.entityId,
        fields: ["*"],
      });
    }
  }
  return changes.sort((a, b) =>
    a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId),
  );
}

function cursorFor(sinceRevision: number, throughRevision: number, offset: number): string {
  return `pc1:${sinceRevision}:${throughRevision}:${offset}`;
}

function parseCursor(
  cursor: string | undefined,
  sinceRevision: number,
  currentRevision: number,
): { throughRevision: number; offset: number } {
  if (cursor === undefined) return { throughRevision: currentRevision, offset: 0 };
  const match = /^pc1:(\d+):(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new FacadeError("INVALID_PARAMS", "project.changes: invalid cursor");
  const [, sinceText, throughText, offsetText] = match;
  const cursorSince = Number(sinceText);
  const throughRevision = Number(throughText);
  const offset = Number(offsetText);
  if (
    cursorSince !== sinceRevision ||
    !Number.isSafeInteger(throughRevision) ||
    throughRevision > currentRevision ||
    !Number.isSafeInteger(offset)
  ) {
    throw new FacadeError("INVALID_PARAMS", "project.changes: cursor does not match this query or revision window");
  }
  return { throughRevision, offset };
}

export class ProjectChangeJournal {
  private revisions: RevisionChanges[] = [];

  reset(): void {
    this.revisions = [];
  }

  record(before: Project, after: Project, fromRevision: number, toRevision: number): void {
    if (toRevision <= fromRevision) return;
    this.revisions.push({
      fromRevision,
      toRevision,
      changes: diffProjectChanges(before, after, toRevision),
    });
    while (this.revisions.length > MAX_RETAINED_CHANGE_REVISIONS) this.revisions.shift();
  }

  query(params: ProjectChangesParams, currentRevision: number): ProjectChangesResult {
    const limit = params.limit ?? DEFAULT_PROJECT_CHANGES_LIMIT;
    const { throughRevision, offset } = parseCursor(
      params.cursor,
      params.sinceRevision,
      currentRevision,
    );
    const earliestFrom = this.revisions[0]?.fromRevision ?? currentRevision;
    const requiresFullRefresh =
      params.sinceRevision < currentRevision && params.sinceRevision < earliestFrom;
    if (requiresFullRefresh) {
      return {
        fromRevision: params.sinceRevision,
        toRevision: currentRevision,
        changes: [],
        nextCursor: null,
        requiresFullRefresh: true,
      };
    }
    const changes = this.revisions
      .filter(
        (entry) =>
          entry.toRevision > params.sinceRevision && entry.toRevision <= throughRevision,
      )
      .flatMap((entry) => entry.changes);
    const page = changes.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      fromRevision: params.sinceRevision,
      toRevision: throughRevision,
      changes: page,
      nextCursor:
        nextOffset < changes.length
          ? cursorFor(params.sinceRevision, throughRevision, nextOffset)
          : null,
      requiresFullRefresh: false,
    };
  }
}
