import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftPopover } from "@reelterminal/ui";
import { createReviewRange } from "@reelterminal/core/types/review-range";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useUIStore } from "../../../stores/ui-store";

export function ReviewRangeControl() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(1);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const store = useProjectStore.getState();
      const range = createReviewRange(store.project, start, end);
      const api = (window.reelterminal ?? window.openreel)?.production;
      if (!api)
        throw new Error(
          "Frame-bound review evidence requires the desktop render backend",
        );
      const captured = await api.captureReview({
        projectId: store.project.id,
        expectedRevision: store.projectRevision,
        timelineFrame: start,
      });
      const current = useProjectStore.getState();
      if (
        current.project.id !== store.project.id ||
        current.projectRevision !== store.projectRevision ||
        current.project !== store.project
      )
        throw new Error(
          "Project changed during evidence capture; create the task again",
        );
      const reviewRange = {
        ...range,
        screenshot: captured.screenshot,
        evidence: captured.evidence,
      };
      const result = await store.addProjectRequirement({
        title,
        status: "ready",
        reviewRange,
        description: t("production.reviewDescription"),
        references: reviewRange.mappings.map((mapping, index) => ({
          ref: `review-${index + 1}`,
          kind: "media",
          entityId: mapping.mediaId,
          label:
            store.project.mediaLibrary.items.find(
              (media) => media.id === mapping.mediaId,
            )?.name ?? mapping.mediaId,
          timing: {
            startSeconds: mapping.timelineStartSec,
            endSeconds: mapping.timelineEndSec,
          },
        })),
      });
      if (!result.success) {
        setError(result.error?.message ?? t("production.failed"));
        return;
      }
      setOpen(false);
      useUIStore.getState().openModal("requirement-board");
    } catch (failure) {
      // Translate capture/validation failures into a visible form error.
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ToolcraftPopover
      placement="above"
      alignment="end"
      label={t("production.review")}
      isOpen={open}
      onOpenChange={(value) => {
        if (value) {
          const frame = Math.floor(
            useTimelineStore.getState().playheadPosition *
              useProjectStore.getState().project.settings.frameRate,
          );
          setStart(frame);
          setEnd(frame + 1);
          setError("");
        }
        setOpen(value);
      }}
      content={
        <form
          className="w-72 space-y-3 bg-bg-elev p-3 text-xs text-fg"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <p>{t("production.reviewDescription")}</p>
          <label className="block">
            {t("production.reviewTitle")}
            <input
              className="w-full rounded border border-border bg-bg-2 p-2"
              value={title}
              required
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block">
            {t("production.start")}
            <input
              className="w-full rounded border border-border bg-bg-2 p-2"
              type="number"
              min={0}
              step={1}
              value={start}
              onChange={(event) => setStart(Number(event.target.value))}
            />
          </label>
          <label className="block">
            {t("production.end")}
            <input
              className="w-full rounded border border-border bg-bg-2 p-2"
              type="number"
              min={1}
              step={1}
              value={end}
              onChange={(event) => setEnd(Number(event.target.value))}
            />
          </label>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
          <button
            disabled={busy || !title.trim()}
            className="rounded bg-accent p-2 text-accent-fg disabled:opacity-50"
          >
            {t("production.review")}
          </button>
        </form>
      }
    >
      <button type="button" className="px-2 text-xs text-fg-2">
        {t("production.review")}
      </button>
    </ToolcraftPopover>
  );
}
