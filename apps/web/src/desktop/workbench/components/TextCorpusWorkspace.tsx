import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
/**
 * Text corpus multi-row review workspace (migrated from the AI-material
 * workbench prototype).
 *
 * Data comes exclusively from WorkbenchItemView props; every write goes
 * through the awaited controller callbacks and failures are surfaced in a
 * local error strip (never silently dropped).
 *
 * Character offsets are computed with DOM Ranges relative to the paragraph
 * body root element: text nodes are walked in document order and their
 * UTF-16 code-unit lengths accumulated, so whitespace, newlines, emoji and
 * repeated phrases all resolve to the real half-open interval [start, end).
 */
import { lazy, Suspense, useState } from "react";
import type { JSX } from "react";
import type React from "react";
import {
  AlertTriangle,
  Check,
  Edit3,
  Eye,
  Info,
  MessageSquarePlus,
  Save,
  X,
} from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import type {
  RangeCommentInput,
  SelectModifiers,
  TextPayloadView,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { selectionOffsetsInRange } from "../text-range-offset";
const ReviewMarkdown = lazy(() => import("./ReviewMarkdown"));

export interface TextCorpusWorkspaceProps {
  readonly singleItem?: boolean;
  readonly currentItem: WorkbenchItemView;
  /** Text items of the active batch in stable order (multi-row browsing). */
  readonly batchTextItems: readonly WorkbenchItemView[];
  readonly selectedIds: readonly string[];
  readonly onSelectItem: (itemId: string, modifiers?: SelectModifiers) => void;
  readonly onSaveTextRevision: (
    itemId: string,
    newText: string,
  ) => Promise<WorkbenchMutationResult>;
  readonly onAddRangeComment: (
    itemId: string,
    comment: RangeCommentInput,
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  readonly onConfirmDuplicate: (
    itemId: string,
    action: "discard" | "dismiss_proposal",
  ) => Promise<WorkbenchMutationResult>;
  /**
   * Optional per-row quick decision (保留/丢弃). When the host does not wire
   * it the buttons are hidden — decisions then live in the bottom timeline.
   */
  readonly onCommitDecision?: (
    decision: WorkbenchDecision,
    targetIds: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
}

interface ActiveTextSelection {
  readonly itemId: string;
  readonly version: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quotedText: string;
}

/**
 * Resolve a stored tag reference for display without inventing identity.
 * An exact id wins. A legacy shortName resolves only when it is unique among
 * the item's tags; same-name/different-version references stay unresolved
 * rather than guessing one of them.
 */
function resolveTagReference(
  item: WorkbenchItemView,
  ref: string,
): { label: string; valid: boolean } {
  const byId = item.provenanceTags.find((tag) => tag.id === ref);
  if (byId) {
    return { label: `@${byId.shortName}${byId.version ? ` ${byId.version}` : ""}`, valid: true };
  }
  const byName = item.provenanceTags.filter((tag) => tag.shortName === ref);
  if (byName.length === 1) {
    const tag = byName[0];
    return { label: `@${tag.shortName}${tag.version ? ` ${tag.version}` : ""}`, valid: true };
  }
  return { label: `@${ref}`, valid: false };
}

export function TextCorpusWorkspace({
  singleItem = false,
  currentItem,
  batchTextItems,
  selectedIds,
  onSelectItem,
  onSaveTextRevision,
  onAddRangeComment,
  onConfirmDuplicate,
  onCommitDecision,
}: TextCorpusWorkspaceProps): JSX.Element {
  const { t } = useTranslation();
  // Edit drafts are keyed by `${itemId}:${version}` so switching rows never
  // crosses drafts and a saved revision starts a fresh draft slot.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [showDiffMap, setShowDiffMap] = useState<Record<string, boolean>>({});
  const [activeRange, setActiveRange] = useState<ActiveTextSelection | null>(null);
  const [rangeSuggestionInput, setRangeSuggestionInput] = useState<string>("");
  const [rangeTagIds, setRangeTagIds] = useState<readonly string[]>([]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState<"markdown" | "source">("markdown");

  const runMutation = async (
    label: string,
    action: () => Promise<WorkbenchMutationResult>,
  ): Promise<boolean> => {
    try {
      const result = await action();
      if (result.ok) return true;
      setMutationError(translate("{{v0}} failed: {{v1}}", { v0: label, v1: result.message }));
      return false;
    } catch (error) {
      setMutationError(translate("{{v0}} failed: {{v1}}", { v0: label, v1: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  };

  const handleBodyMouseUp = (
    item: WorkbenchItemView,
    payload: TextPayloadView,
    e: React.MouseEvent<HTMLDivElement>,
  ): void => {
    e.stopPropagation();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const offsets = selectionOffsetsInRange(e.currentTarget, selection.getRangeAt(0));
    if (!offsets || offsets.start === offsets.end) return;
    const quotedText = payload.currentText.slice(offsets.start, offsets.end);
    if (!quotedText.trim()) return;
    setActiveRange({
      itemId: item.id,
      version: payload.currentVersion,
      startOffset: offsets.start,
      endOffset: offsets.end,
      quotedText,
    });
    setRangeTagIds([]);
    setRangeSuggestionInput(translate("Characters [{{v0}}, {{v1}}): consider more concise wording", { v0: offsets.start, v1: offsets.end }));
  };

  const commitRangeComment = async (): Promise<void> => {
    if (!activeRange || !rangeSuggestionInput.trim()) return;
    const comment: RangeCommentInput = {
      startOffset: activeRange.startOffset,
      endOffset: activeRange.endOffset,
      quotedText: activeRange.quotedText,
      suggestion: rangeSuggestionInput.trim(),
      // Stable provenance ids from the real tag chips; never parsed @names.
      referencedTags: [...rangeTagIds],
    };
    const ok = await runMutation(translate("Annotate the anchored range"), () =>
      onAddRangeComment(activeRange.itemId, comment, activeRange.version),
    );
    if (ok) {
      setActiveRange(null);
      setRangeSuggestionInput("");
      setRangeTagIds([]);
      window.getSelection()?.removeAllRanges();
    }
  };

  const draftKeyOf = (item: WorkbenchItemView, payload: TextPayloadView): string =>
    `${item.id}:${payload.currentVersion}`;

  const startEditing = (item: WorkbenchItemView, payload: TextPayloadView): void => {
    const key = draftKeyOf(item, payload);
    setDrafts((prev) => (key in prev ? prev : { ...prev, [key]: payload.currentText }));
    setEditingKey(key);
    setActiveRange(null);
  };

  const cancelEditing = (): void => {
    if (editingKey) {
      const key = editingKey;
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    setEditingKey(null);
  };

  const saveEditing = async (
    item: WorkbenchItemView,
    payload: TextPayloadView,
  ): Promise<void> => {
    if (!editingKey) return;
    const draft = drafts[editingKey] ?? "";
    if (!draft.trim() || draft === payload.currentText) {
      cancelEditing();
      return;
    }
    const ok = await runMutation(translate("Save text revision"), () => onSaveTextRevision(item.id, draft));
    if (ok) {
      const key = editingKey;
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setEditingKey(null);
    }
  };

  const quickDecision = (decision: WorkbenchDecision, itemId: string): void => {
    if (!onCommitDecision) return;
    void runMutation(translate("Quick decision"), () => onCommitDecision(decision, [itemId]));
  };

  const confirmDuplicate = (itemId: string, action: "discard" | "dismiss_proposal"): void => {
    void runMutation(action === "discard" ? translate("Confirm discarding duplicate") : translate("Ignore duplicate suggestion"), () =>
      onConfirmDuplicate(itemId, action),
    );
  };

  const activeRangeItem = activeRange
    ? (batchTextItems.find((item) => item.id === activeRange.itemId) ?? currentItem)
    : currentItem;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Top Sub-bar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-3">
        <div className="flex items-center gap-2 text-xs text-fg-2">
          <span className="font-semibold text-fg">{t("Text review{{v0}}", { v0: !singleItem && t(" ({{v0}} entries)", { v0: batchTextItems.length }) })}</span>
          <div className="flex gap-1" role="group" aria-label={t("Text display mode")}>
            {(["markdown", "source"] as const).map(mode => <button key={mode} type="button"
              aria-pressed={readingMode === mode} onClick={() => { setReadingMode(mode); setActiveRange(null); }}
              className={`rounded px-2 py-1 ${readingMode === mode ? "bg-bg-3 text-fg" : "text-fg-3"}`}>
              {mode === "markdown" ? t("Read") : t("Source and comments")}
            </button>)}
          </div>
          <span
            className="inline-flex cursor-help items-center text-fg-3 hover:text-fg"
            title={t("Reading mode renders Markdown. Switch to Source and comments to select exact source ranges and annotate them.")}
          >
            <Info className="h-3.5 w-3.5" />
            <span className="sr-only">{t("Click the line-number gutter to select an entry (blue/green border), or drag across text to select a UTF-16 character range (amber highlight).")}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-fg-3">
          {!singleItem && <span>{t("Selected entry: {{v0}}", { v0: batchTextItems.filter((item) => selectedIds.includes(item.id)).length })}</span>}
          {activeRange && (
            <>
              <span>·</span>
              <span className="text-status-warning">{t("Character selection: [{{v0}}, {{v1}})", { v0: activeRange.startOffset, v1: activeRange.endOffset })}</span>
            </>
          )}
        </div>
      </div>

      {/* Mutation error strip (controller failures are never silent) */}
      {mutationError && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-status-error/40 bg-status-error/10 px-4 py-2 text-xs text-status-error">
          <span className="truncate"><LocalizedMessage>{mutationError}</LocalizedMessage></span>
          <button
            type="button"
            onClick={() => setMutationError(null)}
            className="shrink-0 hover:text-fg"
            title={t("Dismiss error")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Contextual Floating Bar when a Character Range is selected */}
      {activeRange && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-status-warning/40 bg-bg-2 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 whitespace-nowrap font-mono text-xs text-status-warning">{t("Character selection v{{v0}} [{{v1}}, {{v2}}):", { v0: activeRange.version, v1: activeRange.startOffset, v2: activeRange.endOffset })}</span>
              <span className="max-w-[220px] truncate text-xs italic text-fg">
                “{activeRange.quotedText}”
              </span>
              <input
                type="text"
                value={rangeSuggestionInput}
                onChange={(e) => setRangeSuggestionInput(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void commitRangeComment();
                }}
                placeholder={t("Enter revision suggestions for this character range…")}
                className="flex-1 rounded-md border border-border-strong bg-bg px-2.5 py-1 text-xs text-fg focus:border-status-warning focus:outline-none"
              />
            </div>
            {activeRangeItem.provenanceTags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 pl-0.5">
                <span className="text-[10px] text-fg-3">{t("Source references:")}</span>
                {activeRangeItem.provenanceTags.map((tag) => {
                  const active = rangeTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() =>
                        setRangeTagIds((prev) =>
                          prev.includes(tag.id)
                            ? prev.filter((id) => id !== tag.id)
                            : [...prev, tag.id],
                        )
                      }
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                        active
                          ? "border-status-warning bg-status-warning/15 text-status-warning"
                          : "border-border bg-bg text-fg-3 hover:text-fg"
                      }`}
                      title={t("Reference {{v0}}{{v1}} (stable ID)", { v0: tag.shortName, v1: tag.version ? ` ${tag.version}` : "" })}
                    >
                      @{tag.shortName}
                      {tag.version ? ` ${tag.version}` : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void commitRangeComment()}
              className="flex items-center gap-1 whitespace-nowrap rounded-md bg-status-warning px-2.5 py-1 text-xs font-semibold text-bg transition-opacity hover:opacity-90"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {t("Annotate the anchored range")}</button>
            <button
              type="button"
              onClick={() => {
                setActiveRange(null);
                setRangeTagIds([]);
                window.getSelection()?.removeAllRanges();
              }}
              className="p-1 text-fg-3 hover:text-fg"
              title={t("Clear character selection")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Multi-Row Corpus Stream (No single-card-per-page bloat) */}
      <div className="flex-1 select-text space-y-3 overflow-y-auto bg-bg p-4">
        {batchTextItems.map((item, idx) => {
          const payload = item.textPayload;
          if (!payload) {
            return (
              <div
                key={item.id}
                className="rounded-xl border border-border bg-bg-1 p-3 text-xs text-fg-3"
              >{t("{{v0}} · No text content was supplied", { v0: item.title })}</div>
            );
          }

          const rowKey = draftKeyOf(item, payload);
          const isRowSelected = selectedIds.includes(item.id);
          const isCurrentFocused = currentItem.id === item.id;
          const isEditing = editingKey === rowKey;
          const draftText = isEditing ? drafts[rowKey] ?? "" : "";
          const showDiff = !!showDiffMap[item.id];
          const dup = payload.duplicateProposal;

          return (
            <div
              key={item.id}
              onClick={() => {
                // Focusing the row for inspector without wiping text selection
                if (!singleItem && !window.getSelection()?.toString()) {
                  onSelectItem(item.id);
                }
              }}
              className={`flex overflow-hidden rounded-lg border bg-bg-1 transition-colors ${
                isRowSelected
                  ? "border-border border-l-[3px] border-l-accent"
                  : isCurrentFocused
                    ? "border-border border-l-[3px] border-l-border-strong"
                    : "border-border border-l-[3px] border-l-transparent hover:border-border-strong"
              }`}
            >
              {/* Left Gutter: Click to select ENTIRE entry (distinct from text drag selection) */}
              {!singleItem && <div
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectItem(item.id, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
                }}
                className={`flex w-11 shrink-0 cursor-pointer select-none flex-col items-center justify-between border-r px-1 py-3 transition-colors ${
                  isRowSelected
                    ? "border-border bg-accent/10 text-accent"
                    : "border-border bg-bg-2/40 text-fg-3 hover:bg-bg-2 hover:text-fg"
                }`}
                title={t("Click the gutter to select an entry (Ctrl for multiple entries / Shift for a range)")}
              >
                <div
                  className={`flex h-4 w-4 items-center justify-center rounded border ${
                    isRowSelected ? "border-accent bg-accent text-accent-fg" : "border-border-strong"
                  }`}
                >
                  {isRowSelected && <Check className="h-3 w-3 stroke-[2.5]" />}
                </div>
                <span className="font-mono text-[11px] font-semibold tabular-nums">
                  #{String(idx + 1).padStart(2, "0")}
                </span>
                <span className="font-mono text-[10px] text-fg-3">v{item.version}</span>
              </div>}

              {/* Right Content Column */}
              <div className="min-w-0 flex-1 p-3">
                {/* Duplicate Corpus Proposal Alert (Human Confirmation Required) */}
                {dup && !dup.dismissed && item.status !== "discarded" && (
                  <div className="mb-2.5 flex items-center justify-between gap-3 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-status-warning">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span className="truncate">{dup.reason}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDuplicate(item.id, "discard");
                        }}
                        className="inline-flex h-6 items-center whitespace-nowrap rounded-[4px] border border-status-error/40 bg-status-error/15 px-2 text-xs font-medium text-status-error transition-colors hover:bg-status-error/25"
                      >{t("Confirm discarding duplicate")}</button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDuplicate(item.id, "dismiss_proposal");
                        }}
                        className="inline-flex h-6 items-center whitespace-nowrap rounded-[4px] border border-border-strong bg-bg-2 px-2 text-xs text-fg-2 transition-colors hover:text-fg"
                      >{t("Ignore suggestion · Keep")}</button>
                    </div>
                  </div>
                )}

                {/* Row Header Metadata (Zero-pill clean inline metadata) */}
                <div className="mb-2 flex select-none items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="truncate font-semibold text-fg">{item.title}</span>
                    {payload.speakerOrContext.trim() && <>
                      <span className="text-fg-3">·</span>
                      <span className="truncate text-fg-2">{payload.speakerOrContext}</span>
                    </>}
                    <span className="text-fg-3">·</span>
                    <span className="font-mono text-[11px] text-fg-3">{t("Characters: {{v0}}", { v0: payload.currentText.length })}</span>
                    {item.hasManualRevision && (
                      <>
                        <span className="text-fg-3">·</span>
                        <span className="font-medium text-status-info">{t("Revised (v{{v0}})", { v0: item.version })}</span>
                      </>
                    )}
                  </div>

                  {/* Row Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {item.hasManualRevision && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowDiffMap((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
                        }}
                        title={showDiff ? t("Hide source comparison") : t("Compare before and after")}
                        aria-label={showDiff ? t("Hide source comparison") : t("Compare before and after")}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-[4px] border text-[11px] transition-colors ${
                          showDiff
                            ? "border-status-info/40 bg-status-info/15 text-status-info"
                            : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                        }`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span className="sr-only">{showDiff ? t("Hide source comparison") : t("Compare before and after")}</span>
                      </button>
                    )}

                    {!isEditing && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(item, payload);
                        }}
                        title={t("Edit text")}
                        aria-label={t("Edit text")}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] border border-border bg-bg-2 text-[11px] text-fg-2 transition-colors hover:text-fg"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span className="sr-only">{t("Edit text")}</span>
                      </button>
                    )}

                    {onCommitDecision && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            quickDecision("kept", item.id);
                          }}
                          className="inline-flex h-6 items-center whitespace-nowrap rounded-[4px] border border-accent/40 bg-accent/10 px-2 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                        >{t("Keep")}</button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            quickDecision("discarded", item.id);
                          }}
                          className="inline-flex h-6 items-center whitespace-nowrap rounded-[4px] border border-border bg-bg-2 px-2 text-[11px] text-fg-2 transition-colors hover:text-status-error"
                        >{t("Discard")}</button>
                      </>
                    )}
                  </div>
                </div>

                {/* Paragraph Body or Inline Editor (Respects keyboard focus so Delete won't discard item!) */}
                {isEditing ? (
                  <div className="mt-1 space-y-2" onClick={(e) => e.stopPropagation()}>
                    <div onKeyDown={event => event.stopPropagation()}>
                      <Suspense fallback={<p className="p-3 text-xs text-fg-3">{t("desktop.editor.loading")}</p>}>
                        <ReviewMarkdown source={draftText} editing
                          onChange={value => setDrafts(previous => ({ ...previous, [rowKey]: value }))} />
                      </Suspense>
                    </div>
                    <div className="flex items-center justify-end gap-3 text-xs text-fg-3">
                      <span className="sr-only">{t("While the editor is focused, Backspace/Delete edits text without discarding media. Saving creates v{{v0}}; existing annotations stay on their original version.", { v0: payload.currentVersion + 1 })}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={cancelEditing}
                          className="rounded bg-bg-2 px-2.5 py-1 text-fg-2 hover:text-fg"
                        >{t("review.cancel")}</button>
                        <button
                          type="button"
                          onClick={() => void saveEditing(item, payload)}
                          className="flex items-center gap-1 rounded bg-status-info px-3 py-1 font-semibold text-bg transition-opacity hover:opacity-90"
                        >
                          <Save className="h-3.5 w-3.5" />
                          {t("review.save")}</button>
                      </div>
                    </div>
                  </div>
                ) : readingMode === "markdown" ? (
                  <div data-testid="text-body" data-mode="markdown" data-item-id={item.id}
                    className="mx-auto max-w-[90ch] select-text rounded-lg border border-border bg-bg p-5">
                    <Suspense fallback={<p className="text-xs text-fg-3">{t("Loading content…")}</p>}>
                      <ReviewMarkdown source={payload.currentText} />
                    </Suspense>
                  </div>
                ) : (
                  <div
                    onMouseUp={(e) => handleBodyMouseUp(item, payload, e)}
                  data-testid="text-body"
                  data-mode="source"
                  data-item-id={item.id}
                    className="cursor-text select-text whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 text-[14px] leading-[1.7] text-fg selection:bg-status-warning/35 selection:text-fg"
                  >
                    {payload.currentText}
                  </div>
                )}

                {/* Original / Current Text Contrast when toggled */}
                {showDiff && item.hasManualRevision && (
                  <div className="mt-2 space-y-1 rounded-lg border border-border bg-bg-2 p-2.5 text-xs">
                    <div className="font-mono text-fg-3">{t("Retained source (v{{v0}}):", { v0: payload.originalVersion })}</div>
                    <div className="leading-relaxed text-status-error/80 line-through whitespace-pre-line">
                      {payload.originalText}
                    </div>
                    <div className="font-mono text-fg-3">{t("Current (v{{v0}}):", { v0: payload.currentVersion })}</div>
                    <div className="leading-relaxed text-fg whitespace-pre-line">
                      {payload.currentText}
                    </div>
                  </div>
                )}

                {/* Anchored UTF-16 Character Range Comments */}
                {payload.rangeComments.length > 0 && (
                  <div className="mt-2.5 space-y-1.5">
                    {payload.rangeComments.map((rc) => {
                      const isStaleVersion = rc.version !== payload.currentVersion;
                      return (
                        <div
                          key={rc.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="whitespace-nowrap font-mono text-[11px] text-status-warning">{t("v{{v0}} offsets [{{v1}}, {{v2}}) {{v3}}", { v0: rc.version, v1: rc.startOffset, v2: rc.endOffset, v3: isStaleVersion ? t(" (annotation on an older version; offsets are not moved automatically)") : "" })}</span>
                            <span className="truncate text-fg-3">“{rc.quotedText}”</span>
                            <span className="text-fg-3">→</span>
                            <span className="truncate text-fg-2">{rc.suggestion}</span>
                            {rc.referencedTags.map((ref) => {
                              const resolved = resolveTagReference(item, ref);
                              return (
                                <span
                                  key={ref}
                                  title={
                                    resolved.valid
                                      ? t("Source references (stable IDs)")
                                      : t("Source reference unavailable: the tag is missing or has multiple same-name versions, so its identity is ambiguous")
                                  }
                                  className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] ${
                                    resolved.valid
                                      ? "border-status-warning/30 bg-status-warning/10 text-status-warning"
                                      : "border-status-error/40 bg-status-error/10 text-status-error"
                                  }`}
                                >
                                  {resolved.label}
                                  {resolved.valid ? "" : t(" (reference unavailable)")}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
