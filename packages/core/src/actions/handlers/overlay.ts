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

for (const def of OVERLAY_DEFS) {
  for (const handler of makeOverlayHandlers(def.prefix, def.field)) {
    registerActionHandler(handler);
  }
}
