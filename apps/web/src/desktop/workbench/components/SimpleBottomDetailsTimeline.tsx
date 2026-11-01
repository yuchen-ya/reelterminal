import { localizeUiMessage } from "../../../i18n/messages";
import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
/**
 * Bottom details dock for the AI material workbench.
 *
 * Refactored for Phase 4:
 * - A sticky, prominent decision bar (44px / h-11) remains reachable at all
 *   times at the bottom of the workbench.
 * - Prominent Keep / Rework / Discard decision buttons with distinct semantic
 *   colours and active-state highlights.
 * - Current item summary, status badge, tags preview, inline "+ 标签" input,
 *   and Agent guidance pill in the middle section.
 * - Content-driven details appear only when present and scroll within the viewport.
 */
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import {
  CircleAlert,
  FastForward,
  Info,
  Plus,
  Redo2,
  RotateCcw,
  ShieldCheck,
  ThumbsUp,
} from "lucide-react";
import type {
  WorkbenchContentType,
  WorkbenchDecision,
  WorkbenchDecisionStatus,
  WorkbenchProvenanceTag,
} from "@reelterminal/core";
import type { WorkbenchItemView, WorkbenchMutationResult } from "../types";

export interface SimpleBottomDetailsTimelineProps {
  readonly currentItem: WorkbenchItemView | null;
  /** From the controller — the host history has undoable entries. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDisabledReason?: string;
  readonly redoDisabledReason?: string;
  /**
   * Current selection ids. When more than one item is selected the standard
   * decision buttons act on the whole selection; optional, defaults to the
   * current item only.
   */
  readonly selectedIds?: readonly string[];
  /** Jump to a related entry (e.g. a real lineage parent node). */
  readonly onSelectItemById: (id: string) => void;
  readonly onCommitDecision: (
    decision: WorkbenchDecision,
    explicitTargetIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
  readonly onSkipNext: () => void;
  readonly onUndoLast: () => Promise<WorkbenchMutationResult>;
  readonly onRedoLast: () => Promise<WorkbenchMutationResult>;
  readonly onAddUserTag: (itemId: string, tag: string) => Promise<WorkbenchMutationResult>;
}

const TYPE_LABELS: Record<WorkbenchContentType, string> = {
  get image() { return translate("review.kind.image"); },
  get text() { return translate("text"); },
  get data() { return translate("Data"); },
  get video() { return translate("review.kind.video"); },
  get model3d() { return translate("review.kind.model3d"); },
};

const STATUS_LABELS: Record<WorkbenchDecisionStatus, string> = {
  get pending() { return translate("requirementBoard.status.ready"); },
  get kept() { return translate("Keep"); },
  get modified() { return translate("Modified"); },
  get rework() { return translate("Needs rework"); },
  get discarded() { return translate("Discarded"); },
};

function ProvenanceChip({ tag }: { tag: WorkbenchProvenanceTag }) {
  const verificationLabel =
    tag.verification === "verified"
      ? translate("Verified")
      : tag.verification === "declared"
        ? translate("Declared (unverified)")
        : translate("Verification status unknown");
  const iconClass =
    tag.verification === "verified"
      ? "text-accent"
      : tag.verification === "declared"
        ? "text-status-warning"
        : "text-fg-3";
  return (
    <span
      title={`${verificationLabel}${tag.version ? ` · ${tag.version}` : ""} · ${tag.detailSummary}`}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-2 border border-border text-[11px] font-mono text-fg shrink-0"
    >
      {tag.verification === "unknown" ? (
        <CircleAlert className={`w-3 h-3 ${iconClass}`} />
      ) : (
        <ShieldCheck className={`w-3 h-3 ${iconClass}`} />
      )}
      @{tag.shortName}
    </span>
  );
}

export function SimpleBottomDetailsTimeline({
  currentItem,
  canUndo,
  canRedo,
  undoDisabledReason,
  redoDisabledReason,
  selectedIds,
  onSelectItemById,
  onCommitDecision,
  onSkipNext,
  onUndoLast,
  onRedoLast,
  onAddUserTag,
}: SimpleBottomDetailsTimelineProps) {
  const { t } = useTranslation();
  const [newTagInput, setNewTagInput] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Single and batch commits share onCommitDecision; multi-selection commits
  // carry explicit target ids so the controller cannot guess the scope.
  const targetIds: readonly string[] =
    selectedIds !== undefined
      ? selectedIds
      : currentItem
        ? [currentItem.id]
        : [];
  const targetLabel = selectedIds !== undefined ? translate("Selected items: {{v0}}", { v0: targetIds.length }) : translate("Current item");

  const runMutation = useCallback(
    async (action: () => Promise<WorkbenchMutationResult>) => {
      setActionError(null);
      setBusy(true);
      try {
        const result = await action();
        if (!result.ok) setActionError(result.message);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleCommit = (decision: WorkbenchDecision, explicitTargetIds?: readonly string[]) => {
    if (targetIds.length === 0) return;
    void runMutation(() => onCommitDecision(decision, explicitTargetIds));
  };

  const handleUndo = () => {
    void runMutation(onUndoLast);
  };

  const handleRedo = () => {
    void runMutation(onRedoLast);
  };

  const handleAddTagSubmit = (e: FormEvent) => {
    e.preventDefault();
    const tag = newTagInput.trim();
    if (!currentItem || !tag) return;
    void runMutation(() => onAddUserTag(currentItem.id, tag)).then((result) => {
      if (result.ok) setNewTagInput("");
    });
  };

  const guidance = currentItem?.agentGuidance;
  const lineage = currentItem?.lineage;
  const parentItemId = lineage?.parentNodeId;
  // "modified" is only executable through a real content revision. The data
  // path creates one from proposed cells; other types must use their own
  // editor (text revision / pixel repair / annotation save) first.
  const nodExecutable =
    guidance !== undefined &&
    (guidance.nodDecision !== "modified" || currentItem?.type === "data");

  const focus = guidance?.whatToDoNext.trim();
  const conclusion = guidance?.whatHappened.trim();
  const hasTags = !!(currentItem?.provenanceTags.length || currentItem?.userCategoryTags.length);
  const hasDetails = !!(focus || conclusion || lineage?.steps.length || lineage?.upstreamSourceNode || parentItemId || hasTags);

  return (
    <div
      className="bg-bg border-t border-border flex flex-col shrink-0 overflow-hidden"
      data-testid="workbench-bottom-dock"
    >
      {actionError && (
        <div className="px-3 py-1 border-b border-border bg-status-error/10 text-status-error flex items-center justify-between gap-2 shrink-0 text-xs">
          <span className="truncate"><LocalizedMessage>{actionError}</LocalizedMessage></span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-status-error hover:opacity-80 shrink-0 font-bold px-1"
          >
            ×
          </button>
        </div>
      )}

      {currentItem && hasDetails && (
        <div
          className={
            showDetails
              ? "max-h-[min(24vh,200px)] min-h-0 space-y-2 overflow-y-auto overscroll-contain border-b border-border bg-bg-1 px-3 py-2 [overflow-wrap:anywhere]"
              : "sr-only"
          }
          data-testid="workbench-agent-details"
        >
          {(focus || conclusion) && (
            <div className="grid gap-x-4 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
              {focus && <section className="min-w-0">
                <h3 className="mb-1 text-[11px] font-medium text-fg-3">{t("Focus")}</h3>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg" data-testid="workbench-review-focus">{focus}</p>
              </section>}
              {conclusion && <section className="min-w-0">
                <h3 className="mb-1 text-[11px] font-medium text-fg-3">{t("Decision")}</h3>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg" data-testid="workbench-review-conclusion">{conclusion}</p>
              </section>}
            </div>
          )}
          {lineage?.upstreamSourceNode && <p className="text-[11px] text-fg-2">{lineage.upstreamSourceNode} · {lineage.basedOnLabel}</p>}
          {!!lineage?.steps.length && <div className="flex flex-wrap gap-2 text-[11px] text-fg-2">
            {lineage.steps.map(step => <span key={step.version}>v{step.version}: {step.summary}</span>)}
          </div>}
          {parentItemId && <button type="button" onClick={() => onSelectItemById(parentItemId)} className="text-[11px] text-accent hover:underline">{t("View source item")}</button>}
          {hasTags && <div className="flex flex-wrap gap-1.5">
            {currentItem.provenanceTags.map(tag => <ProvenanceChip key={tag.id} tag={tag} />)}
            {currentItem.userCategoryTags.map(tag => <span key={tag} className="text-[11px] text-fg-2">#{tag}</span>)}
          </div>}
        </div>
      )}

      {/* Sticky Bottom Decision Bar (h-10 / 40px, always visible) */}
      <div className="min-h-10 px-2.5 py-1 flex flex-wrap items-center justify-between gap-1.5 shrink-0 bg-bg-1 select-none">
        {/* 1. Core Decision Buttons Group */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy || targetIds.length === 0}
            onClick={() => handleCommit("kept", targetIds)}
            title={t("Keep the current version of {{v0}} (shortcut: 1)", { v0: targetLabel })}
            className={`h-7 px-3 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "kept"
                ? "bg-accent text-accent-fg shadow-sm"
                : "border border-accent/50 bg-accent/15 text-accent hover:bg-accent/25"
            }`}
          >{t("Keep")}</button>
          <button
            type="button"
            disabled={busy || targetIds.length === 0}
            onClick={() => handleCommit("rework", targetIds)}
            title={t("Mark {{v0}} for revision; enter details in the issues panel (shortcut: 3)", { v0: targetLabel })}
            className={`h-7 px-3 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "rework"
                ? "bg-amber-500 text-black shadow-sm"
                : "border border-amber-500/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
            }`}
          >{t("Rework")}</button>
          <button
            type="button"
            disabled={busy || targetIds.length === 0}
            onClick={() => handleCommit("discarded", targetIds)}
            title={t("Discard {{v0}} while preserving its original and history; undo is available (shortcut: 4)", { v0: targetLabel })}
            className={`h-7 px-3 rounded-md text-xs font-semibold transition-colors disabled:opacity-40 inline-flex items-center justify-center select-none ${
              currentItem?.status === "discarded"
                ? "bg-red-600 text-white shadow-sm"
                : "border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
            }`}
          >{t("Discard")}</button>

          {guidance && (
            <button
              type="button"
              disabled={busy || !nodExecutable}
              onClick={() => handleCommit(guidance.nodDecision, [currentItem.id])}
              title={
                nodExecutable
                  ? t("Agent suggestion: {{v0}} (current item only)", { v0: STATUS_LABELS[guidance.nodDecision] })
                  : t("The Agent suggests Modified. Save an actual revision in the content editor first.")
              }
              className="h-7 px-2 rounded-md bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30 text-xs font-semibold transition-colors flex items-center gap-1 disabled:opacity-40 select-none shrink-0"
            >
              <ThumbsUp className="w-3.5 h-3.5 stroke-[2.2]" />
              <span>{guidance.nodButtonLabel}</span>
            </button>
          )}

          <span
            className={
              targetIds.length > 1
                ? "text-[11px] font-mono text-accent px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 select-none shrink-0"
                : "sr-only"
            }
            title={t("Decision scope")}
          >
            {targetLabel}
          </span>
          <button
            type="button"
            onClick={onSkipNext}
            className="h-7 w-7 text-xs inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 transition-colors shrink-0"
            title={t("Advance to next item")}
            aria-label={t("Next item")}
          >
            <FastForward className="w-3.5 h-3.5" />
            <span className="sr-only">{t("Next item")}</span>
          </button>
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo || busy}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 disabled:opacity-30 transition-colors shrink-0"
            title={undoDisabledReason ? localizeUiMessage(undoDisabledReason) : t("Undo the last review action")}
            aria-label={t("Undo the last review action")}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={!canRedo || busy}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3 disabled:opacity-30 transition-colors shrink-0"
            title={redoDisabledReason ? localizeUiMessage(redoDisabledReason) : t("Redo the review action")}
            aria-label={t("Redo the review action")}
            data-testid="workbench-redo"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 2. Right Side: Compact Status, Provenance, Tags & Details Drawer Toggle */}
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {currentItem ? (
            <>
              <span className="sr-only">
                {currentItem.title} · {TYPE_LABELS[currentItem.type]} · v{currentItem.version}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 border ${
                  currentItem.status === "kept"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                    : currentItem.status === "rework"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                      : currentItem.status === "discarded"
                        ? "border-red-500/30 bg-red-500/10 text-red-300"
                        : currentItem.status === "modified"
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                          : "border-border bg-bg-2 text-fg-3"
                }`}
              >
                {STATUS_LABELS[currentItem.status]}
              </span>

              {/* Provenance tags preview (up to 2) */}
              {currentItem.provenanceTags.slice(0, 2).map((tag) => (
                <ProvenanceChip key={tag.id} tag={tag} />
              ))}

              {/* User category tags preview (up to 2) */}
              {currentItem.userCategoryTags.slice(0, 2).map((t) => (
                <span
                  key={t}
                  className="px-1.5 py-0.5 rounded bg-bg-2 border border-border text-[11px] text-fg-2 shrink-0 font-mono"
                >
                  #{t}
                </span>
              ))}

              {/* Inline tag form */}
              <form onSubmit={handleAddTagSubmit} className="inline-flex items-center shrink-0">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("+ Tag")}
                  className="w-14 bg-transparent border-b border-border focus:border-accent px-1 py-0.5 text-xs text-fg placeholder-fg-3 focus:outline-none"
                />
                {newTagInput.trim() && (
                  <button type="submit" className="ml-1 text-accent hover:opacity-80" title={t("material.addTags")}>
                    <Plus className="w-3 h-3" />
                  </button>
                )}
              </form>

              {hasDetails && (
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  title={showDetails ? t("Collapse review focus and provenance details") : t("View review focus and provenance details")}
                  aria-label={t("Review details")}
                  className={`h-6 w-6 inline-flex items-center justify-center rounded border transition-colors shrink-0 ${
                    showDetails
                      ? "border-accent/40 bg-accent/15 text-accent"
                      : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                  }`}
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-fg-3 select-none">{targetIds.length ? t("Selected: {{v0}}", { v0: targetIds.length }) : t("No item selected")}</span>
          )}
        </div>

      </div>
    </div>
  );
}
