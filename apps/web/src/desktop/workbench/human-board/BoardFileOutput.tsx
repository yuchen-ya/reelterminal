import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
import { useEffect, useState } from "react";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import type { FileResource } from "@reelterminal/core/review/types";
import { prepareBoardFileExport } from "../../../services/human-board/export";
import { exportValue } from "../../../services/review-workspace/export";
import type { HumanBoard } from "../../../services/human-board/storage";
import { wbButton } from "../wb-button";

export interface BoardOutput { name: string; resource?: FileResource; blob?: Blob; text?: string; image: boolean }

export function BoardFileOutput({ board, output, onClose, onAddImage, onError }: {
  board: HumanBoard; output: BoardOutput; onClose: () => void;
  onAddImage: () => void; onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReviewExportStatus>();
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    const imageUrl = output.blob && output.image ? URL.createObjectURL(output.blob) : "";
    setUrl(imageUrl);
    void prepareBoardFileExport(board, output.name, output.resource ? { resourceId: output.resource.id } : { text: output.text! })
      .then(value => { if (!cancelled) setStatus(value); }).catch(onError);
    return () => { cancelled = true; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [output]);

  return <div className="absolute bottom-4 right-4 z-20 w-80 rounded-lg border border-border bg-bg-1 p-3 shadow-xl" data-testid="human-board-output">
    <div className="mb-2 flex items-center justify-between gap-2 text-xs"><strong className="truncate">{output.name}</strong><button onClick={onClose} aria-label={t("Close output")}>×</button></div>
    {url && <img src={url} className="mb-2 max-h-48 w-full object-contain" alt={t("Frozen region capture")} data-testid="human-board-output-image" />}
    <div className="flex flex-wrap gap-2">
      <button className={`${wbButton.primary} cursor-grab`} draggable={status?.state === "ready"} data-testid="human-board-output-drag" onDragStart={event => {
        event.preventDefault();
        if (status?.state === "ready") void window.reelterminal!.reviewExport!.startDrag(status.exportId, false).then(() => setNotice(translate("Handed to the system for dragging"))).catch(onError);
      }}>{status?.state === "ready" ? t("review.export.dragFiles") : t("Preparing file…")}</button>
      {(output.blob || output.text !== undefined) && <button className={wbButton.secondary} data-testid="human-board-output-copy" onClick={() => {
        void (output.blob ? navigator.clipboard.write([new ClipboardItem({ "image/png": output.blob })]) : navigator.clipboard.writeText(output.text!))
          .then(() => setNotice(translate("Copied to clipboard"))).catch(onError);
      }}>{t("Copy")}</button>}
      <button className={wbButton.secondary} disabled={status?.state !== "ready"} data-testid="human-board-output-save" onClick={() => {
        void window.reelterminal!.fs.showOpenDialog({ directory: true, filters: [] }).then(async directory => {
          if (!directory) return;
          exportValue(await window.reelterminal!.reviewExport!.copy({ exportId: status!.exportId, nodeId: board.id, directory, source: "user" }));
          setNotice(translate("Saved to {{v0}}", { v0: directory }));
        }).catch(onError);
      }}>{t("Save to…")}</button>
      {output.image && <button className={wbButton.secondary} data-testid="human-board-output-add" onClick={onAddImage}>{t("Add to board as a new image")}</button>}
    </div>
    <p role="status" className="mt-2 text-[11px] text-fg-3">{notice || t("Independent file snapshot; no review node was created.")}</p>
  </div>;
}
