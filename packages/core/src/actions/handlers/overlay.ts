import type { Project } from "../../types/project";
import type { Action, ValidationResult } from "../../types/actions";
import { validateSvgContent } from "../../graphics/svg-validation";
import { registerActionHandler } from "../registry";
import type { ActionHandler } from "../registry";

type OverlayField =
  | "textClips"
  | "shapeClips"
  | "svgClips"
  | "stickerClips";

interface OverlayItem {
  readonly id: string;
  readonly [key: string]: unknown;
}

// Overlay prefixes whose payload carries raw SVG markup. The create/update
// handlers re-check that payload through the shared SVG validation so the
// action layer rejects unsafe content even when a caller bypassed the
// engine-level import path.
const SVG_CONTENT_FIELD_BY_PREFIX: Partial<Record<string, string>> = {
  svg: "svgContent",
};

function validateOverlayContent(
  prefix: string,
  content: unknown,
): ValidationResult | null {
  const field = SVG_CONTENT_FIELD_BY_PREFIX[prefix];
  if (!field) return null;
  if (typeof content !== "string") {
    return err(`${prefix} action requires a string ${field}`);
  }
  const result = validateSvgContent(content);
  return result.ok
    ? null
    : {
        valid: false,
        errors: [{ code: result.code, message: result.message }],
      };
}

function getOverlays(project: Project, field: OverlayField): OverlayItem[] {
  return ((project as unknown as Record<string, OverlayItem[]>)[field] ??
    []) as OverlayItem[];
}

function setOverlays(
  project: Project,
  field: OverlayField,
  clips: OverlayItem[],
): void {
  (project as unknown as Record<string, OverlayItem[]>)[field] = clips;
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function err(message: string): ValidationResult {
  return { valid: false, errors: [{ code: "INVALID_PARAMS", message }] };
}

export function makeOverlayHandlers(
  prefix: string,
  field: OverlayField,
): ActionHandler[] {
  const create: ActionHandler = {
    type: `${prefix}/create`,
    synchronous: true,
    validate(action: Action): ValidationResult {
      const clip = (action.params as { clip?: OverlayItem }).clip;
      if (!clip || typeof clip.id !== "string") {
        return err(`${prefix}/create requires a clip with an id`);
      }
      const contentField = SVG_CONTENT_FIELD_BY_PREFIX[prefix];
      if (contentField) {
        const contentError = validateOverlayContent(prefix, clip[contentField]);
        if (contentError) return contentError;
      }
      return ok();
    },
    apply(action: Action, project: Project): void {
      const clip = (action.params as { clip: OverlayItem }).clip;
      setOverlays(project, field, [...getOverlays(project, field), clip]);
    },
    invert(action: Action): Action | null {
      const clip = (action.params as { clip: OverlayItem }).clip;
      return {
        type: `${prefix}/remove`,
        id: `inverse-${action.id}`,
        timestamp: Date.now(),
        params: { clipId: clip.id },
      };
    },
  };

  const update: ActionHandler = {
    type: `${prefix}/update`,
    synchronous: true,
    validate(action: Action, project: Project): ValidationResult {
      const { clipId, updates } = action.params as {
        clipId?: string;
        updates?: Record<string, unknown>;
      };
      if (!getOverlays(project, field).some((c) => c.id === clipId)) {
        return err(`${prefix} clip not found: ${String(clipId)}`);
      }
      const contentField = SVG_CONTENT_FIELD_BY_PREFIX[prefix];
      if (contentField && updates && contentField in updates) {
        const contentError = validateOverlayContent(
          prefix,
          updates[contentField],
        );
        if (contentError) return contentError;
      }
      return ok();
    },
    apply(action: Action, project: Project): void {
      const { clipId, updates } = action.params as {
        clipId: string;
        updates: Record<string, unknown>;
      };
      setOverlays(
        project,
        field,
        getOverlays(project, field).map((c) =>
          c.id === clipId ? { ...c, ...updates } : c,
        ),
      );
    },
    invert(action: Action, projectBefore: Project): Action | null {
      const clipId = (action.params as { clipId: string }).clipId;
      const prior = getOverlays(projectBefore, field).find(
        (c) => c.id === clipId,
      );
      if (!prior) return null;
      return {
        type: `${prefix}/update`,
        id: `inverse-${action.id}`,
        timestamp: Date.now(),
        params: { clipId, updates: { ...prior } },
      };
    },
  };

  const remove: ActionHandler = {
    type: `${prefix}/remove`,
    synchronous: true,
    validate(action: Action, project: Project): ValidationResult {
      const clipId = (action.params as { clipId?: string }).clipId;
      return getOverlays(project, field).some((c) => c.id === clipId)
        ? ok()
        : err(`${prefix} clip not found: ${String(clipId)}`);
    },
    apply(action: Action, project: Project): void {
      const clipId = (action.params as { clipId: string }).clipId;
      setOverlays(
        project,
        field,
        getOverlays(project, field).filter((c) => c.id !== clipId),
      );
    },
    invert(action: Action, projectBefore: Project): Action | null {
      const clipId = (action.params as { clipId: string }).clipId;
      const prior = getOverlays(projectBefore, field).find(
        (c) => c.id === clipId,
      );
      if (!prior) return null;
      return {
        type: `${prefix}/create`,
        id: `inverse-${action.id}`,
        timestamp: Date.now(),
        params: { clip: { ...prior } },
      };
    },
  };

  return [create, update, remove];
}

const OVERLAY_DEFS: ReadonlyArray<{ prefix: string; field: OverlayField }> = [
  { prefix: "text", field: "textClips" },
  { prefix: "shape", field: "shapeClips" },
  { prefix: "svg", field: "svgClips" },
  { prefix: "sticker", field: "stickerClips" },
];

// Subtitle imports use bounded payloads inside the ordinary atomic action
// batch. Keep the 256-action guard and the retained history capacity intact.
const TEXT_CLIPS_PER_ACTION = 256;
registerActionHandler({
  type: "text/createMany",
  synchronous: true,
  validate(action, project) {
    const { clips, indices } = action.params as { clips?: OverlayItem[]; indices?: number[] };
    if (!Array.isArray(clips) || !clips.length || clips.length > TEXT_CLIPS_PER_ACTION) return err("text/createMany requires 1–256 clips");
    const ids = new Set(getOverlays(project, "textClips").map(clip => clip.id));
    for (const clip of clips) {
      if (!clip || typeof clip.id !== "string" || !clip.id || ids.has(clip.id)) return err("text/createMany clip ids must be unique");
      if (!project.timeline.tracks.some(track => track.type === "text" && track.id === clip.trackId)) return err("text/createMany requires existing text tracks");
      if (typeof clip.text !== "string" || typeof clip.startTime !== "number" || !Number.isFinite(clip.startTime) || clip.startTime < 0 || typeof clip.duration !== "number" || !Number.isFinite(clip.duration) || clip.duration <= 0) return err("text/createMany requires valid text and timing");
      ids.add(clip.id);
    }
    if (indices !== undefined && (!Array.isArray(indices) || indices.length !== clips.length || indices.some((index, i) => !Number.isInteger(index) || index < 0 || index >= ids.size || (i > 0 && index <= indices[i - 1]!)))) return err("text/createMany restore indices must be ordered and in range");
    return ok();
  },
  apply(action, project) {
    const { clips, indices } = action.params as { clips: OverlayItem[]; indices?: number[] };
    const result = [...getOverlays(project, "textClips")];
    if (indices) clips.forEach((clip, i) => result.splice(indices[i]!, 0, clip));
    else result.push(...clips);
    setOverlays(project, "textClips", result);
  },
  invert(action) {
    const { clips } = action.params as { clips: OverlayItem[] };
    return { type: "text/removeMany", id: `inverse-${action.id}`, timestamp: Date.now(), params: { clipIds: clips.map(clip => clip.id) } };
  },
});
registerActionHandler({
  type: "text/removeMany",
  synchronous: true,
  validate(action, project) {
    const { clipIds } = action.params as { clipIds?: string[] };
    const existing = new Set(getOverlays(project, "textClips").map(clip => clip.id));
    return Array.isArray(clipIds) && clipIds.length > 0 && clipIds.length <= TEXT_CLIPS_PER_ACTION && new Set(clipIds).size === clipIds.length && clipIds.every(id => typeof id === "string" && existing.has(id)) ? ok() : err("text/removeMany requires 1–256 distinct existing clips");
  },
  apply(action, project) {
    const ids = new Set((action.params as { clipIds: string[] }).clipIds);
    setOverlays(project, "textClips", getOverlays(project, "textClips").filter(clip => !ids.has(clip.id)));
  },
  invert(action, project) {
    const ids = new Set((action.params as { clipIds: string[] }).clipIds);
    const clips: OverlayItem[] = []; const indices: number[] = [];
    getOverlays(project, "textClips").forEach((clip, i) => { if (ids.has(clip.id)) { clips.push(clip); indices.push(i); } });
    return { type: "text/createMany", id: `inverse-${action.id}`, timestamp: Date.now(), params: { clips, indices } };
  },
});

for (const def of OVERLAY_DEFS) {
  for (const handler of makeOverlayHandlers(def.prefix, def.field)) {
    registerActionHandler(handler);
  }
}
