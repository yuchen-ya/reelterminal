import type { JSX } from "react";
import { Check, ClipboardCopy, Plus } from "lucide-react";

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
              复制失败，请确认项目工作区已就绪后重试
            </span>
          )}
        </div>

        <details className="rounded-xl border border-border bg-bg px-3 py-2" data-testid="workbench-ingest-help-panel">
          <summary className="cursor-pointer text-[11px] font-medium text-fg-2">
            Agent 接入说明（需已开启本项目 Agent 访问；不会自动开启写权限或发送消息）
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-fg-2">
            复制接入说明后立即运行其中的 start 命令，按返回的能力卡片选择 tools、describe 和 call。
            项目内已有批次使用 video.legacy-workbench 能力包。
          </p>
        </details>

        <p className="text-[11px] leading-relaxed text-fg-3">
          演示素材不会写入正式项目；视觉验收使用隔离测试项目，并通过真实导入/ingest
          路径建立批次。
        </p>
      </div>
    </div>
  );
}
