import type { Action, ValidationResult } from "../../types/actions";
import type { AudioDuckingSnapshot } from "../../types/actions";
import type { Project } from "../../types/project";
import type { AutomationPoint, Clip } from "../../types/timeline";
import { registerActionHandler } from "../registry";
import type { ActionHandler } from "../registry";
import { findClip, patchClip } from "./clip-helpers";
import { VOLUME_MIN, VOLUME_MAX } from "../../audio/volume-automation";

const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Upper bound on persisted ducking points (envelope output for long clips). */
const MAX_DUCKING_POINTS = 1000;

const isAutomationPoint = (v: unknown): v is AutomationPoint => {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as Partial<AutomationPoint>;
  return (
    isNumber(candidate.time) &&
    candidate.time >= 0 &&
    isNumber(candidate.value) &&
    candidate.value >= VOLUME_MIN &&
    candidate.value <= VOLUME_MAX
  );
};

const isDuckingSnapshot = (v: unknown): v is AudioDuckingSnapshot => {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as Partial<AudioDuckingSnapshot>;
  return (
    typeof candidate.enabled === "boolean" &&
    (typeof candidate.sourceTrackId === "string" ||
      candidate.sourceTrackId === null) &&
    isNumber(candidate.threshold) &&
    isNumber(candidate.reduction) &&
    isNumber(candidate.attack) &&
    isNumber(candidate.release) &&
    isNumber(candidate.holdTime)
  );
};

interface DuckingParams {
  clipId: string;
  settings: AudioDuckingSnapshot | null;
  points: AutomationPoint[];
}

const parseDuckingParams = (action: Action): DuckingParams =>
  action.params as unknown as DuckingParams;

const clonePoints = (points: AutomationPoint[]): AutomationPoint[] =>
  points.map((point) => ({ ...point }));

const priorDuckingState = (
  project: Project,
  clipId: string,
): { settings: AudioDuckingSnapshot | null; points: AutomationPoint[] } | null => {
  const prior = findClip(project, clipId);
  if (!prior) return null;
  const points = prior.automation?.volume ?? [];
  const rawSettings = prior.metadata?.audioDucking;
  const settings = isDuckingSnapshot(rawSettings)
    ? { ...rawSettings }
    : null;
  if (points.length === 0 && settings === null) return null;
  return { settings, points: clonePoints(points) };
};

/**
 * Write the two ducking fields as ONE undoable unit: the volume automation
 * points the audible chain consumes (realtime preview AND export evaluate
 * clip.automation.volume through resolveClipVolumeAutomation) and the
 * metadata.audioDucking panel-readback snapshot (AudioDuckingSection restores
 * its sliders from it; the audible result is carried solely by the automation
 * points). `settings: null` removes the metadata field and an empty `points`
 * array removes the volume field, so the inverse restores the exact prior
 * two-field state — including "absent" (the speed/setRampData
 * "merged persistence" pattern).
 */
const audioSetDucking: ActionHandler = {
  type: "audio/setDucking",
  synchronous: true,
  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as Partial<DuckingParams>;
    const errors = [];
    if (
      typeof params.clipId !== "string" ||
      !findClip(project, params.clipId)
    ) {
      errors.push({
        code: "CLIP_NOT_FOUND",
        message: `Clip not found: ${String(params.clipId)}`,
      });
    }
    if (params.settings !== null && !isDuckingSnapshot(params.settings)) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "settings must be a ducking snapshot (enabled, sourceTrackId, threshold, reduction, attack, release, holdTime) or null",
      });
    }
    if (
      !Array.isArray(params.points) ||
      params.points.length > MAX_DUCKING_POINTS ||
      !params.points.every(isAutomationPoint)
    ) {
      errors.push({
        code: "INVALID_PARAMS",
        message: `points must be an array of at most ${MAX_DUCKING_POINTS} automation points (time >= 0, value in [${VOLUME_MIN}, ${VOLUME_MAX}])`,
      });
    } else if (params.points.length === 0 && params.settings == null) {
      errors.push({
        code: "INVALID_PARAMS",
        message:
          "a ducking action needs either settings or a non-empty points array — use audio/clearDucking to remove ducking",
      });
    }
    return { valid: errors.length === 0, errors };
  },
  apply(action: Action, project: Project): void {
    const { clipId, settings, points } = parseDuckingParams(action);
    const clip = findClip(project, clipId);
    if (!clip) return;

    // Merge onto the prior containers so unrelated siblings (pan automation,
    // template metadata records, ...) survive untouched; drop a container
    // that ends up empty, matching the store's previous clear semantics.
    const nextAutomation: Record<string, AutomationPoint[]> = {
      ...(clip.automation ?? {}),
    };
    if (points.length > 0) {
      nextAutomation.volume = clonePoints(points);
    } else {
      delete nextAutomation.volume;
    }

    const nextMetadata: Record<string, unknown> = {
      ...(clip.metadata ?? {}),
    };
    if (settings != null) {
      nextMetadata.audioDucking = { ...settings };
    } else {
      delete nextMetadata.audioDucking;
    }

    patchClip(project, clipId, {
      automation:
        Object.keys(nextAutomation).length > 0
          ? (nextAutomation as Clip["automation"])
          : undefined,
      metadata:
        Object.keys(nextMetadata).length > 0
          ? (nextMetadata as Clip["metadata"])
          : undefined,
    });
  },
  invert(action: Action, projectBefore: Project): Action | null {
    const { clipId } = parseDuckingParams(action);
    const prior = priorDuckingState(projectBefore, clipId);
    if (!prior) {
      // Prior state had no ducking at all — undo is a clean removal.
      return {
        type: "audio/clearDucking",
        id: `inverse-${action.id}`,
        timestamp: Date.now(),
        params: { clipId },
      };
    }
    return {
      type: "audio/setDucking",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: {
        clipId,
        settings: prior.settings,
        points: prior.points,
      },
    };
  },
};

/** Removes both ducking fields (dropping emptied containers) — GUI Remove parity. */
const audioClearDucking: ActionHandler = {
  type: "audio/clearDucking",
  synchronous: true,
  validate(action: Action, project: Project): ValidationResult {
    const params = action.params as { clipId?: unknown };
    if (typeof params.clipId === "string" && findClip(project, params.clipId)) {
      return { valid: true, errors: [] };
    }
    return {
      valid: false,
      errors: [
        {
          code: "CLIP_NOT_FOUND",
          message: `Clip not found: ${String(params.clipId)}`,
        },
      ],
    };
  },
  apply(action: Action, project: Project): void {
    const { clipId } = parseDuckingParams(action);
    const clip = findClip(project, clipId);
    if (!clip) return;

    const nextAutomation: Record<string, AutomationPoint[]> = {
      ...(clip.automation ?? {}),
    };
    delete nextAutomation.volume;

    const nextMetadata: Record<string, unknown> = {
      ...(clip.metadata ?? {}),
    };
    delete nextMetadata.audioDucking;

    patchClip(project, clipId, {
      automation:
        Object.keys(nextAutomation).length > 0
          ? (nextAutomation as Clip["automation"])
          : undefined,
      metadata:
        Object.keys(nextMetadata).length > 0
          ? (nextMetadata as Clip["metadata"])
          : undefined,
    });
  },
  invert(action: Action, projectBefore: Project): Action | null {
    const { clipId } = parseDuckingParams(action);
    const prior = priorDuckingState(projectBefore, clipId);
    if (!prior) return null;
    return {
      type: "audio/setDucking",
      id: `inverse-${action.id}`,
      timestamp: Date.now(),
      params: {
        clipId,
        settings: prior.settings,
        points: prior.points,
      },
    };
  },
};

const handlers = [audioSetDucking, audioClearDucking];

for (const handler of handlers) {
  registerActionHandler(handler);
}
