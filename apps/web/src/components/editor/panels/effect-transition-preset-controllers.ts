/**
 * Save / apply / rename / delete controllers for custom effect and
 * transition presets, shared by the inspector capture entries and the
 * merged panel sections.
 *
 * Application always expands through the shared `expandPresetActions`
 * helper and runs as one `executeActionBatch` undo unit, so a preset
 * lands in the project exactly like the equivalent hand-made actions.
 *
 * Transition durations are pre-clamped to the per-cut placement cap
 * (GUI-facing UX): the agent-side expansion path rejects an over-cap
 * duration with PLACEMENT_INVALID, while the GUI clamps to
 * `transitionPlacementMaxDuration` first and tells the user what was
 * applied. Both behaviors share the same cap function.
 */
import i18n from "../../../i18n";
import {
  EFFECT_DEFINITIONS,
  TRANSITION_TYPES,
  type TransitionType,
} from "@openreel/core/types/effects";
import {
  PRESET_PAYLOAD_SCHEMA_VERSION,
  type CustomPresetRecord,
  type EffectPresetItem,
  type TransitionPresetPayload,
} from "@openreel/core/presets/types";
import {
  getTransitionDefaultParams,
  validateEffectPresetEffects,
  validatePresetName,
  validateTransitionPresetPayload,
} from "@openreel/core/presets/validate";
import { validateSvgContent } from "@openreel/core/graphics/svg-validation";
import type { Clip, Project } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useUIStore } from "../../../stores/ui-store";
import { toast } from "../../../stores/notification-store";
import { getCustomPresetService } from "../../../services/custom-presets/preset-service";
import {
  DEFAULT_GRAPHICS_PRESET_DURATION_SEC,
  expandPresetActions,
  transitionPlacementMaxDuration,
} from "../../../services/custom-presets/apply";
import { dedupePresetName } from "./TextPresetsPanel";

/** Shared so the inspector capture entries can pre-deduce default names. */
export { dedupePresetName };

function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options) as string;
}

/* ------------------------------ effects ------------------------------ */

export type EffectPresetCapture =
  | {
      readonly ok: true;
      /** Validated, engine-default-clean effect items ready to persist. */
      readonly effects: readonly EffectPresetItem[];
      /** Raw parameter keys dropped because the engine does not define them. */
      readonly droppedParams: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unsupported-type"
        | "unknown-type"
        | "engine-managed"
        | "invalid-params";
      /**
       * Dedicated i18n key for effect types whose rejection copy explains a
       * specific modeling boundary instead of the generic unknown-type line
       * (chromaKey lives in clip keying settings, shader params depend on
       * the chosen shader).
       */
      readonly messageKey?: "assets.effectPresets.chromaKeyNotPreset" | "assets.effectPresets.shaderNotPreset";
      readonly message: string;
    };

/** Effect types that are real engine features but never preset material. */
const ENGINE_MANAGED_EFFECT_TYPES: Record<
  string,
  {
    messageKey:
      | "assets.effectPresets.chromaKeyNotPreset"
      | "assets.effectPresets.shaderNotPreset";
  }
> = {
  chromaKey: { messageKey: "assets.effectPresets.chromaKeyNotPreset" },
  shader: { messageKey: "assets.effectPresets.shaderNotPreset" },
};

/**
 * Captures one effect-stack item (type + current parameters) as a preset
 * draft. Effect types are closed to the engine's layer effect set: audio
 * effects and unknown types are rejected outright, chromaKey/shader never
 * reach that check (dedicated copy via ENGINE_MANAGED_EFFECT_TYPES), and
 * parameter keys the engine does not define are reported back as dropped
 * so the UI can confirm with the user instead of discarding them silently.
 */
export function captureEffectPresetItem(
  effectType: string,
  rawParams: Record<string, unknown> | undefined,
): EffectPresetCapture {
  const engineManaged = ENGINE_MANAGED_EFFECT_TYPES[effectType];
  if (engineManaged) {
    return {
      ok: false,
      reason: "engine-managed",
      messageKey: engineManaged.messageKey,
      message: tr(engineManaged.messageKey),
    };
  }
  const checked = validateEffectPresetEffects([
    { type: effectType, params: rawParams ?? {} },
  ]);
  if (checked.ok) {
    return { ok: true, effects: checked.value, droppedParams: [] };
  }
  if (
    checked.code === "UNSUPPORTED_EFFECT_TYPE" ||
    checked.code === "UNKNOWN_EFFECT_TYPE"
  ) {
    return {
      ok: false,
      reason:
        checked.code === "UNSUPPORTED_EFFECT_TYPE"
          ? "unsupported-type"
          : "unknown-type",
      message: checked.message,
    };
  }
  // Unknown parameter keys are recoverable: filter to the engine-defined
  // keys and re-validate. Anything still failing (bad values) is a reject.
  const definition = EFFECT_DEFINITIONS.find((def) => def.type === effectType);
  const knownKeys = new Set((definition?.params ?? []).map((param) => param.key));
  const droppedParams = Object.keys(rawParams ?? {}).filter(
    (key) => !knownKeys.has(key),
  );
  if (definition && droppedParams.length > 0) {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawParams ?? {})) {
      if (knownKeys.has(key)) filtered[key] = value;
    }
    const rechecked = validateEffectPresetEffects([
      { type: effectType, params: filtered },
    ]);
    if (rechecked.ok) {
      return { ok: true, effects: rechecked.value, droppedParams };
    }
    return {
      ok: false,
      reason: "invalid-params",
      message: rechecked.message,
    };
  }
  return { ok: false, reason: "invalid-params", message: checked.message };
}

/** Persists the captured effect items under a deduplicated name. */
export async function saveEffectPreset(input: {
  readonly name: string;
  readonly effects: readonly EffectPresetItem[];
  readonly existingNames: readonly string[];
}): Promise<CustomPresetRecord | null> {
  const finalName = dedupePresetName(input.name, input.existingNames);
  const result = await getCustomPresetService().create({
    kind: "effect",
    name: finalName,
    payload: {
      schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
      kind: "effect",
      effects: input.effects,
    },
  });
  if (!result.ok) {
    toast.error(tr("assets.effectPresets.saveFailed"), result.message);
    return null;
  }
  toast.success(tr("assets.effectPresets.saved", { name: result.value.name }));
  return result.value;
}

/**
 * Applies an effect preset to the current timeline selection: one expanded
 * `effect/add` batch, one undo unit. Effect presets cover the timeline clip
 * effect stack only — overlay clips (text/shapes) use the text engine's own
 * effect list and report a dedicated hint when targeted.
 */
export async function applyEffectPresetToSelectedClips(
  preset: Pick<CustomPresetRecord, "name" | "payload">,
): Promise<boolean> {
  const selectedIds = useUIStore.getState().getSelectedClipIds();
  if (selectedIds.length === 0) {
    toast.warning(
      tr("assets.effectPresets.applyNeedsSelection"),
      tr("assets.effectPresets.applyNeedsSelectionHint"),
    );
    return false;
  }
  const state = useProjectStore.getState();
  const expanded = expandPresetActions({
    preset: { name: preset.name, payload: preset.payload },
    target: { kind: "effect", clipIds: selectedIds },
    project: state.project,
  });
  if (!expanded.ok) {
    toast.error(
      tr("assets.effectPresets.applyFailed"),
      expanded.code === "TARGET_NOT_FOUND"
        ? tr("assets.effectPresets.applyTimelineOnly")
        : expanded.message,
    );
    return false;
  }
  state.executeActionBatch(expanded.actions, {
    groupLabel: expanded.groupLabel,
    historyOwner: "human",
  });
  toast.success(tr("assets.effectPresets.applied", { name: preset.name }));
  return true;
}

/* ---------------------------- transitions ---------------------------- */

export type TransitionPresetCapture =
  | {
      readonly ok: true;
      readonly payload: Omit<TransitionPresetPayload, "schemaVersion" | "kind">;
      /** Keys dropped because the engine default table does not define them. */
      readonly droppedKeys: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "unknown-type" | "invalid";
      readonly message: string;
    };

/**
 * Captures the transition editor's current configuration (type + duration +
 * parameters). Parameters are whitelist-filtered against the engine's live
 * default table (e.g. the per-transition audio fade toggle is a playback
 * behavior, not a preset parameter); dropped keys are reported so the UI can
 * confirm with the user instead of discarding silently.
 */
export function captureTransitionPreset(
  transitionType: string,
  durationSec: number,
  rawParams: Record<string, unknown>,
): TransitionPresetCapture {
  if (!(TRANSITION_TYPES as readonly string[]).includes(transitionType)) {
    return {
      ok: false,
      reason: "unknown-type",
      message: `engine does not provide this transition: ${transitionType}`,
    };
  }
  const defaults = getTransitionDefaultParams(transitionType as TransitionType);
  const droppedKeys = Object.keys(rawParams).filter(
    (key) => !Object.hasOwn(defaults, key),
  );
  const filteredParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (Object.hasOwn(defaults, key)) filteredParams[key] = value;
  }
  const checked = validateTransitionPresetPayload(
    transitionType,
    filteredParams,
    durationSec,
  );
  if (!checked.ok) {
    return { ok: false, reason: "invalid", message: checked.message };
  }
  return { ok: true, payload: checked.value, droppedKeys };
}

/** Persists the captured transition configuration under a deduplicated name. */
export async function saveTransitionPreset(input: {
  readonly name: string;
  readonly payload: Omit<TransitionPresetPayload, "schemaVersion" | "kind">;
  readonly existingNames: readonly string[];
}): Promise<CustomPresetRecord | null> {
  const finalName = dedupePresetName(input.name, input.existingNames);
  const result = await getCustomPresetService().create({
    kind: "transition",
    name: finalName,
    payload: {
      schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
      kind: "transition",
      ...input.payload,
    },
  });
  if (!result.ok) {
    toast.error(tr("assets.transitionPresets.saveFailed"), result.message);
    return null;
  }
  toast.success(tr("assets.transitionPresets.saved", { name: result.value.name }));
  return result.value;
}

export interface SelectedCut {
  readonly clipA: Clip;
  readonly clipB?: Clip;
}

/**
 * Resolves the cut the current selection refers to: two selected clips form
 * a cut when consecutive on one track; a single selected clip uses its cut to
 * the next clip (or from the previous clip at the track end, or its out
 * point when alone). Consecutiveness is positional only — true cut-point
 * adjacency (within epsilon) is enforced by the expansion layer. Null when
 * nothing compatible exists.
 */
export function resolveSelectedCut(
  project: Project,
  selectedClipIds: readonly string[],
): SelectedCut | null {
  const selectedIds = new Set(selectedClipIds);
  const selectedCount = selectedIds.size;
  if (selectedCount === 0) return null;

  for (const track of project.timeline.tracks) {
    const sorted = [...track.clips].sort(
      (first, second) => first.startTime - second.startTime,
    );
    let cut: SelectedCut | null = null;
    if (selectedCount > 1) {
      for (let index = 0; index < sorted.length - 1; index += 1) {
        if (
          selectedIds.has(sorted[index]!.id) &&
          selectedIds.has(sorted[index + 1]!.id)
        ) {
          cut = { clipA: sorted[index]!, clipB: sorted[index + 1] };
          break;
        }
      }
    } else {
      const selectedIndex = sorted.findIndex((clip) =>
        selectedIds.has(clip.id),
      );
      if (selectedIndex >= 0) {
        const selected = sorted[selectedIndex]!;
        const next = sorted[selectedIndex + 1];
        const previous = sorted[selectedIndex - 1];
        if (next) {
          cut = { clipA: selected, clipB: next };
        } else if (previous) {
          cut = { clipA: previous, clipB: selected };
        } else {
          cut = { clipA: selected };
        }
      }
    }
    if (cut) return cut;
  }
  return null;
}

export interface TransitionPresetApplyResult {
  readonly ok: boolean;
  /** Set when the requested duration exceeded the placement cap. */
  readonly clamped?: {
    readonly requested: number;
    readonly applied: number;
    readonly maxDuration: number;
  };
}

/**
 * Applies a transition preset to the selected cut. The requested duration is
 * pre-clamped to the placement cap with a visible hint — unlike the agent
 * path, which rejects an over-cap duration outright (PLACEMENT_INVALID), the
 * GUI degrades gracefully and tells the user what was actually applied.
 */
export async function applyTransitionPresetToSelectedCut(
  preset: Pick<CustomPresetRecord, "name" | "payload">,
): Promise<TransitionPresetApplyResult> {
  const selectedIds = useUIStore.getState().getSelectedClipIds();
  if (selectedIds.length === 0) {
    toast.warning(
      tr("assets.transitionPresets.applyNeedsSelection"),
      tr("assets.transitionPresets.applyNeedsSelectionHint"),
    );
    return { ok: false };
  }
  const state = useProjectStore.getState();
  if (preset.payload.kind !== "transition") {
    toast.error(
      tr("assets.transitionPresets.applyFailed"),
      tr("assets.transitionPresets.kindMismatch"),
    );
    return { ok: false };
  }
  const cut = resolveSelectedCut(state.project, selectedIds);
  if (!cut) {
    toast.warning(
      tr("assets.transitionPresets.noCutTitle"),
      tr("assets.transitionPresets.noCutBody"),
    );
    return { ok: false };
  }

  const payload = preset.payload;
  const maxDuration = transitionPlacementMaxDuration(cut.clipA, cut.clipB);
  const requested = payload.durationSec ?? 1;
  const appliedDuration = Math.min(requested, maxDuration);
  const effectivePayload =
    appliedDuration < requested ? { ...payload, durationSec: appliedDuration } : payload;

  const expanded = expandPresetActions({
    preset: { name: preset.name, payload: effectivePayload },
    target: {
      kind: "transition",
      clipAId: cut.clipA.id,
      ...(cut.clipB ? { clipBId: cut.clipB.id } : {}),
    },
    project: state.project,
  });
  if (!expanded.ok) {
    toast.error(tr("assets.transitionPresets.applyFailed"), expanded.message);
    return { ok: false };
  }
  state.executeActionBatch(expanded.actions, {
    groupLabel: expanded.groupLabel,
    historyOwner: "human",
  });
  if (appliedDuration < requested) {
    toast.warning(
      tr("assets.transitionPresets.clampedTitle"),
      tr("assets.transitionPresets.clampedBody", {
        requested,
        applied: appliedDuration,
        max: maxDuration,
      }),
    );
  } else {
    toast.success(tr("assets.transitionPresets.applied", { name: preset.name }));
  }
  return {
    ok: true,
    ...(appliedDuration < requested
      ? { clamped: { requested, applied: appliedDuration, maxDuration } }
      : {}),
  };
}

/* --------------------- shared rename / delete --------------------- */

/**
 * Renames through the service with core name validation; failures surface
 * as error toasts. `i18nPrefix` selects the caller's namespace
 * ("assets.effectPresets" / "assets.transitionPresets" /
 * "assets.graphicsPresets").
 */
export async function renameCustomPreset(
  preset: Pick<CustomPresetRecord, "id" | "name">,
  draftName: string,
  i18nPrefix:
    | "assets.effectPresets"
    | "assets.transitionPresets"
    | "assets.graphicsPresets",
): Promise<boolean> {
  const validated = validatePresetName(draftName);
  if (!validated.ok) {
    toast.error(tr(`${i18nPrefix}.renameFailed`), validated.message);
    return false;
  }
  if (validated.value === preset.name) return true;
  const result = await getCustomPresetService().update(preset.id, {
    name: validated.value,
  });
  if (!result.ok) {
    toast.error(tr(`${i18nPrefix}.renameFailed`), result.message);
    return false;
  }
  toast.success(tr(`${i18nPrefix}.renamed`), validated.value);
  return true;
}

/**
 * Deletes after an explicit confirmation whose copy states the isolation
 * promise: clips already using the preset keep their own copied parameters
 * and are never affected by the removal.
 */
export async function deleteCustomPresetWithConfirm(
  preset: Pick<CustomPresetRecord, "id" | "name">,
  i18nPrefix:
    | "assets.effectPresets"
    | "assets.transitionPresets"
    | "assets.graphicsPresets",
): Promise<boolean> {
  if (!window.confirm(tr(`${i18nPrefix}.deleteConfirm`, { name: preset.name }))) {
    return false;
  }
  const result = await getCustomPresetService().remove(preset.id);
  if (!result.ok) {
    toast.error(tr(`${i18nPrefix}.deleteFailed`), result.message);
    return false;
  }
  toast.success(tr(`${i18nPrefix}.deleted`), preset.name);
  return true;
}

/* ------------------------------ graphics ------------------------------ */

export type GraphicsPresetCapture =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly message: string };

/**
 * Captures an SVG clip's source as a graphics preset draft. The same
 * DOM-free core validator (`validateSvgContent`) that gates Agent
 * preset.create and core SVG ingest runs here, so a GUI-saved graphics
 * preset and an agent-created one pass through identical validation.
 */
export function captureGraphicsPresetSvg(svg: unknown): GraphicsPresetCapture {
  if (typeof svg !== "string" || svg.trim().length === 0) {
    return { ok: false, message: tr("assets.graphicsPresets.emptySvg") };
  }
  const checked = validateSvgContent(svg);
  if (!checked.ok) {
    return { ok: false, message: checked.message };
  }
  return { ok: true, svg };
}

/** Persists the captured SVG source under a deduplicated name. */
export async function saveGraphicsPreset(input: {
  readonly name: string;
  readonly svg: string;
  readonly existingNames: readonly string[];
}): Promise<CustomPresetRecord | null> {
  const finalName = dedupePresetName(input.name, input.existingNames);
  const result = await getCustomPresetService().create({
    kind: "graphics",
    name: finalName,
    payload: {
      schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
      kind: "graphics",
      svg: input.svg,
    },
  });
  if (!result.ok) {
    toast.error(tr("assets.graphicsPresets.saveFailed"), result.message);
    return null;
  }
  toast.success(tr("assets.graphicsPresets.saved", { name: result.value.name }));
  return result.value;
}

/**
 * Applies a graphics preset by creating a NEW SVG clip: the payload is
 * expanded through the shared `expandPresetActions` graphics case
 * ([track/add?] + svg/create, one undo unit), placed on the first graphics
 * track (or a new one) at the playhead with the default preset duration.
 * The clip receives a copied-by-value snapshot of the payload, so deleting
 * the preset later never affects clips already created from it.
 */
export async function applyGraphicsPresetToPlayhead(
  preset: Pick<CustomPresetRecord, "name" | "payload">,
): Promise<boolean> {
  const state = useProjectStore.getState();
  const expanded = expandPresetActions({
    preset: { name: preset.name, payload: preset.payload },
    target: {
      kind: "graphics",
      startTime: useTimelineStore.getState().playheadPosition,
    },
    project: state.project,
  });
  if (!expanded.ok) {
    toast.error(tr("assets.graphicsPresets.applyFailed"), expanded.message);
    return false;
  }
  state.executeActionBatch(expanded.actions, {
    groupLabel: expanded.groupLabel,
    historyOwner: "human",
  });
  toast.success(
    tr("assets.graphicsPresets.applied", { name: preset.name }),
    tr("assets.graphicsPresets.appliedHint", {
      duration: DEFAULT_GRAPHICS_PRESET_DURATION_SEC,
    }),
  );
  return true;
}
