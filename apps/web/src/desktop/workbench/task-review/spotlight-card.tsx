import { useRef, useState } from "react";
import type {
  CSSProperties,
  JSX,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Focus,
  GripHorizontal,
  LayoutGrid,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { useHoverTip } from "./task-tooltip";

/**
 * 聚光灯随手工具卡外壳（纯展示，不含业务数据获取）。
 * 移植自 Review Workbench v1 设计稿 `TaskReviewWorkspace.renderDraggableHandToolCard`。
 *
 * 设计原则：
 * - 单图标翻面：头部唯一的 ⊞/🔧 图标按钮切换「工具卡面 / 九宫格启动盘」；
 * - 全场唯一绿色主 CTA：footer 右侧唯一的 accent 实色按钮，完成态显示 Check；
 * - 拖拽 + 一键归位：头部按住可任意拖动（clamp 到视口），拖离后头部出现 RotateCcw 归位。
 *
 * 内容位（toolBody / footerStatus / launcherItems / stepDots / primaryAction）全部由
 * props 注入，卡片本体不读 store、不发请求（CONTRACT：只消费 props）。卡片深色底
 * （#15181e/#1c2028/#101216）是设计签名保留硬编码；accent 一律走宿主 token 类。
 */
export type SpotlightCardFace = "tool" | "launcher";

export interface SpotlightLauncherItem {
  id: string;
  label: string;
  /** bindTip 的 title/detail 拆两行：label 做动作行，tip 做副文行 */
  tip: string;
  icon: LucideIcon;
  active?: boolean;
  testId?: string;
  onClick: () => void;
}

export interface SpotlightStepDot {
  id: string;
  /** tooltip 动作行 */
  title: string;
  /** tooltip 副文行 */
  detail?: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
}

export interface SpotlightPrimaryAction {
  label: string;
  /** true 时显示 Check 图标 */
  doneState?: boolean;
  tipTitle: string;
  tipDetail?: string;
  testId?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function SpotlightCard({
  headerTitle,
  face,
  onFlipFace,
  launcherItems,
  toolBody,
  showCompletionToggle,
  completionActive,
  onToggleCompletion,
  spotlightActive,
  onToggleSpotlight,
  onBack,
  canBack,
  footerStatus,
  stepDots,
  primaryAction,
}: {
  /** 头部标题（如 "#2 林深" / "工作台" / "已完成 8/8"） */
  headerTitle: string;
  face: SpotlightCardFace;
  /** 头部翻面按钮（唯一 ⊞/🔧 图标按钮） */
  onFlipFace: (face: SpotlightCardFace) => void;
  /** 3×3 启动盘（由宿主提供；face === "launcher" 时渲染） */
  launcherItems: readonly SpotlightLauncherItem[];
  /** face === "tool" 时的卡面内容（改词/批注/成组清单等，由宿主渲染） */
  toolBody: ReactNode;
  /** 是否显示头部「导出与总览」快捷切换（设计稿中 !isAllCompleted 时显示） */
  showCompletionToggle: boolean;
  /** 该切换按钮的激活态 */
  completionActive: boolean;
  onToggleCompletion: () => void;
  /** 启动盘底部「聚光」压暗开关状态 */
  spotlightActive: boolean;
  onToggleSpotlight: () => void;
  /** footer 左侧返回箭头（纯浏览返回） */
  onBack: () => void;
  canBack: boolean;
  /** footer 左侧、返回箭头右边的槽（宿主放 #序号 + 保留/返工/丢弃 决定按钮组） */
  footerStatus: ReactNode;
  /** footer 步骤圆点 */
  stepDots: readonly SpotlightStepDot[];
  /** 全场唯一绿色主按钮（null 则不渲染，如完成态） */
  primaryAction: SpotlightPrimaryAction | null;
}): JSX.Element {
  const { tipNode, bindTip } = useHoverTip();

  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const dragOriginRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const floatingCardRef = useRef<HTMLDivElement | null>(null);

  const handleCardDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 拖拽起点落在 button/input/textarea/select 上不启动拖拽（设计稿行为）。
    if ((e.target as HTMLElement).closest("button, input, textarea, select")) {
      return;
    }
    const cardEl = floatingCardRef.current;
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    const currentX = cardPos ? cardPos.x : rect.left;
    const currentY = cardPos ? cardPos.y : rect.top;

    dragOriginRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: currentX,
      origY: currentY,
    };
    setCardPos({ x: currentX, y: currentY });
    setIsDraggingCard(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleCardDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingCard || !dragOriginRef.current) return;
    const dx = e.clientX - dragOriginRef.current.startX;
    const dy = e.clientY - dragOriginRef.current.startY;
    const nextX = Math.max(
      12,
      Math.min(window.innerWidth - 360, dragOriginRef.current.origX + dx),
    );
    const nextY = Math.max(
      44,
      Math.min(window.innerHeight - 220, dragOriginRef.current.origY + dy),
    );
    setCardPos({ x: nextX, y: nextY });
  };

  const handleCardDragEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingCard) return;
    setIsDraggingCard(false);
    dragOriginRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const cardPositionStyle: CSSProperties = cardPos
    ? {
        position: "fixed",
        left: `${cardPos.x}px`,
        top: `${cardPos.y}px`,
        zIndex: 50,
      }
    : {};

  return (
    <div
      ref={floatingCardRef}
      style={cardPositionStyle}
      className={`flex w-[356px] shrink-0 flex-col rounded-xl border border-accent/50 bg-[#15181e] text-xs text-fg shadow-[0_20px_50px_rgba(0,0,0,0.85)] xl:w-[376px] ${
        cardPos ? "" : "relative z-40 self-start"
      }`}
      role="dialog"
      aria-label="聚光灯工具卡"
      data-testid="agent-spotlight-card"
    >
      {tipNode}

      {/* MINIMAL DRAGGABLE HEADER */}
      <div
        onPointerDown={handleCardDragStart}
        onPointerMove={handleCardDragMove}
        onPointerUp={handleCardDragEnd}
        className="flex h-9 cursor-grab items-center justify-between gap-2 rounded-t-xl border-b border-white/10 bg-[#1c2028] px-3 select-none active:cursor-grabbing"
      >
        <div
          className="flex min-w-0 items-center gap-2"
          {...bindTip(
            "按住标题栏可任意拖动工具卡位置",
            "拖离后右侧会出现「归位」图标",
          )}
        >
          <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-fg-3" />
          <strong className="truncate text-xs font-semibold text-fg">
            {headerTitle}
          </strong>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {cardPos && (
            <button
              type="button"
              onClick={() => setCardPos(null)}
              {...bindTip("卡片归位", "将工具卡恢复到舞台右侧默认停靠区")}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-white/10 hover:text-white cursor-pointer"
              data-testid="spotlight-card-reset"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}

          {face === "tool" && showCompletionToggle && (
            <button
              type="button"
              onClick={() => onToggleCompletion()}
              {...bindTip(
                completionActive ? "返回审阅工具" : "导出与总览",
                "切换查看成果导出与全局复盘面板",
              )}
              className={`flex h-6 w-6 items-center justify-center rounded transition-colors cursor-pointer ${
                completionActive
                  ? "bg-accent/20 text-accent"
                  : "text-fg-3 hover:bg-white/10 hover:text-white"
              }`}
              data-testid="spotlight-completion-toggle"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={() => onFlipFace(face === "tool" ? "launcher" : "tool")}
            {...bindTip(
              face === "tool" ? "打开九宫格功能面板" : "返回当前审阅工具",
              face === "tool"
                ? "切换卡面：打开总览、导出、原件、Agent 等全部工作台界面"
                : "切回当前条目的改词与批注工具",
            )}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors cursor-pointer ${
              face === "launcher"
                ? "bg-accent text-accent-fg"
                : "bg-white/10 text-fg-2 hover:text-white"
            }`}
            data-testid="spotlight-flip-btn"
          >
            {face === "launcher" ? (
              <Wrench className="h-3.5 w-3.5" />
            ) : (
              <LayoutGrid className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* CARD BODY */}
      <div className="flex max-h-[calc(100vh-190px)] flex-col gap-2.5 overflow-y-auto p-3">
        {face === "launcher" ? (
          /* CLEAN 3×3 ICON LAUNCHER GRID */
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-3 gap-2">
              {launcherItems.map((item) => {
                const IconComp = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.onClick}
                    {...bindTip(item.label, item.tip)}
                    className={`group flex flex-col items-center justify-center gap-1.5 rounded-xl border py-3 transition-all cursor-pointer ${
                      item.active
                        ? "border-accent bg-accent/15 text-white"
                        : "border-white/5 bg-[#101216] text-fg-2 hover:border-accent/40 hover:bg-[#191d24] hover:text-white"
                    }`}
                    data-testid={item.testId}
                  >
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-full transition-transform group-hover:scale-105 ${
                        item.active
                          ? "bg-accent text-accent-fg"
                          : "bg-[#1f242d] text-accent"
                      }`}
                    >
                      <IconComp className="h-4 w-4" />
                    </div>
                    <span className="text-[11px] font-medium">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between rounded-lg bg-[#101216] px-2.5 py-1.5 text-[11px] text-fg-3">
              <button
                type="button"
                onClick={() => onToggleSpotlight()}
                {...bindTip(
                  "聚光灯背景压暗",
                  spotlightActive
                    ? "当前已开启：压暗四周背景，聚焦中央舞台"
                    : "点击开启聚光灯背景压暗",
                )}
                className={`inline-flex items-center gap-1 cursor-pointer ${
                  spotlightActive ? "text-accent" : "text-fg-3"
                }`}
                data-testid="spotlight-focus-toggle"
              >
                <Focus className="h-3 w-3" />
                聚光
              </button>
            </div>
          </div>
        ) : (
          /* CARD FACE CONTENT SLOT：改词/批注/成组清单等由宿主渲染 */
          <div data-testid="spotlight-tool-body">{toolBody}</div>
        )}
      </div>

      {/* CARD FOOTER: Left = Current Unit In-Place Status | Right = Smart Scene Advance CTA */}
      <div className="flex items-center justify-between gap-1.5 rounded-b-xl border-t border-white/10 bg-[#1c2028] px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!canBack}
            onClick={() => onBack()}
            {...bindTip(
              "返回上一画面",
              "只回到上一次浏览的位置，不会撤销任何已作出的裁决",
            )}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-2 hover:bg-white/10 hover:text-white disabled:opacity-30 cursor-pointer"
            data-testid="spotlight-back-btn"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {footerStatus}
        </div>

        <div className="flex items-center gap-2">
          {/* Step Dots */}
          {stepDots.length > 0 && (
            <div className="flex items-center gap-1">
              {stepDots.map((dot) => (
                <button
                  key={dot.id}
                  type="button"
                  {...bindTip(dot.title, dot.detail)}
                  onClick={() => dot.onClick()}
                  className={`h-1.5 rounded-full transition-all cursor-pointer ${
                    dot.active
                      ? "w-3 bg-accent"
                      : dot.done
                        ? "w-1.5 bg-accent/40"
                        : "w-1.5 bg-white/20"
                  }`}
                  data-testid={`spotlight-step-dot-${dot.id}`}
                />
              ))}
            </div>
          )}

          {/* THE SINGLE PRIMARY GREEN CTA ON THE ENTIRE SCREEN */}
          {primaryAction && (
            <button
              type="button"
              data-testid={primaryAction.testId}
              disabled={primaryAction.disabled}
              onClick={() => primaryAction.onClick()}
              {...bindTip(primaryAction.tipTitle, primaryAction.tipDetail)}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-bold text-accent-fg hover:brightness-110 cursor-pointer shrink-0 shadow-[0_0_14px_var(--accent-glow)] disabled:opacity-40"
            >
              {primaryAction.doneState && (
                <Check className="h-3.5 w-3.5 stroke-[2.5]" />
              )}
              {primaryAction.label}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
