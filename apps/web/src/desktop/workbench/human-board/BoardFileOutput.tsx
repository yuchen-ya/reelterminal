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
    <div className="mb-2 flex items-center justify-between gap-2 text-xs"><strong className="truncate">{output.name}</strong><button onClick={onClose} aria-label="关闭输出">×</button></div>
    {url && <img src={url} className="mb-2 max-h-48 w-full object-contain" alt="冻结的区域画面" data-testid="human-board-output-image" />}
    <div className="flex flex-wrap gap-2">
      <button className={`${wbButton.primary} cursor-grab`} draggable={status?.state === "ready"} data-testid="human-board-output-drag" onDragStart={event => {
        event.preventDefault();
        if (status?.state === "ready") void window.reelterminal!.reviewExport!.startDrag(status.exportId, false).then(() => setNotice("已交给系统拖动")).catch(onError);
      }}>{status?.state === "ready" ? "拖出文件" : "正在准备文件…"}</button>
      {(output.blob || output.text !== undefined) && <button className={wbButton.secondary} data-testid="human-board-output-copy" onClick={() => {
        void (output.blob ? navigator.clipboard.write([new ClipboardItem({ "image/png": output.blob })]) : navigator.clipboard.writeText(output.text!))
          .then(() => setNotice("已复制到剪贴板")).catch(onError);
      }}>复制</button>}
      <button className={wbButton.secondary} disabled={status?.state !== "ready"} data-testid="human-board-output-save" onClick={() => {
        void window.reelterminal!.fs.showOpenDialog({ directory: true, filters: [] }).then(async directory => {
          if (!directory) return;
          exportValue(await window.reelterminal!.reviewExport!.copy({ exportId: status!.exportId, nodeId: board.id, directory, source: "user" }));
          setNotice(`已保存到 ${directory}`);
        }).catch(onError);
      }}>保存到…</button>
      {output.image && <button className={wbButton.secondary} data-testid="human-board-output-add" onClick={onAddImage}>作为新图加入画板</button>}
    </div>
    <p role="status" className="mt-2 text-[11px] text-fg-3">{notice || "独立文件快照；未创建审阅节点。"}</p>
  </div>;
}
