import type { JSX } from "react";
import { Check, ClipboardCopy, Plus } from "lucide-react";

/**
 * Exact, copyable Agent ingress instructions. The verb/argument names mirror
 * the real facade schemas (`workbench.ingest`, `media.import`) — this is a
 * documentation aid, not an executable shortcut, and it never contains a
 * token or enables write access by itself.
 */
export const AGENT_INGEST_INSTRUCTIONS = `1) 导入真实媒体（图片/视频需先进入本项目素材库）
   reelctl call media.import --path "<本地文件路径>" --idempotency-key "<唯一键>"

2) 节点命名与组织规范（必须遵守）
   - 保持节点命名简短：批次名 (name) 写完整上下文；条目 title 与 agentGuidance.nodeSlotLabel 必须精炼（建议 4~8 个汉字，勿重复堆砌批次前缀，如用 "普攻·H3" 而非 "赛琳妮运动连续性·普攻·H3与修订版对比"）。
   - 父节点聚合画板 vs 分类目录：多张抽帧/套图或低信息量需同屏审阅的图文数条目，应归入同一父节点（lineage.upstreamGroupId 或 parentNodeId）并标记 groupMode: "board"（默认收拢为一个聚合画板节点）；仅用于归类的目录标记 groupMode: "category"。
   - 视频对比预设：需与基准视频并排对比的条目，可指定 compareWithItemId: "<基准视频条目ID>"。

3) 提交审阅批次
   reelctl call workbench.ingest --batchId "<批次ID>" --name "<批次名>" --items '<items JSON>'
   items JSON 形如：
   [
     {"id":"img-1","title":"普攻·抽帧16","type":"image",
      "content":{"type":"image","mediaId":"<media.import 返回的 mediaId>"}},
     {"id":"vid-1","title":"普攻·H3","type":"video",
      "content":{"type":"video","mediaId":"<mediaId>","durationSec":12.5}},
     {"id":"txt-1","title":"审查结论","type":"text",
      "content":{"type":"text","entryId":"entry-1","title":"审查结论",
                 "speakerOrContext":"旁白","text":"正文…"}},
     {"id":"data-1","title":"帧率统计","type":"data",
      "content":{"type":"data","datasetId":"ds-1",
                 "columns":[{"columnId":"c1","title":"列"}],
                 "rows":[{"rowId":"r1","cells":{"c1":"值"}}],
                 "proposals":[]}}
   ]

4) 查看批次
   reelctl call workbench.get --batchId "<批次ID>"`;

export interface WorkbenchStartPanelProps {
  onCopy: () => void;
  copyState: "idle" | "copied" | "failed";
  onOpenDocs: () => void;
  onCreateBatch: () => void;
}

export function WorkbenchStartPanel({
  onCopy,
  copyState,
  onOpenDocs,
  onCreateBatch,
}: WorkbenchStartPanelProps): JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center overflow-y-auto bg-stage-bg p-6"
      data-testid="workbench-start-panel"
    >
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-border bg-bg-1 p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-fg">导入一批素材，或让 Agent 提交待审内容</h2>
          <p className="text-xs leading-relaxed text-fg-2">
            工作台显示本项目已接收的审阅批次。批次到达后，待审节点会出现在左侧队列，
            中间是当前素材的查看器与问题栏，底部是节点详情与决定按钮。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCreateBatch}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong"
            data-testid="workbench-create-batch"
          >
            <Plus className="h-3.5 w-3.5" />
            从项目素材创建批次
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2 px-3.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-copy-ingest"
          >
            {copyState === "copied" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
            {copyState === "copied" ? "已复制接入说明" : "复制接入说明"}
          </button>
          <button
            type="button"
            onClick={onOpenDocs}
            className="rounded-lg border border-border bg-bg-2 px-3 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-ingest-help"
          >
            查看接入命令
          </button>
          {copyState === "failed" && (
            <span className="text-[11px] text-status-warning">
              复制失败，请展开下方命令手动复制
            </span>
          )}
        </div>

        <details className="rounded-xl border border-border bg-bg px-3 py-2" data-testid="workbench-ingest-help-panel">
          <summary className="cursor-pointer text-[11px] font-medium text-fg-2">
            Agent 接入说明（需已开启本项目 Agent 访问；不会自动开启写权限或发送消息）
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">
            {AGENT_INGEST_INSTRUCTIONS}
          </pre>
        </details>

        <p className="text-[11px] leading-relaxed text-fg-3">
          演示素材不会写入正式项目；视觉验收使用隔离测试项目，并通过真实导入/ingest
          路径建立批次。
        </p>
      </div>
    </div>
  );
}
