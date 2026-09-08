/**
 * "Save a time range of a media material as a segment" dialog: numeric
 * start/end (validated against the parent duration), a preview to check the
 * range, and the stored range becomes the material's identity — future
 * project attaches reuse exactly this in/out.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scissors } from "lucide-react";
import type { MediaMaterialRecord } from "@openreel/core";
import { isValidSegmentRange } from "@openreel/core";
import {
  ToolcraftDialog,
  ToolcraftDialogHeader,
  ToolcraftLayout,
  ToolcraftLayoutContent,
  ToolcraftLayoutFooter,
} from "@openreel/ui";
import { getMaterialLibraryService } from "../../../services/material-library/library-service";
import { toast } from "../../../stores/notification-store";

interface MaterialSegmentDialogProps {
  readonly parentMaterialId: string;
  readonly onClose: () => void;
  readonly onCreated: (segmentMaterialId: string) => void | Promise<void>;
}

export function MaterialSegmentDialog({
  parentMaterialId,
  onClose,
  onCreated,
}: MaterialSegmentDialogProps) {
  const { t } = useTranslation();
  const [parent, setParent] = useState<MediaMaterialRecord | null>(null);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const result = await getMaterialLibraryService().get(parentMaterialId);
      if (result.ok && result.value.kind === "media") {
        setParent(result.value);
        setEnd(
          result.value.metadata.durationSec
            ? Math.min(10, result.value.metadata.durationSec).toFixed(2)
            : "5",
        );
      }
    })();
  }, [parentMaterialId]);

  const startNum = Number.parseFloat(start);
  const endNum = Number.parseFloat(end);
  const duration = parent?.metadata.durationSec;
  const rangeValid =
    Number.isFinite(startNum) &&
    Number.isFinite(endNum) &&
    isValidSegmentRange(startNum, endNum, duration);

  const create = async () => {
    if (!parent || !rangeValid) return;
    setBusy(true);
    const result = await getMaterialLibraryService().create(
      {
        kind: "segment",
        parentMaterialId: parent.id,
        startSec: startNum,
        endSec: endNum,
        ...(title.trim() ? { title: title.trim() } : {}),
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        origin: `Segment of ${parent.title}`,
      },
      "user",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(t("material.segmentSaveFailed"), result.message);
      return;
    }
    toast.success(t("material.segmentSaved"), result.value.material.title);
    await onCreated(result.value.material.id);
  };

  return (
    <ToolcraftDialog isOpen onOpenChange={(open) => !open && onClose()} width={480}>
      <ToolcraftDialogHeader
        title={t("material.saveSegment")}
        subtitle={parent ? parent.title : ""}
        onOpenChange={onClose}
      />
      <ToolcraftLayout>
        <ToolcraftLayoutContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">
                {t("material.startSec")}
              </span>
              <input
                value={start}
                inputMode="decimal"
                onChange={(event) => setStart(event.target.value)}
                className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-fg-2">
                {t("material.endSec")}
                {duration !== undefined ? (
                  <span className="text-fg-3"> / {duration.toFixed(2)}s</span>
                ) : null}
              </span>
              <input
                value={end}
                inputMode="decimal"
                onChange={(event) => setEnd(event.target.value)}
                className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          {!rangeValid ? (
            <div className="rounded-[9px] border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-[12px] text-status-warning">
              {t("material.rangeInvalid")}
            </div>
          ) : null}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2">
              {t("material.title")}
            </span>
            <input
              value={title}
              placeholder={t("material.segmentTitlePlaceholder")}
              onChange={(event) => setTitle(event.target.value)}
              className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-fg-2">
              {t("material.tags")}
            </span>
            <input
              value={tags}
              placeholder={t("material.tagsPlaceholder")}
              onChange={(event) => setTags(event.target.value)}
              className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
        </ToolcraftLayoutContent>
        <ToolcraftLayoutFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[9px] border border-border bg-bg px-3 py-2 text-[12px] font-medium text-fg-2"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={!rangeValid || busy || !parent}
            onClick={create}
            className="flex items-center gap-1.5 rounded-[9px] bg-accent px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-50"
          >
            <Scissors size={13} aria-hidden />
            {t("material.saveSegment")}
          </button>
        </ToolcraftLayoutFooter>
      </ToolcraftLayout>
    </ToolcraftDialog>
  );
}
