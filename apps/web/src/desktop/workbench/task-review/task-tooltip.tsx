import type { ReactNode } from "react";
import { useState } from "react";

export interface HoverTipState {
  title: string;
  detail?: string;
  x: number;
  y: number;
}

/**
 * 零延迟结构化悬浮提示（设计原则：摒弃浏览器原生 title 的 1 秒延迟）。
 * 第一行翠绿加粗说明核心动作，第二行浅灰副文说明状态影响与相邻按钮区别。
 * 接口契约（已与其它并行任务钉死，签名不得更改）。
 */
export function useHoverTip(): {
  tipNode: ReactNode;
  bindTip: (title: string, detail?: string) => {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
    onClickCapture: () => void;
  };
} {
  // Instant zero-delay floating tooltip state
  const [hoverTip, setHoverTip] = useState<HoverTipState | null>(null);

  const bindTip = (title: string, detail?: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.min(
        window.innerWidth - 280,
        Math.max(12, rect.left + rect.width / 2 - 130),
      );
      const showBelow = rect.top < 72;
      const y = showBelow ? rect.bottom + 8 : rect.top - 8;
      setHoverTip({ title, detail, x, y });
    },
    onMouseLeave: () => setHoverTip(null),
    onClickCapture: () => setHoverTip(null),
  });

  // Instant Zero-Delay Floating Tooltip Portal
  const tipNode = hoverTip ? (
    <div
      style={{
        left: `${hoverTip.x}px`,
        top: `${hoverTip.y}px`,
        transform: hoverTip.y < 80 ? "translateY(0)" : "translateY(-100%)",
      }}
      className="pointer-events-none fixed z-[100] flex max-w-[270px] flex-col gap-0.5 rounded-lg border border-accent/60 bg-[#11141a]/95 px-2.5 py-1.5 text-[11px] shadow-[0_10px_30px_rgba(0,0,0,0.85)] backdrop-blur-sm"
    >
      <strong className="font-semibold text-accent">{hoverTip.title}</strong>
      {hoverTip.detail && (
        <span className="leading-snug text-fg-2">{hoverTip.detail}</span>
      )}
    </div>
  ) : null;

  return { tipNode, bindTip };
}
