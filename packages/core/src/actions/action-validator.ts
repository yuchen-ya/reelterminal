import type {
  Action,
  ValidationResult,
  ValidationError,
  TimelineAction,
  TrackAction,
  ClipAction,
  EffectAction,
  TransformAction,
  KeyframeAction,
  TransitionAction,
  AudioAction,
  SubtitleAction,
  MediaAction,
  ProjectAction,
  MarkerAction,
  ProjectMarkerAction,
  ProjectRequirementAction,
  WorkAssetAction,
  ReferenceComparisonAction,
} from "../types/actions";
import type {
  Project,
  ProjectMarkerTarget,
  Timeline,
  Track,
  Clip,
} from "../types";
import { WORK_ASSET_MAX_MEMBERS } from "../types/work-asset";
import { REQUIREMENT_PRIORITIES, REQUIREMENT_STATUSES } from "../types/requirement";
import { getActionHandler } from "./registry";

export class ActionValidator {
  validate(action: Action, project: Project): ValidationResult {
    const errors: ValidationError[] = [];
    if (!action.type || typeof action.type !== "string") {
      errors.push({
        code: "INVALID_TYPE",
        message: "Action type is required and must be a string",
      });
      return { valid: false, errors };
    }

    if (!action.params || typeof action.params !== "object") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Action params are required and must be an object",
      });
      return { valid: false, errors };
    }

    const handler = getActionHandler(action.type);
    if (handler) {
      return handler.validate(action, project);
    }

    const typeValidationErrors = this.validateActionType(
      action as TimelineAction,
      project,
    );
    errors.push(...typeValidationErrors);

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private validateActionType(
    action: TimelineAction,
    project: Project,
  ): ValidationError[] {
    const type = action.type;

    if (type.startsWith("project/")) {
      return this.validateProjectAction(action as ProjectAction, project);
    } else if (type.startsWith("projectMarker/")) {
      return this.validateProjectMarkerAction(
        action as ProjectMarkerAction,
        project,
      );
    } else if (type.startsWith("requirement/")) {
      return this.validateProjectRequirementAction(
        action as ProjectRequirementAction,
        project,
      );
    } else if (type.startsWith("workAsset/")) {
      return this.validateWorkAssetAction(action as WorkAssetAction, project);
    } else if (type.startsWith("media/")) {
      return this.validateMediaAction(action as MediaAction, project);
    } else if (type.startsWith("track/")) {
      return this.validateTrackAction(action as TrackAction, project);
    } else if (type.startsWith("clip/")) {
      return this.validateClipAction(action as ClipAction, project);
    } else if (type.startsWith("effect/")) {
      return this.validateEffectAction(action as EffectAction, project);
    } else if (type.startsWith("transform/")) {
      return this.validateTransformAction(action as TransformAction, project);
    } else if (type.startsWith("keyframe/")) {
      return this.validateKeyframeAction(action as KeyframeAction, project);
    } else if (type.startsWith("transition/")) {
      return this.validateTransitionAction(action as TransitionAction, project);
    } else if (type.startsWith("audio/")) {
      return this.validateAudioAction(action as AudioAction, project);
    } else if (type.startsWith("subtitle/")) {
      return this.validateSubtitleAction(action as SubtitleAction, project);
    } else if (type.startsWith("marker/")) {
      return this.validateMarkerAction(action as MarkerAction, project);
    } else if (type.startsWith("reference/")) {
      return this.validateReferenceComparisonAction(
        action as ReferenceComparisonAction,
        project,
      );
    }

    return [
      {
        code: "UNKNOWN_ACTION_TYPE",
        message: `Unknown action type: ${type}`,
      },
    ];
  }

  private validateProjectRequirementAction(
    action: ProjectRequirementAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const references = "requirement" in action.params ? action.params.requirement?.references : "patch" in action.params ? action.params.patch.references : undefined;
    if (references !== undefined && (!Array.isArray(references) || references.some((reference) =>
      !reference || typeof reference.entityId !== "string" || !reference.entityId.trim() ||
      typeof reference.ref !== "string" || typeof reference.label !== "string" ||
      !["video", "audio", "text", "media", "workAsset"].includes(reference.kind) || !reference.timing ||
      [reference.timing.startSeconds, reference.timing.endSeconds].some((time) => time !== null && (typeof time !== "number" || !Number.isFinite(time) || time < 0))
    ))) {
      errors.push({ code: "INVALID_PARAMS", message: "Requirement references are invalid", path: "references" });
    }
    const items = project.requirements?.items ?? [];
    if (action.type === "requirement/add" || action.type === "requirement/restore") {
      const item = action.params.requirement;
      if (!item || typeof item !== "object") {
        return [{ code: "INVALID_PARAMS", message: "Requirement must be an object", path: "params.requirement" }];
      }
      if (!item.id || typeof item.id !== "string") errors.push({ code: "INVALID_PARAMS", message: "Requirement id is required", path: "params.requirement.id" });
      if (!Number.isInteger(item.number) || item.number < 1) errors.push({ code: "INVALID_PARAMS", message: "Requirement number must be a positive integer", path: "params.requirement.number" });
      if (!item.title?.trim()) errors.push({ code: "INVALID_PARAMS", message: "Requirement title is required", path: "params.requirement.title" });
      if (!(REQUIREMENT_STATUSES as readonly string[]).includes(item.status)) errors.push({ code: "INVALID_PARAMS", message: "Requirement status is invalid", path: "params.requirement.status" });
      if (!(REQUIREMENT_PRIORITIES as readonly string[]).includes(item.priority)) errors.push({ code: "INVALID_PARAMS", message: "Requirement priority is invalid", path: "params.requirement.priority" });
      if (action.type === "requirement/add" && items.some((entry) => entry.id === item.id)) errors.push({ code: "INVALID_PARAMS", message: `Requirement ${item.id} already exists`, path: "params.requirement.id" });
      return errors;
    }
    if (!("requirementId" in action.params)) return errors;
    const id = action.params.requirementId;
    if (!items.some((item) => item.id === id)) errors.push({ code: "INVALID_PARAMS", message: `Requirement ${id} not found`, path: "params.requirementId" });
    if (action.type === "requirement/update") {
      const { patch } = action.params;
      if (patch.title !== undefined && !patch.title.trim()) errors.push({ code: "INVALID_PARAMS", message: "Requirement title cannot be empty", path: "params.patch.title" });
      if (patch.status !== undefined && !(REQUIREMENT_STATUSES as readonly string[]).includes(patch.status)) errors.push({ code: "INVALID_PARAMS", message: "Requirement status is invalid", path: "params.patch.status" });
      if (patch.priority !== undefined && !(REQUIREMENT_PRIORITIES as readonly string[]).includes(patch.priority)) errors.push({ code: "INVALID_PARAMS", message: "Requirement priority is invalid", path: "params.patch.priority" });
    }
    return errors;
  }

  /**
   * Reference comparison actions carry fully validated configs — the facade
   * validates them against the owning project's media and durations before
   * translating; nothing further to check here.
   */
  private validateReferenceComparisonAction(
    _action: ReferenceComparisonAction,
    _project: Project,
  ): ValidationError[] {
    return [];
  }

  private validateProjectAction(
    action: ProjectAction,
    _project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    switch (action.type) {
      case "project/create":
        if (!action.params.name || typeof action.params.name !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Project name is required and must be a string",
            path: "params.name",
          });
        }
        if (!action.params.settings) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Project settings are required",
            path: "params.settings",
          });
        }
        break;

      case "project/rename":
        if (!action.params.name || typeof action.params.name !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Project name is required and must be a string",
            path: "params.name",
          });
        }
        break;

      case "project/updateSettings":
      case "project/setCanvasBackground":
        // Params are partial, so just check they're an object
        if (
          !action.params ||
          typeof action.params !== "object" ||
          Array.isArray(action.params)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Params must be an object",
            path: "params",
          });
        }
        break;

      case "project/registerGeneratedShader":
        if (
          !action.params.def ||
          typeof action.params.def !== "object" ||
          typeof action.params.def.id !== "string" ||
          typeof action.params.def.glsl !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "A valid shader def is required",
            path: "params.def",
          });
        }
        break;

      case "project/removeGeneratedShader":
        if (
          !action.params.shaderId ||
          typeof action.params.shaderId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "shaderId is required and must be a string",
            path: "params.shaderId",
          });
        }
        break;
    }

    return errors;
  }

  private validateMediaAction(
    action: MediaAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    switch (action.type) {
      case "media/import":
        // A fully-formed mediaItem (used by media.replace's version import
        // and by redo restores) satisfies the action without a File handle.
        if (!action.params.file && !action.params.mediaItem) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "File is required for media import",
            path: "params.file",
          });
        }
        if (
          action.params.mediaItem &&
          project.mediaLibrary.items.some(
            (item) => item.id === action.params.mediaItem?.id,
          )
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Media with ID ${action.params.mediaItem.id} already exists`,
            path: "params.mediaItem.id",
          });
        }
        break;

      case "media/delete":
      case "media/rename":
        if (
          !action.params.mediaId ||
          typeof action.params.mediaId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Media ID is required and must be a string",
            path: "params.mediaId",
          });
        } else {
          const mediaExists = project.mediaLibrary.items.some(
            (item) => item.id === action.params.mediaId,
          );
          if (!mediaExists) {
            errors.push({
              code: "MEDIA_NOT_FOUND",
              message: `Media with ID ${action.params.mediaId} not found`,
              path: "params.mediaId",
            });
          }
        }

        if (action.type === "media/rename") {
          if (!action.params.name || typeof action.params.name !== "string") {
            errors.push({
              code: "INVALID_PARAMS",
              message: "Media name is required and must be a string",
              path: "params.name",
            });
          }
        }
        break;
    }

    return errors;
  }

  private validateTrackAction(
    action: TrackAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    switch (action.type) {
      case "track/add":
        if (
          !["video", "audio", "image", "text", "graphics"].includes(
            action.params.trackType,
          )
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Track type must be 'video', 'audio', 'image', 'text', or 'graphics'",
            path: "params.trackType",
          });
        }
        if (
          action.params.position !== undefined &&
          (typeof action.params.position !== "number" ||
            action.params.position < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track position must be a non-negative number",
            path: "params.position",
          });
        }
        break;

      case "track/duplicate":
        if (
          !action.params.sourceTrackId ||
          typeof action.params.sourceTrackId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Source track ID is required and must be a string",
            path: "params.sourceTrackId",
          });
        } else if (!this.findTrack(timeline, action.params.sourceTrackId)) {
          errors.push({
            code: "TRACK_NOT_FOUND",
            message: `Track with ID ${action.params.sourceTrackId} not found`,
            path: "params.sourceTrackId",
          });
        }
        if (
          action.params.position !== undefined &&
          (typeof action.params.position !== "number" ||
            action.params.position < 0 ||
            action.params.position > timeline.tracks.length)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track position must be within the timeline",
            path: "params.position",
          });
        }
        break;

      case "track/remove":
      case "track/lock":
      case "track/hide":
      case "track/mute":
      case "track/solo":
        if (
          !action.params.trackId ||
          typeof action.params.trackId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track ID is required and must be a string",
            path: "params.trackId",
          });
        } else {
          const track = this.findTrack(timeline, action.params.trackId);
          if (!track) {
            errors.push({
              code: "TRACK_NOT_FOUND",
              message: `Track with ID ${action.params.trackId} not found`,
              path: "params.trackId",
            });
          }
        }
        if (
          action.type === "track/lock" &&
          typeof action.params.locked !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Locked parameter must be a boolean",
            path: "params.locked",
          });
        }
        if (
          action.type === "track/hide" &&
          typeof action.params.hidden !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Hidden parameter must be a boolean",
            path: "params.hidden",
          });
        }
        if (
          action.type === "track/mute" &&
          typeof action.params.muted !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Muted parameter must be a boolean",
            path: "params.muted",
          });
        }
        if (
          action.type === "track/solo" &&
          typeof action.params.solo !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Solo parameter must be a boolean",
            path: "params.solo",
          });
        }
        break;

      case "track/reorder":
        if (
          !action.params.trackId ||
          typeof action.params.trackId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track ID is required and must be a string",
            path: "params.trackId",
          });
        } else {
          const track = this.findTrack(timeline, action.params.trackId);
          if (!track) {
            errors.push({
              code: "TRACK_NOT_FOUND",
              message: `Track with ID ${action.params.trackId} not found`,
              path: "params.trackId",
            });
          }
        }

        if (
          typeof action.params.newPosition !== "number" ||
          action.params.newPosition < 0 ||
          action.params.newPosition >= timeline.tracks.length
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `New position must be between 0 and ${
              timeline.tracks.length - 1
            }`,
            path: "params.newPosition",
          });
        }
        break;

      case "track/rename":
        if (
          !action.params.trackId ||
          typeof action.params.trackId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track ID is required and must be a string",
            path: "params.trackId",
          });
        } else {
          const track = this.findTrack(timeline, action.params.trackId);
          if (!track) {
            errors.push({
              code: "TRACK_NOT_FOUND",
              message: `Track with ID ${action.params.trackId} not found`,
              path: "params.trackId",
            });
          }
        }
        if (
          typeof action.params.name !== "string" ||
          action.params.name.trim().length === 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track name is required and must be a non-empty string",
            path: "params.name",
          });
        }
        break;
    }

    return errors;
  }

  private validateMarkerAction(
    action: MarkerAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    switch (action.type) {
      case "marker/add":
        if (
          typeof action.params.time !== "number" ||
          action.params.time < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker time must be a non-negative number",
            path: "params.time",
          });
        }
        break;

      case "marker/remove":
      case "marker/update":
        if (
          !action.params.markerId ||
          typeof action.params.markerId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker ID is required and must be a string",
            path: "params.markerId",
          });
        } else {
          const marker = timeline.markers.find(
            (m) => m.id === action.params.markerId,
          );
          if (!marker) {
            errors.push({
              code: "INVALID_PARAMS",
              message: `Marker with ID ${action.params.markerId} not found`,
              path: "params.markerId",
            });
          }
        }
        break;
    }

    return errors;
  }

  private validateProjectMarkerAction(
    action: ProjectMarkerAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const items = project.markers?.items ?? [];

    switch (action.type) {
      case "projectMarker/add":
      case "projectMarker/restore": {
        const marker = action.params.marker as unknown;
        if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker must be an object",
            path: "params.marker",
          });
          break;
        }
        const m = marker as {
          id?: unknown;
          number?: unknown;
          target?: unknown;
          label?: unknown;
          color?: unknown;
          createdAt?: unknown;
        };
        if (typeof m.id !== "string" || m.id.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker id is required and must be a non-empty string",
            path: "params.marker.id",
          });
        } else if (items.some((existing) => existing.id === m.id)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Marker with ID ${m.id} already exists`,
            path: "params.marker.id",
          });
        }
        if (
          typeof m.number !== "number" ||
          !Number.isInteger(m.number) ||
          m.number < 1
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker number must be a positive integer",
            path: "params.marker.number",
          });
        }
        if (
          typeof m.createdAt !== "number" ||
          !Number.isFinite(m.createdAt) ||
          m.createdAt < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker createdAt must be a non-negative finite number",
            path: "params.marker.createdAt",
          });
        }
        if (
          m.label !== undefined &&
          (typeof m.label !== "string" || m.label.length > 200)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker label must be a string of at most 200 characters",
            path: "params.marker.label",
          });
        }
        if (m.color !== undefined && typeof m.color !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker color must be a string",
            path: "params.marker.color",
          });
        }
        errors.push(...this.validateProjectMarkerTarget(m.target, project));
        break;
      }

      case "projectMarker/remove": {
        const markerId = action.params.markerId as unknown;
        if (!markerId || typeof markerId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker ID is required and must be a string",
            path: "params.markerId",
          });
        } else if (!items.some((m) => m.id === markerId)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Marker with ID ${markerId} not found`,
            path: "params.markerId",
          });
        }
        break;
      }
    }

    return errors;
  }

  private validateProjectMarkerTarget(
    target: unknown,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const path = "params.marker.target";
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Marker target must be an object",
        path,
      });
      return errors;
    }
    const t = target as ProjectMarkerTarget;
    switch (t.kind) {
      case "asset":
        if (typeof t.mediaId !== "string" || t.mediaId.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target mediaId must be a non-empty string",
            path: `${path}.mediaId`,
          });
        } else if (
          !project.mediaLibrary.items.some((item) => item.id === t.mediaId)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Marker target media ${t.mediaId} not found`,
            path: `${path}.mediaId`,
          });
        }
        break;

      case "clip":
        if (typeof t.clipId !== "string" || t.clipId.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target clipId must be a non-empty string",
            path: `${path}.clipId`,
          });
        } else if (
          !project.timeline.tracks.some((track) =>
            track.clips.some((clip) => clip.id === t.clipId),
          )
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Marker target clip ${t.clipId} not found`,
            path: `${path}.clipId`,
          });
        }
        break;

      case "text":
        if (typeof t.textClipId !== "string" || t.textClipId.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target textClipId must be a non-empty string",
            path: `${path}.textClipId`,
          });
        } else if (
          !(project.textClips ?? []).some((clip) => clip.id === t.textClipId)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Marker target text overlay ${t.textClipId} not found`,
            path: `${path}.textClipId`,
          });
        }
        break;

      case "timeRange": {
        const { start, end } = t;
        const startValid =
          typeof start === "number" && Number.isFinite(start) && start >= 0;
        const endValid = typeof end === "number" && Number.isFinite(end);
        if (!startValid) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target start must be a non-negative finite number",
            path: `${path}.start`,
          });
        }
        if (!endValid) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target end must be a finite number",
            path: `${path}.end`,
          });
        }
        if (startValid && endValid && end < start) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Marker target end must be greater than or equal to start",
            path: `${path}.end`,
          });
        }
        break;
      }

      default:
        errors.push({
          code: "INVALID_PARAMS",
          message: `Unknown marker target kind ${JSON.stringify((t as { kind?: unknown }).kind)}`,
          path: `${path}.kind`,
        });
    }

    return errors;
  }

  /**
   * Work-asset actions. `create` validates against the live environment (the
   * source media must exist); `restore` is the delete inverse and accepts the
   * missing-source state as a legal persistent shape — only the entry's own
   * structure is checked, never the library.
   */
  private validateWorkAssetAction(
    action: WorkAssetAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const items = project.workAssets ?? [];

    switch (action.type) {
      case "workAsset/create":
      case "workAsset/restore": {
        const asset = action.params.asset as unknown;
        if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Work asset must be an object",
            path: "params.asset",
          });
          break;
        }
        const a = asset as {
          schemaVersion?: unknown;
          id?: unknown;
          kind?: unknown;
          name?: unknown;
          sourceMediaId?: unknown;
          sourceRange?: unknown;
          clipSnapshot?: unknown;
          members?: unknown;
          transitions?: unknown;
          unsupportedParams?: unknown;
          createdAt?: unknown;
          updatedAt?: unknown;
        };
        if (a.schemaVersion !== 1) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Work asset schemaVersion must be 1",
            path: "params.asset.schemaVersion",
          });
        }
        if (typeof a.id !== "string" || a.id.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset id is required and must be a non-empty string",
            path: "params.asset.id",
          });
        } else if (items.some((existing) => existing.id === a.id)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Work asset with ID ${a.id} already exists`,
            path: "params.asset.id",
          });
        }
        if (a.kind !== "single" && a.kind !== "multi") {
          errors.push({
            code: "INVALID_PARAMS",
            message: 'Work asset kind must be "single" or "multi"',
            path: "params.asset.kind",
          });
        } else if (a.kind === "multi") {
          // The multi layout is mutually exclusive with the single snapshot:
          // members carry the per-clip snapshots, the top-level snapshot must
          // be absent so the two shapes can never hybridize.
          errors.push(
            ...this.validateWorkAssetMembers(a, action, project),
          );
        } else if (a.members !== undefined) {
          errors.push({
            code: "INVALID_PARAMS",
            message: 'Work asset kind "single" must not carry a members array',
            path: "params.asset.members",
          });
        }
        if (
          typeof a.name !== "string" ||
          a.name.trim().length === 0 ||
          a.name.length > 200
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset name is required and must be a string of at most 200 characters",
            path: "params.asset.name",
          });
        }
        if (typeof a.sourceMediaId !== "string" || a.sourceMediaId.length === 0) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset sourceMediaId is required and must be a non-empty string",
            path: "params.asset.sourceMediaId",
          });
        } else if (
          action.type === "workAsset/create" &&
          !project.mediaLibrary.items.some((item) => item.id === a.sourceMediaId)
        ) {
          // Existence is a create-time concern only. A restored asset may
          // legitimately reference media that was deleted after capture.
          errors.push({
            code: "MEDIA_NOT_FOUND",
            message: `Source media ${a.sourceMediaId} not found`,
            path: "params.asset.sourceMediaId",
          });
        }
        errors.push(...this.validateWorkAssetSourceRange(a.sourceRange));
        if (
          typeof a.createdAt !== "number" ||
          !Number.isFinite(a.createdAt) ||
          a.createdAt < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset createdAt must be a non-negative finite number",
            path: "params.asset.createdAt",
          });
        }
        if (
          typeof a.updatedAt !== "number" ||
          !Number.isFinite(a.updatedAt) ||
          a.updatedAt < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset updatedAt must be a non-negative finite number",
            path: "params.asset.updatedAt",
          });
        }
        errors.push(
          ...this.validateWorkAssetUnsupportedParams(a.unsupportedParams),
        );
        errors.push(...this.validateWorkAssetTransitions(a.transitions));
        if (a.clipSnapshot !== undefined && a.kind !== "multi") {
          errors.push(...this.validateWorkAssetClipSnapshot(a.clipSnapshot));
        }
        break;
      }

      case "workAsset/delete": {
        const workAssetId = action.params.workAssetId as unknown;
        if (!workAssetId || typeof workAssetId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Work asset ID is required and must be a string",
            path: "params.workAssetId",
          });
        } else if (!items.some((asset) => asset.id === workAssetId)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Work asset with ID ${workAssetId} not found`,
            path: "params.workAssetId",
          });
        }
        break;
      }

      case "workAsset/rename": {
        const workAssetId = action.params.workAssetId as unknown;
        if (!workAssetId || typeof workAssetId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Work asset ID is required and must be a string",
            path: "params.workAssetId",
          });
        } else if (!items.some((asset) => asset.id === workAssetId)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Work asset with ID ${workAssetId} not found`,
            path: "params.workAssetId",
          });
        }
        const name = action.params.name as unknown;
        if (
          typeof name !== "string" ||
          name.trim().length === 0 ||
          name.length > 200
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message:
              "Work asset name is required and must be a string of at most 200 characters",
            path: "params.name",
          });
        }
        break;
      }
    }

    return errors;
  }

  private validateWorkAssetSourceRange(
    range: unknown,
    basePath: string = "params.asset.sourceRange",
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const path = basePath;
    if (!range || typeof range !== "object" || Array.isArray(range)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset sourceRange must be an object",
        path,
      });
      return errors;
    }
    const inSec =
      typeof (range as { inSec?: unknown }).inSec === "number" &&
      Number.isFinite((range as { inSec: number }).inSec)
        ? (range as { inSec: number }).inSec
        : null;
    const outSec =
      typeof (range as { outSec?: unknown }).outSec === "number" &&
      Number.isFinite((range as { outSec: number }).outSec)
        ? (range as { outSec: number }).outSec
        : null;
    if (inSec === null || inSec < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "Work asset sourceRange inSec must be a non-negative finite number",
        path: `${path}.inSec`,
      });
    }
    if (outSec === null) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset sourceRange outSec must be a finite number",
        path: `${path}.outSec`,
      });
    } else if (inSec !== null && outSec <= inSec) {
      errors.push({
        code: "INVALID_TIME_RANGE",
        message: "Work asset sourceRange outSec must be greater than inSec",
        path: `${path}.outSec`,
      });
    }
    return errors;
  }

  /**
   * Multi-asset members: count cap, unique memberIds, per-member media/range/
   * lane/snapshot checks. The range and snapshot validators are the SAME wide
   * checks used for single assets (deep parameter validation stays with the
   * render engine). Media existence is a create-time concern only — a restored
   * multi asset may legitimately reference media deleted after capture.
   */
  private validateWorkAssetMembers(
    a: {
      clipSnapshot?: unknown;
      members?: unknown;
    },
    action: WorkAssetAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    if (a.clipSnapshot !== undefined) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          'Work asset kind "multi" must not carry a single-clip clipSnapshot (per-clip snapshots live in members)',
        path: "params.asset.clipSnapshot",
      });
    }
    const members = a.members;
    if (!Array.isArray(members) || members.length === 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          'Work asset kind "multi" requires a non-empty members array (multi-clip layout)',
        path: "params.asset.members",
      });
      return errors;
    }
    if (members.length > WORK_ASSET_MAX_MEMBERS) {
      errors.push({
        code: "INVALID_PARAMS",
        message: `Work asset kind "multi" supports at most ${WORK_ASSET_MAX_MEMBERS} members (got ${members.length})`,
        path: "params.asset.members",
      });
    }
    const seenMemberIds = new Set<string>();
    members.forEach((member, index) => {
      const path = `params.asset.members[${index}]`;
      if (!member || typeof member !== "object" || Array.isArray(member)) {
        errors.push({
          code: "INVALID_PARAMS",
          message: "Each work asset member must be an object",
          path,
        });
        return;
      }
      const m = member as {
        memberId?: unknown;
        mediaId?: unknown;
        sourceRange?: unknown;
        relativeStart?: unknown;
        lane?: unknown;
        snapshot?: unknown;
      };
      if (typeof m.memberId !== "string" || m.memberId.length === 0) {
        errors.push({
          code: "INVALID_PARAMS",
          message:
            "Work asset member memberId is required and must be a non-empty string",
          path: `${path}.memberId`,
        });
      } else if (seenMemberIds.has(m.memberId)) {
        errors.push({
          code: "INVALID_PARAMS",
          message: `Work asset member memberId ${m.memberId} is not unique within the asset`,
          path: `${path}.memberId`,
        });
      } else {
        seenMemberIds.add(m.memberId);
      }
      if (
        typeof m.mediaId !== "string" ||
        m.mediaId.length === 0
      ) {
        errors.push({
          code: "INVALID_PARAMS",
          message:
            "Work asset member mediaId is required and must be a non-empty string",
          path: `${path}.mediaId`,
        });
      } else if (
        action.type === "workAsset/create" &&
        !project.mediaLibrary.items.some((item) => item.id === m.mediaId)
      ) {
        // Same create-time-only rule as the anchor media.
        errors.push({
          code: "MEDIA_NOT_FOUND",
          message: `Member ${index} media ${m.mediaId} not found`,
          path: `${path}.mediaId`,
        });
      }
      errors.push(...this.validateWorkAssetSourceRange(m.sourceRange, path));
      if (
        typeof m.relativeStart !== "number" ||
        !Number.isFinite(m.relativeStart) ||
        m.relativeStart < 0
      ) {
        errors.push({
          code: "INVALID_PARAMS",
          message:
            "Work asset member relativeStart must be a non-negative finite number",
          path: `${path}.relativeStart`,
        });
      }
      errors.push(...this.validateWorkAssetMemberLane(m.lane, path));
      if (m.snapshot === undefined) {
        errors.push({
          code: "INVALID_PARAMS",
          message: "Work asset member snapshot is required",
          path: `${path}.snapshot`,
        });
      } else {
        errors.push(
          ...this.validateWorkAssetClipSnapshot(m.snapshot, `${path}.snapshot`),
        );
      }
    });
    return errors;
  }

  private validateWorkAssetMemberLane(
    lane: unknown,
    basePath: string,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const path = `${basePath}.lane`;
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset member lane must be an object",
        path,
      });
      return errors;
    }
    const l = lane as { trackType?: unknown; laneOffset?: unknown };
    if (
      l.trackType !== "video" &&
      l.trackType !== "audio" &&
      l.trackType !== "image"
    ) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          'Work asset member lane trackType must be "video", "audio", or "image"',
        path: `${path}.trackType`,
      });
    }
    if (
      typeof l.laneOffset !== "number" ||
      !Number.isInteger(l.laneOffset) ||
      l.laneOffset < 0 ||
      l.laneOffset > 31
    ) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "Work asset member lane laneOffset must be an integer between 0 and 31",
        path: `${path}.laneOffset`,
      });
    }
    return errors;
  }

  private validateWorkAssetTransitions(value: unknown): ValidationError[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      return [
        {
          code: "INVALID_PARAMS",
          message: "Work asset transitions must be an array",
          path: "params.asset.transitions",
        },
      ];
    }
    const valid = value.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const e = entry as {
        fromMemberId?: unknown;
        toMemberId?: unknown;
        type?: unknown;
        duration?: unknown;
        params?: unknown;
      };
      return (
        typeof e.fromMemberId === "string" &&
        typeof e.toMemberId === "string" &&
        typeof e.type === "string" &&
        typeof e.duration === "number" &&
        Number.isFinite(e.duration) &&
        !!e.params &&
        typeof e.params === "object" &&
        !Array.isArray(e.params)
      );
    });
    return valid
      ? []
      : [
          {
            code: "INVALID_PARAMS",
            message:
              "Each work asset transition must reference two member ids with string type, finite duration, and object params",
            path: "params.asset.transitions",
          },
        ];
  }

  private validateWorkAssetUnsupportedParams(
    value: unknown,
  ): ValidationError[] {
    if (!Array.isArray(value)) {
      return [
        {
          code: "INVALID_PARAMS",
          message: "Work asset unsupportedParams must be an array",
          path: "params.asset.unsupportedParams",
        },
      ];
    }
    return value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { field?: unknown }).field === "string" &&
        typeof (entry as { reason?: unknown }).reason === "string",
    )
      ? []
      : [
          {
            code: "INVALID_PARAMS",
            message:
              "Each unsupported param must be an object with string field and reason",
            path: "params.asset.unsupportedParams",
          },
        ];
  }

  /**
   * Wide structural check of the captured snapshot: identity/number/array
   * invariants that the executor relies on. Deep effect/transform validation
   * stays with the existing clip validators applied at instantiate time.
   */
  private validateWorkAssetClipSnapshot(
    snapshot: unknown,
    basePath: string = "params.asset.clipSnapshot",
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const path = basePath;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset clipSnapshot must be an object",
        path,
      });
      return errors;
    }
    const s = snapshot as {
      duration?: unknown;
      inPoint?: unknown;
      outPoint?: unknown;
      effects?: unknown;
      audioEffects?: unknown;
      keyframes?: unknown;
      transform?: unknown;
      volume?: unknown;
      speed?: unknown;
      stabilization?: unknown;
    };
    if (typeof s.duration !== "number" || !Number.isFinite(s.duration) || s.duration < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "Work asset clipSnapshot duration must be a non-negative finite number",
        path: `${path}.duration`,
      });
    }
    const inPoint =
      typeof s.inPoint === "number" && Number.isFinite(s.inPoint)
        ? s.inPoint
        : null;
    const outPoint =
      typeof s.outPoint === "number" && Number.isFinite(s.outPoint)
        ? s.outPoint
        : null;
    if (inPoint === null || inPoint < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "Work asset clipSnapshot inPoint must be a non-negative finite number",
        path: `${path}.inPoint`,
      });
    }
    if (outPoint === null) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset clipSnapshot outPoint must be a finite number",
        path: `${path}.outPoint`,
      });
    } else if (inPoint !== null && outPoint <= inPoint) {
      errors.push({
        code: "INVALID_TIME_RANGE",
        message:
          "Work asset clipSnapshot outPoint must be greater than inPoint",
        path: `${path}.outPoint`,
      });
    }
    for (const key of ["effects", "audioEffects", "keyframes"] as const) {
      if (!Array.isArray(s[key])) {
        errors.push({
          code: "INVALID_PARAMS",
          message: `Work asset clipSnapshot ${key} must be an array`,
          path: `${path}.${key}`,
        });
      }
    }
    if (!s.transform || typeof s.transform !== "object" || Array.isArray(s.transform)) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset clipSnapshot transform must be an object",
        path: `${path}.transform`,
      });
    }
    if (typeof s.volume !== "number" || !Number.isFinite(s.volume) || s.volume < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "Work asset clipSnapshot volume must be a non-negative finite number",
        path: `${path}.volume`,
      });
    }
    if (
      s.speed !== undefined &&
      (typeof s.speed !== "number" || !Number.isFinite(s.speed) || s.speed <= 0)
    ) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Work asset clipSnapshot speed must be a positive finite number",
        path: `${path}.speed`,
      });
    }
    if (s.stabilization !== undefined) {
      const st = s.stabilization as {
        enabled?: unknown;
        strength?: unknown;
        cropMode?: unknown;
      };
      const stable =
        !!st &&
        typeof st === "object" &&
        typeof st.enabled === "boolean" &&
        typeof st.strength === "number" &&
        Number.isFinite(st.strength) &&
        (st.cropMode === "auto" || st.cropMode === "none");
      if (!stable) {
        errors.push({
          code: "INVALID_PARAMS",
          message:
            'Work asset clipSnapshot stabilization must be { enabled: boolean, strength: number, cropMode: "auto" | "none" }',
          path: `${path}.stabilization`,
        });
      }
    }
    return errors;
  }

  private validateClipAction(
    action: ClipAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    switch (action.type) {
      case "clip/add":
        if (
          action.params.clipId !== undefined &&
          (typeof action.params.clipId !== "string" || !action.params.clipId)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID must be a non-empty string when provided",
            path: "params.clipId",
          });
        } else if (
          action.params.clipId !== undefined &&
          timeline.tracks.some((track) =>
            track.clips.some((clip) => clip.id === action.params.clipId),
          )
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: `Clip with ID ${action.params.clipId} already exists`,
            path: "params.clipId",
          });
        }
        if (
          !action.params.trackId ||
          typeof action.params.trackId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Track ID is required and must be a string",
            path: "params.trackId",
          });
        } else {
          const track = this.findTrack(timeline, action.params.trackId);
          if (!track) {
            errors.push({
              code: "TRACK_NOT_FOUND",
              message: `Track with ID ${action.params.trackId} not found`,
              path: "params.trackId",
            });
          } else if (track.locked) {
            errors.push({
              code: "TRACK_LOCKED",
              message: `Track ${action.params.trackId} is locked`,
              path: "params.trackId",
            });
          }
        }
        if (
          !action.params.mediaId ||
          typeof action.params.mediaId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Media ID is required and must be a string",
            path: "params.mediaId",
          });
        } else {
          const mediaExists = project.mediaLibrary.items.some(
            (item) => item.id === action.params.mediaId,
          );
          if (!mediaExists) {
            errors.push({
              code: "MEDIA_NOT_FOUND",
              message: `Media with ID ${action.params.mediaId} not found`,
              path: "params.mediaId",
            });
          }
        }
        if (
          typeof action.params.startTime !== "number" ||
          action.params.startTime < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Start time must be a non-negative number",
            path: "params.startTime",
          });
        }
        break;

      case "clip/remove":
      case "clip/rippleDelete":
        if (!action.params.clipId || typeof action.params.clipId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID is required and must be a string",
            path: "params.clipId",
          });
        } else {
          const clip = this.findClip(timeline, action.params.clipId);
          if (!clip) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip with ID ${action.params.clipId} not found`,
              path: "params.clipId",
            });
          } else {
            const track = this.findTrack(timeline, clip.trackId);
            if (track?.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Track containing clip ${action.params.clipId} is locked`,
                path: "params.clipId",
              });
            }
          }
        }
        break;

      case "clip/move":
        if (!action.params.clipId || typeof action.params.clipId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID is required and must be a string",
            path: "params.clipId",
          });
        } else {
          const clip = this.findClip(timeline, action.params.clipId);
          if (!clip) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip with ID ${action.params.clipId} not found`,
              path: "params.clipId",
            });
          } else {
            const track = this.findTrack(timeline, clip.trackId);
            if (track?.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Track containing clip ${action.params.clipId} is locked`,
                path: "params.clipId",
              });
            }
          }
        }

        if (
          typeof action.params.startTime !== "number" ||
          action.params.startTime < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Start time must be a non-negative number",
            path: "params.startTime",
          });
        }

        if (action.params.trackId !== undefined) {
          if (typeof action.params.trackId !== "string") {
            errors.push({
              code: "INVALID_PARAMS",
              message: "Track ID must be a string",
              path: "params.trackId",
            });
          } else {
            const targetTrack = this.findTrack(timeline, action.params.trackId);
            if (!targetTrack) {
              errors.push({
                code: "TRACK_NOT_FOUND",
                message: `Target track with ID ${action.params.trackId} not found`,
                path: "params.trackId",
              });
            } else if (targetTrack.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Target track ${action.params.trackId} is locked`,
                path: "params.trackId",
              });
            }
          }
        }
        break;

      case "clip/trim":
        if (!action.params.clipId || typeof action.params.clipId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID is required and must be a string",
            path: "params.clipId",
          });
        } else {
          const clip = this.findClip(timeline, action.params.clipId);
          if (!clip) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip with ID ${action.params.clipId} not found`,
              path: "params.clipId",
            });
          } else {
            const track = this.findTrack(timeline, clip.trackId);
            if (track?.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Track containing clip ${action.params.clipId} is locked`,
                path: "params.clipId",
              });
            }
          }
        }

        if (
          action.params.inPoint !== undefined &&
          (typeof action.params.inPoint !== "number" ||
            action.params.inPoint < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "In-point must be a non-negative number",
            path: "params.inPoint",
          });
        }

        if (
          action.params.outPoint !== undefined &&
          (typeof action.params.outPoint !== "number" ||
            action.params.outPoint < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Out-point must be a non-negative number",
            path: "params.outPoint",
          });
        }
        if (
          action.params.inPoint !== undefined &&
          action.params.outPoint !== undefined &&
          action.params.outPoint <= action.params.inPoint
        ) {
          errors.push({
            code: "INVALID_TIME_RANGE",
            message: "Out-point must be greater than in-point",
            path: "params",
          });
        }
        break;

      case "clip/split":
        if (!action.params.clipId || typeof action.params.clipId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID is required and must be a string",
            path: "params.clipId",
          });
        } else {
          const clip = this.findClip(timeline, action.params.clipId);
          if (!clip) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip with ID ${action.params.clipId} not found`,
              path: "params.clipId",
            });
          } else {
            const track = this.findTrack(timeline, clip.trackId);
            if (track?.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Track containing clip ${action.params.clipId} is locked`,
                path: "params.clipId",
              });
            }
            if (typeof action.params.time === "number") {
              if (
                action.params.time <= clip.startTime ||
                action.params.time >= clip.startTime + clip.duration
              ) {
                errors.push({
                  code: "OUT_OF_BOUNDS",
                  message: `Split time must be within clip bounds (${
                    clip.startTime
                  } to ${clip.startTime + clip.duration})`,
                  path: "params.time",
                });
              }
            } else {
              errors.push({
                code: "INVALID_PARAMS",
                message: "Split time is required and must be a number",
                path: "params.time",
              });
            }
          }
        }
        break;

      case "clip/setBlendMode":
      case "clip/setBlendOpacity":
      case "clip/setEmphasisAnimation":
      case "clip/setColorGrading":
        if (!action.params.clipId || typeof action.params.clipId !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip ID is required and must be a string",
            path: "params.clipId",
          });
        } else {
          const clip = this.findClip(timeline, action.params.clipId);
          if (!clip) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip with ID ${action.params.clipId} not found`,
              path: "params.clipId",
            });
          } else {
            const track = this.findTrack(timeline, clip.trackId);
            if (track?.locked) {
              errors.push({
                code: "TRACK_LOCKED",
                message: `Track containing clip ${action.params.clipId} is locked`,
                path: "params.clipId",
              });
            }
          }
        }
        break;
    }

    return errors;
  }

  private validateEffectAction(
    action: EffectAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    // All effect actions require clipId
    if (!action.params.clipId || typeof action.params.clipId !== "string") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Clip ID is required and must be a string",
        path: "params.clipId",
      });
      return errors;
    }

    const clip = this.findClip(timeline, action.params.clipId);
    if (!clip) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip with ID ${action.params.clipId} not found`,
        path: "params.clipId",
      });
      return errors;
    }

    const track = this.findTrack(timeline, clip.trackId);
    if (track?.locked) {
      errors.push({
        code: "TRACK_LOCKED",
        message: `Track containing clip ${action.params.clipId} is locked`,
        path: "params.clipId",
      });
    }

    switch (action.type) {
      case "effect/add":
        if (
          !action.params.effectType ||
          typeof action.params.effectType !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Effect type is required and must be a string",
            path: "params.effectType",
          });
        }
        break;

      case "effect/remove":
      case "effect/update":
      case "effect/toggle":
      case "effect/reorder":
        if (
          !action.params.effectId ||
          typeof action.params.effectId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Effect ID is required and must be a string",
            path: "params.effectId",
          });
        } else {
          const effectExists = clip.effects.some(
            (e) => e.id === action.params.effectId,
          );
          if (!effectExists) {
            errors.push({
              code: "EFFECT_NOT_FOUND",
              message: `Effect with ID ${action.params.effectId} not found on clip`,
              path: "params.effectId",
            });
          }
        }

        if (action.type === "effect/reorder") {
          if (
            typeof action.params.newIndex !== "number" ||
            action.params.newIndex < 0 ||
            action.params.newIndex >= clip.effects.length
          ) {
            errors.push({
              code: "INVALID_PARAMS",
              message: `New index must be between 0 and ${
                clip.effects.length - 1
              }`,
              path: "params.newIndex",
            });
          }
        }

        if (
          action.type === "effect/toggle" &&
          typeof action.params.enabled !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Enabled parameter must be a boolean",
            path: "params.enabled",
          });
        }
        break;
    }

    return errors;
  }

  private validateTransformAction(
    action: TransformAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    if (!action.params.clipId || typeof action.params.clipId !== "string") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Clip ID is required and must be a string",
        path: "params.clipId",
      });
      return errors;
    }

    const clip = this.findClip(timeline, action.params.clipId);
    if (!clip) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip with ID ${action.params.clipId} not found`,
        path: "params.clipId",
      });
      return errors;
    }

    const track = this.findTrack(timeline, clip.trackId);
    if (track?.locked) {
      errors.push({
        code: "TRACK_LOCKED",
        message: `Track containing clip ${action.params.clipId} is locked`,
        path: "params.clipId",
      });
    }

    if (
      !action.params.transform ||
      typeof action.params.transform !== "object"
    ) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Transform is required and must be an object",
        path: "params.transform",
      });
    }

    return errors;
  }

  private validateKeyframeAction(
    action: KeyframeAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    if (action.type === "keyframe/setAll") {
      return errors;
    }

    if (!action.params.clipId || typeof action.params.clipId !== "string") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Clip ID is required and must be a string",
        path: "params.clipId",
      });
      return errors;
    }

    const clip = this.findClip(timeline, action.params.clipId);
    if (!clip) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip with ID ${action.params.clipId} not found`,
        path: "params.clipId",
      });
      return errors;
    }

    const track = this.findTrack(timeline, clip.trackId);
    if (track?.locked) {
      errors.push({
        code: "TRACK_LOCKED",
        message: `Track containing clip ${action.params.clipId} is locked`,
        path: "params.clipId",
      });
    }

    if (!action.params.property || typeof action.params.property !== "string") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Property is required and must be a string",
        path: "params.property",
      });
    }

    if (typeof action.params.time !== "number" || action.params.time < 0) {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Time is required and must be a non-negative number",
        path: "params.time",
      });
    }

    return errors;
  }

  private validateTransitionAction(
    action: TransitionAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    switch (action.type) {
      case "transition/add":
        if (
          !action.params.clipAId ||
          typeof action.params.clipAId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip A ID is required and must be a string",
            path: "params.clipAId",
          });
        }

        if (
          !action.params.clipBId ||
          typeof action.params.clipBId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Clip B ID is required and must be a string",
            path: "params.clipBId",
          });
        }

        if (
          typeof action.params.duration !== "number" ||
          action.params.duration <= 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Duration must be a positive number",
            path: "params.duration",
          });
        }
        if (action.params.clipAId && action.params.clipBId) {
          const clipA = this.findClip(timeline, action.params.clipAId);
          const clipB = this.findClip(timeline, action.params.clipBId);

          if (!clipA) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip A with ID ${action.params.clipAId} not found`,
              path: "params.clipAId",
            });
          }

          if (!clipB) {
            errors.push({
              code: "CLIP_NOT_FOUND",
              message: `Clip B with ID ${action.params.clipBId} not found`,
              path: "params.clipBId",
            });
          }

          if (clipA && clipB) {
            if (clipA.trackId !== clipB.trackId) {
              errors.push({
                code: "INVALID_PARAMS",
                message: "Clips must be on the same track for transition",
                path: "params",
              });
            }
            const clipAEnd = clipA.startTime + clipA.duration;
            const clipBEnd = clipB.startTime + clipB.duration;
            const tolerance = 0.001;

            const aBeforeB = Math.abs(clipAEnd - clipB.startTime) < tolerance;
            const bBeforeA = Math.abs(clipBEnd - clipA.startTime) < tolerance;

            if (!aBeforeB && !bBeforeA) {
              errors.push({
                code: "INVALID_PARAMS",
                message: "Clips must be adjacent for transition",
                path: "params",
              });
            }
          }
        }
        break;

      case "transition/set": {
        const transition = action.params.transition as
          | { id?: unknown; clipAId?: unknown }
          | undefined;
        if (
          !transition ||
          typeof transition.id !== "string" ||
          typeof transition.clipAId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "A valid transition with id and clipAId is required",
            path: "params.transition",
          });
        } else if (!this.findClip(timeline, transition.clipAId)) {
          errors.push({
            code: "CLIP_NOT_FOUND",
            message: `Clip A with ID ${transition.clipAId} not found`,
            path: "params.transition.clipAId",
          });
        }
        break;
      }

      case "transition/remove":
      case "transition/update":
        if (
          !action.params.transitionId ||
          typeof action.params.transitionId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Transition ID is required and must be a string",
            path: "params.transitionId",
          });
        }

        if (
          action.type === "transition/update" &&
          action.params.duration !== undefined
        ) {
          if (
            typeof action.params.duration !== "number" ||
            action.params.duration <= 0
          ) {
            errors.push({
              code: "INVALID_PARAMS",
              message: "Duration must be a positive number",
              path: "params.duration",
            });
          }
        }
        break;
    }

    return errors;
  }

  private validateAudioAction(
    action: AudioAction,
    project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const timeline = project.timeline;

    if (!action.params.clipId || typeof action.params.clipId !== "string") {
      errors.push({
        code: "INVALID_PARAMS",
        message: "Clip ID is required and must be a string",
        path: "params.clipId",
      });
      return errors;
    }

    const clip = this.findClip(timeline, action.params.clipId);
    if (!clip) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip with ID ${action.params.clipId} not found`,
        path: "params.clipId",
      });
      return errors;
    }

    const track = this.findTrack(timeline, clip.trackId);
    if (track?.locked) {
      errors.push({
        code: "TRACK_LOCKED",
        message: `Track containing clip ${action.params.clipId} is locked`,
        path: "params.clipId",
      });
    }

    switch (action.type) {
      case "audio/setVolume":
        if (
          typeof action.params.volume !== "number" ||
          action.params.volume < 0 ||
          action.params.volume > 4
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Volume must be a number between 0 and 4",
            path: "params.volume",
          });
        }
        break;

      case "audio/setFade":
        if (
          action.params.fadeIn !== undefined &&
          (typeof action.params.fadeIn !== "number" || action.params.fadeIn < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Fade-in must be a non-negative number",
            path: "params.fadeIn",
          });
        }

        if (
          action.params.fadeOut !== undefined &&
          (typeof action.params.fadeOut !== "number" ||
            action.params.fadeOut < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Fade-out must be a non-negative number",
            path: "params.fadeOut",
          });
        }
        break;

      case "audio/addAutomation":
        if (!Array.isArray(action.params.points)) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Automation points must be an array",
            path: "params.points",
          });
        }
        break;

      case "audio/addEffect": {
        const effect = action.params.effect as { id?: unknown } | undefined;
        if (!effect || typeof effect.id !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "A valid effect object with an id is required",
            path: "params.effect",
          });
        }
        break;
      }

      case "audio/removeEffect":
      case "audio/updateEffect":
      case "audio/toggleEffect":
        if (
          !action.params.effectId ||
          typeof action.params.effectId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Effect ID is required and must be a string",
            path: "params.effectId",
          });
        } else {
          const effectExists = (clip.audioEffects ?? []).some(
            (e) => e.id === action.params.effectId,
          );
          if (!effectExists) {
            errors.push({
              code: "EFFECT_NOT_FOUND",
              message: `Audio effect with ID ${action.params.effectId} not found on clip`,
              path: "params.effectId",
            });
          }
        }
        if (
          action.type === "audio/toggleEffect" &&
          typeof action.params.enabled !== "boolean"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Enabled parameter must be a boolean",
            path: "params.enabled",
          });
        }
        break;
    }

    return errors;
  }

  private validateSubtitleAction(
    action: SubtitleAction,
    _project: Project,
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    switch (action.type) {
      case "subtitle/import":
        if (
          !action.params.srtContent ||
          typeof action.params.srtContent !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "SRT content is required and must be a string",
            path: "params.srtContent",
          });
        }
        break;

      case "subtitle/add":
        if (!action.params.text || typeof action.params.text !== "string") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Subtitle text is required and must be a string",
            path: "params.text",
          });
        }

        if (
          typeof action.params.startTime !== "number" ||
          action.params.startTime < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Start time must be a non-negative number",
            path: "params.startTime",
          });
        }

        if (
          typeof action.params.endTime !== "number" ||
          action.params.endTime < 0
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "End time must be a non-negative number",
            path: "params.endTime",
          });
        }

        if (
          typeof action.params.startTime === "number" &&
          typeof action.params.endTime === "number" &&
          action.params.endTime <= action.params.startTime
        ) {
          errors.push({
            code: "INVALID_TIME_RANGE",
            message: "End time must be greater than start time",
            path: "params",
          });
        }
        break;

      case "subtitle/update":
        if (
          !action.params.subtitleId ||
          typeof action.params.subtitleId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Subtitle ID is required and must be a string",
            path: "params.subtitleId",
          });
        }

        if (
          action.params.startTime !== undefined &&
          (typeof action.params.startTime !== "number" ||
            action.params.startTime < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Start time must be a non-negative number",
            path: "params.startTime",
          });
        }

        if (
          action.params.endTime !== undefined &&
          (typeof action.params.endTime !== "number" ||
            action.params.endTime < 0)
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "End time must be a non-negative number",
            path: "params.endTime",
          });
        }
        break;

      case "subtitle/remove":
        if (
          !action.params.subtitleId ||
          typeof action.params.subtitleId !== "string"
        ) {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Subtitle ID is required and must be a string",
            path: "params.subtitleId",
          });
        }
        break;

      case "subtitle/setStyle":
        if (!action.params.style || typeof action.params.style !== "object") {
          errors.push({
            code: "INVALID_PARAMS",
            message: "Style is required and must be an object",
            path: "params.style",
          });
        }
        break;
    }

    return errors;
  }

  private findTrack(timeline: Timeline, trackId: string): Track | null {
    return timeline.tracks.find((t) => t.id === trackId) || null;
  }

  private findClip(timeline: Timeline, clipId: string): Clip | null {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }
}
