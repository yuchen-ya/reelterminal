import type { JSX } from "react";
import { ArrowUpRight, Info, Square } from "lucide-react";
import { wbButton } from "../../wb-button";

export interface VideoTopToolbarProps {
  readonly resolution?: string;
  readonly durationLabel: string;
  readonly version: number;
  readonly drawTool: "box" | "arrow";
  readonly onSelectDrawTool: (tool: "box" | "arrow") => void;
  readonly videoReady: boolean;
}

export function VideoTopToolbar({
  resolution,
  durationLabel,
  version,
  drawTool,
  onSelectDrawTool,
  videoReady,
}: VideoTopToolbarProps): JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-3 select-none">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg">
          {resolution ?? "分辨率未提供"}
        </span>
        <span className="rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-2">
          时长 {durationLabel}
        </span>
        <span className="rounded-[4px] border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-3">
          v{version}
        </span>
        <div
          className="flex items-center gap-1 text-[11px] text-fg-3 hover:text-fg-2 transition-colors cursor-help"
          title="暂停后框选/画箭头圈注；标记使用播放器时间，源 PTS 未映射时外部处理可能偏移"
        >
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>圈注与时间说明</span>
          <span className="sr-only">
            暂停后框选/画箭头圈注；标记使用播放器时间，源 PTS 未映射时外部处理可能偏移
          </span>
        </div>
      </div>

      <div className={wbButton.segmentedContainer}>
        <button
          type="button"
          onClick={() => onSelectDrawTool("box")}
          disabled={!videoReady}
          className={`inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            drawTool === "box"
              ? "bg-bg-3 font-medium text-fg shadow-sm"
              : "text-fg-3 hover:text-fg-2"
          }`}
        >
          <Square className="h-3 w-3" />
          框选问题位置
        </button>
        <button
          type="button"
          onClick={() => onSelectDrawTool("arrow")}
          disabled={!videoReady}
          className={`inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            drawTool === "arrow"
              ? "bg-bg-3 font-medium text-fg shadow-sm"
              : "text-fg-3 hover:text-fg-2"
          }`}
        >
          <ArrowUpRight className="h-3 w-3" />
          箭头指出位置
        </button>
      </div>
    </div>
  );
}
