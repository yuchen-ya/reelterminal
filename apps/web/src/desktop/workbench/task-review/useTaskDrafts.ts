import { t } from "../../../i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskReviewSnapshot } from "../../../../../desktop/src/shared/task-review";
import type { TaskReviewController } from "./useTaskReviewController";

export interface DraftEntry {
  sourceVersionId: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** Text of the last acknowledged save; a differing local text stays dirty. */
  savedText: string | null;
  savedSelectionStart?: number;
  savedSelectionEnd?: number;
  status: "idle" | "saving" | "saved" | "error";
  error: string | null;
}

export type DraftMap = Record<string, DraftEntry>;

const isDirty = (entry: DraftEntry) => entry.savedText !== entry.text ||
  entry.savedSelectionStart !== entry.selectionStart || entry.savedSelectionEnd !== entry.selectionEnd;

/**
 * Working drafts for review units. Draft text lives in renderer state, so a
 * failed or interrupted save never discards typing; the persistent draft from
 * desktop main only ever seeds a unit the reviewer has not edited yet.
 */
export function useTaskDrafts(
  snapshot: TaskReviewSnapshot | null,
  controller: TaskReviewController,
) {
  const [drafts, setDrafts] = useState<DraftMap>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const timers = useRef<Record<string, number>>({});

  const seedFromSnapshot = useCallback(() => {
    if (!snapshot) return;
    setDrafts((current) => {
      let next: DraftMap | null = null;
      for (const persisted of snapshot.drafts) {
        if (current[persisted.unitId]) continue;
        next ??= { ...current };
        next[persisted.unitId] = {
          sourceVersionId: persisted.sourceVersionId,
          text: persisted.text,
          selectionStart: persisted.selectionStart,
          selectionEnd: persisted.selectionEnd,
          savedText: persisted.text,
          savedSelectionStart: persisted.selectionStart,
          savedSelectionEnd: persisted.selectionEnd,
          status: "saved",
          error: null,
        };
      }
      return next ?? current;
    });
  }, [snapshot]);
  useEffect(seedFromSnapshot, [seedFromSnapshot]);

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) window.clearTimeout(timer);
    },
    [],
  );

  const persist = useCallback(
    async (unitId: string) => {
      const entry = draftsRef.current[unitId];
      if (!entry || !isDirty(entry)) {
        if (entry && !isDirty(entry) && entry.status !== "saving")
          setDrafts((current) =>
            current[unitId]?.status === "error" || current[unitId]?.status === "idle"
              ? { ...current, [unitId]: { ...current[unitId], status: "saved", error: null } }
              : current,
          );
        return true;
      }
      const written = entry.text;
      const selectionStart = Math.min(entry.selectionStart, written.length);
      const selectionEnd = Math.min(entry.selectionEnd, written.length);
      setDrafts((current) => ({
        ...current,
        [unitId]: { ...current[unitId], status: "saving", error: null },
      }));
      const result = await controller.saveDraft({
        unitId,
        sourceVersionId: entry.sourceVersionId,
        text: written,
        selectionStart,
        selectionEnd,
      });
      setDrafts((current) => {
        const latest = current[unitId];
        if (!latest || latest.sourceVersionId !== entry.sourceVersionId) return current;
        if (!result.ok) {
          // Keep the typed text and cursor; only flag the failure.
          return {
            ...current,
            [unitId]: { ...latest, status: "error", error: result.error },
          };
        }
        return {
          ...current,
          [unitId]: {
            ...latest,
            savedText: written,
            savedSelectionStart: selectionStart,
            savedSelectionEnd: selectionEnd,
            status: latest.text === written && latest.selectionStart === selectionStart && latest.selectionEnd === selectionEnd ? "saved" : "idle",
            error: null,
          },
        };
      });
      return result.ok;
    },
    [controller],
  );

  const updateDraft = useCallback(
    (
      unitId: string,
      sourceVersionId: string,
      patch: { text?: string; selectionStart?: number; selectionEnd?: number },
    ) => {
      const current = draftsRef.current;
      const previous: DraftEntry = current[unitId] ?? {
        sourceVersionId,
        text: "",
        selectionStart: 0,
        selectionEnd: 0,
        savedText: null,
        status: "idle",
        error: null,
      };
      const updated: DraftEntry = {
        ...previous,
        sourceVersionId,
        text: patch.text ?? previous.text,
        selectionStart: patch.selectionStart ?? previous.selectionStart,
        selectionEnd: patch.selectionEnd ?? previous.selectionEnd,
        status: "idle",
      };
      if (updated.text === previous.text && updated.selectionStart === previous.selectionStart &&
          updated.selectionEnd === previous.selectionEnd && current[unitId]) return;
      const next: DraftMap = {
        ...current,
        [unitId]: updated,
      };
      draftsRef.current = next;
      setDrafts(next);
      window.clearTimeout(timers.current[unitId]);
      timers.current[unitId] = window.setTimeout(() => {
        void persist(unitId);
      }, 600);
    },
    [persist],
  );

  const retry = useCallback(
    (unitId: string) => {
      window.clearTimeout(timers.current[unitId]);
      return persist(unitId);
    },
    [persist],
  );

  const flushAll = useCallback(async () => {
    const dirty = Object.entries(draftsRef.current).filter(
      ([, entry]) => isDirty(entry),
    );
    if (!dirty.length) return;
    const results = await Promise.all(dirty.map(([unitId]) => persist(unitId)));
    if (results.some(ok => !ok)) throw new Error(t("Some drafts failed to save. They remain in the UI; try again."));
  }, [persist]);

  const dirtyCount = Object.values(drafts).filter(
    (entry) => isDirty(entry) || entry.status === "error",
  ).length;
  const errorCount = Object.values(drafts).filter((entry) => entry.status === "error").length;

  return { drafts, updateDraft, retry, flushAll, dirtyCount, errorCount };
}

export type TaskDrafts = ReturnType<typeof useTaskDrafts>;
