/**
 * Text tab presets section: the merged view of read-only built-in style
 * presets and the user's cross-project custom text presets.
 *
 * Application paths (both undoable):
 * - Click (built-in and custom) creates a NEW text clip at the playhead —
 *   the exact flow the built-in cards always used.
 * - "Apply to selected text" expands the preset through the shared
 *   `expandPresetActions` helper into a `text/update` action batch executed
 *   via `executeActionBatch`, so the whole application is one undo unit.
 *
 * Custom presets are captured from the currently selected text clip. The
 * capture whitelist-filters the style (presets are parameter-only, `shader`
 * never enters a preset) and any dropped field is confirmed with the user —
 * nothing is discarded silently.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../i18n";
import { Pencil, Plus, Trash2, Type } from "@/icons/lucide-compat";
import type { Project, TextStyle } from "@reelterminal/core";
import {
  MAX_SAMPLE_TEXT_LENGTH,
  TEXT_STYLE_FIELDS,
  validatePresetName,
  validatePresetPayload,
  validateTextPresetStyle,
} from "@reelterminal/core/presets/validate";
import {
  PRESET_PAYLOAD_SCHEMA_VERSION,
  type CustomPresetRecord,
  type TextPresetPayload,
} from "@reelterminal/core/presets/types";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { toast } from "../../../stores/notification-store";
import { useCustomPresets } from "../../../services/custom-presets/use-custom-presets";
import { getCustomPresetService } from "../../../services/custom-presets/preset-service";
import { expandPresetActions } from "../../../services/custom-presets/apply";
import { ToolcraftContextMenu as ContextMenu, type ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { TEXT_STYLE_PRESETS } from "./text-style-presets";

/* --------------------------- capture / naming --------------------------- */

export type TextPresetCapture =
  | {
      readonly ok: true;
      /** Whitelist-filtered, validated style ready to persist. */
      readonly style: Record<string, unknown>;
      /** Keys present on the clip style but outside the preset whitelist. */
      readonly droppedFields: readonly string[];
      readonly sampleText: string;
    }
  | { readonly ok: false; readonly reason: "no-text-selection" | "invalid-style"; readonly message?: string };

/**
 * Extracts the preset payload style from the currently selected text clip.
 * Whitelist fields are copied by value; anything outside the whitelist
 * (today: `shader`) is reported back as dropped so the UI can confirm with
 * the user instead of discarding silently.
 */
export function captureTextPresetFromSelection(
  project: Project,
  selectedClipIds: readonly string[],
): TextPresetCapture {
  const textClips = project.textClips ?? [];
  const clip = selectedClipIds
    .map((id) => textClips.find((candidate) => candidate.id === id))
    .find((found) => found !== undefined);
  if (!clip) {
    return { ok: false, reason: "no-text-selection" };
  }
  const source = clip.style as unknown as Record<string, unknown>;
  const droppedFields = Object.keys(source).filter(
    (key) => !(TEXT_STYLE_FIELDS as readonly string[]).includes(key),
  );
  const style: Record<string, unknown> = {};
  for (const field of TEXT_STYLE_FIELDS) {
    const value = source[field];
    if (value !== undefined) style[field] = value;
  }
  const checked = validateTextPresetStyle(style);
  if (!checked.ok) {
    return { ok: false, reason: "invalid-style", message: checked.message };
  }
  return {
    ok: true,
    style,
    droppedFields,
    sampleText: clip.text.slice(0, MAX_SAMPLE_TEXT_LENGTH),
  };
}

/**
 * Duplicate base names get a numeric suffix ("My Preset" -> "My Preset 2"),
 * mirroring the custom-font family convention: the caller must use the
 * returned name, it is never silently renamed.
 */
export function dedupePresetName(
  base: string,
  existingNames: readonly string[],
): string {
  const trimmed = base.trim();
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  if (trimmed.length === 0 || !taken.has(trimmed.toLowerCase())) return trimmed;
  let suffix = 2;
  while (taken.has(`${trimmed} ${suffix}`.toLowerCase())) suffix += 1;
  return `${trimmed} ${suffix}`;
}

/* ---------------------------- controller ops ---------------------------- */

function firstSelectedTextClipId(): string | undefined {
  const textClips = useProjectStore.getState().project.textClips ?? [];
  return useUIStore
    .getState()
    .getSelectedClipIds()
    .find((id) => textClips.some((clip) => clip.id === id));
}

/**
 * Click-apply for a custom preset: re-validates the payload at apply time
 * (defense in depth — the record may predate a validation change), then
 * creates a new text clip at the playhead with the preset style, exactly
 * like the built-in card flow. The payload is copied by value into the new
 * clip; nothing references the preset record afterwards.
 */
export async function createTextClipFromPreset(
  preset: CustomPresetRecord,
  playheadPosition: number,
): Promise<boolean> {
  const t = (key: string, options?: Record<string, unknown>): string =>
    i18n.t(key, options);
  const revalidated = validatePresetPayload(preset.payload);
  if (!revalidated.ok) {
    toast.error(t("assets.textPresets.applyFailed"), revalidated.message);
    return false;
  }
  if (revalidated.value.kind !== "text") {
    toast.error(t("assets.textPresets.applyFailed"), t("assets.textPresets.kindMismatch"));
    return false;
  }
  const payload = revalidated.value as TextPresetPayload;
  const style = payload.style as Partial<TextStyle>;
  const text = (payload.sampleText ?? preset.name).slice(0, MAX_SAMPLE_TEXT_LENGTH);

  const state = useProjectStore.getState();
  const { createTextClip, addTrack } = state;
  const tracksBefore = state.project.timeline.tracks;
  await addTrack("text", 0);
  const tracksAfter = useProjectStore.getState().project.timeline.tracks;
  const newTextTrack = tracksAfter.find(
    (track) =>
      track.type === "text" && !tracksBefore.some((before) => before.id === track.id),
  );
  if (!newTextTrack) return false;
  const created = createTextClip(newTextTrack.id, playheadPosition, text, 5, style);
  if (!created) return false;
  useUIStore.getState().select({
    type: "text-clip",
    id: created.id,
    trackId: newTextTrack.id,
  });
  return true;
}

/**
 * "Apply to selected text": expands the preset via the shared expansion
 * helper into one `text/update` action and runs it through
 * `executeActionBatch`, so the style change is a single undo unit shared
 * with the agent-side application path.
 */
export async function applyTextPresetToSelectedClip(
  preset: Pick<CustomPresetRecord, "name" | "payload">,
): Promise<boolean> {
  const t = (key: string, options?: Record<string, unknown>): string =>
    i18n.t(key, options);
  const clipId = firstSelectedTextClipId();
  if (!clipId) {
    toast.error(
      t("assets.textPresets.applyFailed"),
      t("assets.textPresets.applyNeedsSelection"),
    );
    return false;
  }
  const expanded = expandPresetActions({
    preset: { name: preset.name, payload: preset.payload },
    target: { kind: "text", mode: "updateStyle", clipId },
    project: useProjectStore.getState().project,
  });
  if (!expanded.ok) {
    toast.error(t("assets.textPresets.applyFailed"), expanded.message);
    return false;
  }
  useProjectStore.getState().executeActionBatch(expanded.actions, {
    groupLabel: expanded.groupLabel,
    historyOwner: "human",
  });
  return true;
}

/** Persists the captured style under a deduplicated name. */
export async function saveTextPreset(input: {
  readonly name: string;
  readonly style: Record<string, unknown>;
  readonly sampleText: string;
  readonly existingNames: readonly string[];
}): Promise<CustomPresetRecord | null> {
  const t = (key: string, options?: Record<string, unknown>): string =>
    i18n.t(key, options);
  const finalName = dedupePresetName(input.name, input.existingNames);
  const result = await getCustomPresetService().create({
    kind: "text",
    name: finalName,
    payload: {
      schemaVersion: PRESET_PAYLOAD_SCHEMA_VERSION,
      kind: "text",
      style: input.style,
      sampleText: input.sampleText,
    },
  });
  if (!result.ok) {
    toast.error(t("assets.textPresets.saveFailed"), result.message);
    return null;
  }
  toast.success(t("assets.textPresets.saved", { name: result.value.name }));
  return result.value;
}

/** Rename with core name validation; failures surface as error toasts. */
export async function renameTextPreset(
  preset: Pick<CustomPresetRecord, "id" | "name">,
  draftName: string,
): Promise<boolean> {
  const t = (key: string, options?: Record<string, unknown>): string =>
    i18n.t(key, options);
  const validated = validatePresetName(draftName);
  if (!validated.ok) {
    toast.error(t("assets.textPresets.renameFailed"), validated.message);
    return false;
  }
  if (validated.value === preset.name) return true;
  const result = await getCustomPresetService().update(preset.id, {
    name: validated.value,
  });
  if (!result.ok) {
    toast.error(t("assets.textPresets.renameFailed"), result.message);
    return false;
  }
  toast.success(t("assets.textPresets.renamed"), validated.value);
  return true;
}

/**
 * Delete after an explicit confirmation whose copy states the isolation
 * promise: clips already created from the preset keep their own copied
 * style and are never affected.
 */
export async function deleteTextPresetWithConfirm(
  preset: Pick<CustomPresetRecord, "id" | "name">,
): Promise<boolean> {
  const t = (key: string, options?: Record<string, unknown>): string =>
    i18n.t(key, options);
  if (!window.confirm(t("assets.textPresets.deleteConfirm", { name: preset.name }))) {
    return false;
  }
  const result = await getCustomPresetService().remove(preset.id);
  if (!result.ok) {
    toast.error(t("assets.textPresets.deleteFailed"), result.message);
    return false;
  }
  toast.success(t("assets.textPresets.deleted"), preset.name);
  return true;
}

/* ------------------------------ CSS preview ----------------------------- */

/** Small in-panel CSS approximation of the stored style (no bitmap needed). */
function presetPreviewStyle(style: Record<string, unknown>): React.CSSProperties {
  const s = style as Partial<TextStyle>;
  const shadowColor = typeof s.shadowColor === "string" ? s.shadowColor : undefined;
  return {
    fontSize:
      typeof s.fontSize === "number"
        ? `${Math.min(22, Math.max(9, Math.round(s.fontSize / 3.2)))}px`
        : "12px",
    fontWeight: (s.fontWeight as React.CSSProperties["fontWeight"]) ?? 500,
    fontStyle: typeof s.fontStyle === "string" ? s.fontStyle : undefined,
    letterSpacing: typeof s.letterSpacing === "number" ? s.letterSpacing / 3 : undefined,
    lineHeight: typeof s.lineHeight === "number" ? s.lineHeight : undefined,
    color: typeof s.color === "string" ? s.color : "#e5e7eb",
    backgroundColor: typeof s.backgroundColor === "string" ? s.backgroundColor : undefined,
    textShadow:
      shadowColor !== undefined
        ? `${s.shadowOffsetX ?? 0}px ${s.shadowOffsetY ?? 0}px ${s.shadowBlur ?? 0}px ${shadowColor}`
        : undefined,
    WebkitTextStrokeWidth:
      typeof s.strokeWidth === "number" ? `${Math.min(2.5, s.strokeWidth / 2)}px` : undefined,
    WebkitTextStrokeColor: typeof s.strokeColor === "string" ? s.strokeColor : undefined,
    textAlign: typeof s.textAlign === "string" ? s.textAlign : undefined,
    textDecoration: typeof s.textDecoration === "string" ? s.textDecoration : undefined,
  };
}

/** Conservative missing-font hint: only shown when the browser can prove it. */
function isFontFamilyMissing(family: unknown): boolean {
  if (typeof family !== "string" || family.trim().length === 0) return false;
  try {
    if (typeof document === "undefined" || typeof document.fonts?.check !== "function") {
      return false;
    }
    return !document.fonts.check(`16px "${family.replace(/"/g, "")}"`);
  } catch {
    return false;
  }
}

/* -------------------------------- panel --------------------------------- */

const SaveNameDialog: React.FC<{
  readonly title: string;
  readonly placeholder: string;
  readonly confirmLabel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}> = ({ title, placeholder, confirmLabel, value, onChange, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="fixed inset-0 z-50" onClick={onCancel}>
      <div
        className="absolute left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-border bg-bg-1 p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-fg">{title}</div>
        <input
          ref={inputRef}
          value={value}
          aria-label={placeholder}
          placeholder={placeholder}
          maxLength={80}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onConfirm();
            if (event.key === "Escape") onCancel();
          }}
          className="w-full rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={!value.trim()}
            onClick={onConfirm}
            className="rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export const TextPresetsPanel: React.FC = () => {
  const { t } = useTranslation();
  const customPresets = useCustomPresets("text");
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const selectedItems = useUIStore((state) => state.selectedItems);

  const [saveDraft, setSaveDraft] = useState<{
    style: Record<string, unknown>;
    sampleText: string;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const existingNames = useMemo(
    () => customPresets.map((preset) => preset.name),
    [customPresets],
  );

  const projectTextClips = useProjectStore(
    (state) => state.project.textClips,
  );

  const hasSelectedTextClip = useMemo(() => {
    const clips = projectTextClips ?? [];
    // Same clip-like filter as ui-store getSelectedClipIds.
    return selectedItems
      .filter(
        (item) =>
          item.type === "clip" ||
          item.type === "text-clip" ||
          item.type === "shape-clip",
      )
      .some((item) => clips.some((clip) => clip.id === item.id));
  }, [selectedItems, projectTextClips]);

  const handleSaveClick = useCallback(() => {
    const capture = captureTextPresetFromSelection(
      useProjectStore.getState().project,
      useUIStore.getState().getSelectedClipIds(),
    );
    if (!capture.ok) {
      if (capture.reason === "invalid-style") {
        toast.error(
          t("assets.textPresets.saveFailed"),
          capture.message ?? t("assets.textPresets.saveDisabledHint"),
        );
      } else {
        toast.error(
          t("assets.textPresets.saveNeedsSelection"),
          t("assets.textPresets.saveDisabledHint"),
        );
      }
      return;
    }
    if (capture.droppedFields.length > 0) {
      const lines = capture.droppedFields.map(
        (field) => `• ${field} — ${t("assets.textPresets.unsupportedFieldReason")}`,
      );
      const confirmed = window.confirm(
        `${t("assets.textPresets.unsupportedConfirmTitle")}\n\n${t(
          "assets.textPresets.unsupportedConfirmBody",
          { fields: lines.join("\n") },
        )}`,
      );
      if (!confirmed) return;
    }
    setNameDraft(
      dedupePresetName(t("assets.textPresets.defaultName"), existingNames),
    );
    setSaveDraft({ style: capture.style, sampleText: capture.sampleText });
  }, [existingNames, t]);

  const handleSaveConfirm = useCallback(() => {
    if (!saveDraft) return;
    const draft = saveDraft;
    setSaveDraft(null);
    void saveTextPreset({
      name: nameDraft,
      style: draft.style,
      sampleText: draft.sampleText,
      existingNames,
    });
  }, [existingNames, nameDraft, saveDraft]);

  const menuItemsFor = useCallback(
    (preset: CustomPresetRecord): ContextMenuOption[] => [
      {
        label: t("assets.textPresets.applyNewText"),
        icon: <Plus size={14} aria-hidden />,
        onClick: () => {
          void createTextClipFromPreset(preset, playheadPosition);
        },
      },
      {
        label: t("assets.textPresets.applyToSelected"),
        icon: <Type size={14} aria-hidden />,
        onClick: () => {
          void applyTextPresetToSelectedClip(preset);
        },
      },
      { type: "divider" },
      {
        label: t("assets.textPresets.renameAction"),
        icon: <Pencil size={14} aria-hidden />,
        onClick: () => {
          setRenameDraft(preset.name);
          setRenamingId(preset.id);
        },
      },
      {
        label: t("assets.textPresets.deleteAction"),
        icon: <Trash2 size={14} aria-hidden />,
        onClick: () => {
          void deleteTextPresetWithConfirm(preset);
        },
      },
    ],
    [playheadPosition, t],
  );

  return (
    <div className="min-w-0 space-y-3">
      <button
        type="button"
        aria-label={t("assets.textPresets.saveFromSelection")}
        title={
          hasSelectedTextClip
            ? t("assets.textPresets.saveFromSelection")
            : t("assets.textPresets.saveDisabledHint")
        }
        disabled={!hasSelectedTextClip}
        onClick={handleSaveClick}
        className="flex min-h-[36px] w-full min-w-0 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background-tertiary px-3 py-2 text-center text-xs font-medium text-text-secondary transition-all hover:border-primary/50 hover:bg-primary/5 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border"
      >
        <Plus size={14} aria-hidden />
        <span className="block max-w-full truncate">
          {t("assets.textPresets.saveFromSelection")}
        </span>
      </button>

      <Text type="label" color="secondary" weight="bold" display="block" className="text-xs">
        {t("assets.textPresets.groupBuiltin")}
      </Text>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        {TEXT_STYLE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.name}
            aria-label={preset.name}
            title={`${preset.name} — ${t("assets.textPresets.builtinHint")}`}
            onClick={async () => {
              const state = useProjectStore.getState();
              const { createTextClip, addTrack } = state;
              const tracksBefore = state.project.timeline.tracks;
              await addTrack("text", 0);
              const tracksAfter =
                useProjectStore.getState().project.timeline.tracks;
              const newTextTrack = tracksAfter.find(
                (track) =>
                  track.type === "text" &&
                  !tracksBefore.some((before) => before.id === track.id),
              );
              if (newTextTrack) {
                const created = createTextClip(
                  newTextTrack.id,
                  playheadPosition,
                  preset.text,
                  5,
                  preset.style,
                );
                if (created) {
                  useUIStore.getState().select({
                    type: "text-clip",
                    id: created.id,
                    trackId: newTextTrack.id,
                  });
                }
              }
            }}
            className="flex min-h-[44px] min-w-0 items-center justify-center rounded-lg border border-border bg-background-tertiary px-2 py-2 text-center text-xs font-medium leading-tight text-text-secondary transition-all hover:border-primary/50 hover:bg-primary/5 hover:text-text-primary"
          >
            <span className="block max-w-full truncate">{preset.name}</span>
          </button>
        ))}
      </div>

      <Text type="label" color="secondary" weight="bold" display="block" className="pt-1 text-xs">
        {t("assets.textPresets.groupCustom")}
      </Text>
      {customPresets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-text-muted">
          {t("assets.textPresets.customEmpty")}
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-2">
          {customPresets.map((preset) => {
            const payload = preset.payload as TextPresetPayload;
            const isRenaming = renamingId === preset.id;
            const card = (
              <div
                tabIndex={0}
                data-text-preset-id={preset.id}
                role="button"
                aria-label={preset.name}
                onClick={() => {
                  if (!isRenaming) {
                    void createTextClipFromPreset(preset, playheadPosition);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !isRenaming) {
                    void createTextClipFromPreset(preset, playheadPosition);
                  }
                }}
                className="relative flex min-h-[44px] min-w-0 cursor-pointer flex-col justify-center rounded-lg border border-border bg-background-tertiary px-2 py-2 transition-all hover:border-primary/50 hover:bg-primary/5"
              >
                {isRenaming ? (
                  <input
                    autoFocus
                    aria-label={t("assets.textPresets.renameAriaLabel")}
                    maxLength={80}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.currentTarget.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void renameTextPreset(preset, renameDraft).then((done) => {
                          if (done) setRenamingId(null);
                        });
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => {
                      void renameTextPreset(preset, renameDraft).then((done) => {
                        if (done) setRenamingId(null);
                      });
                    }}
                    className="w-full min-w-0 rounded-md border border-accent bg-bg-1 px-1.5 py-0.5 text-[12px] font-medium text-fg outline-none"
                  />
                ) : (
                  <>
                    <span
                      className="block max-w-full truncate leading-tight"
                      style={presetPreviewStyle(payload.style)}
                    >
                      {payload.sampleText ?? preset.name}
                    </span>
                    <span className="mt-0.5 block max-w-full truncate text-[10px] font-medium text-text-muted">
                      {preset.name}
                    </span>
                  </>
                )}
                {isFontFamilyMissing(payload.style.fontFamily) && (
                  <span
                    className="absolute right-1 top-1 rounded bg-yellow-500/90 px-1 py-[1px] text-[8px] font-bold text-black"
                    title={t("assets.textPresets.fontMissing")}
                  >
                    {t("assets.textPresets.fontMissing")}
                  </span>
                )}
              </div>
            );
            return (
              <ContextMenu key={preset.id} items={menuItemsFor(preset)} menuWidth={220} size="sm">
                {card}
              </ContextMenu>
            );
          })}
        </div>
      )}

      {saveDraft && (
        <SaveNameDialog
          title={t("assets.textPresets.dialogTitle")}
          placeholder={t("assets.textPresets.namePlaceholder")}
          confirmLabel={t("assets.textPresets.save")}
          value={nameDraft}
          onChange={setNameDraft}
          onCancel={() => setSaveDraft(null)}
          onConfirm={handleSaveConfirm}
        />
      )}
    </div>
  );
};
