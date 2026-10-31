import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { AppState } from "@excalidraw/excalidraw/types";
import { Lasso, Pentagon, Square, RotateCcw } from "lucide-react";
import type { BoardPoint, BoardRegion } from "../../../services/human-board/render";
import { wbButton } from "../wb-button";

export type CaptureShapeMode = "rect" | "polygon" | "lasso";

interface ScreenPoint {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

export interface HumanBoardCaptureOverlayProps {
  readonly state: AppState;
  readonly busy: boolean;
  readonly onConfirm: (region: BoardRegion) => void;
  readonly onCancel: () => void;
}

const CLOSE_THRESHOLD_PX = 12;
const LASSO_MIN_DIST_PX = 3;

export function HumanBoardCaptureOverlay({
  state,
  busy,
  onConfirm,
  onCancel,
}: HumanBoardCaptureOverlayProps): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<CaptureShapeMode>("rect");
  const [transparentBg, setTransparentBg] = useState(false);

  // Rect mode state
  const [rectStart, setRectStart] = useState<ScreenPoint | null>(null);
  const [rectEnd, setRectEnd] = useState<ScreenPoint | null>(null);
  const [isDraggingRect, setIsDraggingRect] = useState(false);

  // Polygon & Lasso shared vertex state
  const [vertices, setVertices] = useState<ScreenPoint[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [cursorPt, setCursorPt] = useState<ScreenPoint | null>(null);
  const [draggingVertexIdx, setDraggingVertexIdx] = useState<number | null>(null);
  const [isDrawingLasso, setIsDrawingLasso] = useState(false);

  const resetSelection = () => {
    setRectStart(null);
    setRectEnd(null);
    setIsDraggingRect(false);
    setVertices([]);
    setIsClosed(false);
    setCursorPt(null);
    setDraggingVertexIdx(null);
    setIsDrawingLasso(false);
  };

  const switchMode = (nextMode: CaptureShapeMode) => {
    setMode(nextMode);
    resetSelection();
  };

  const toScreenPoint = (clientX: number, clientY: number): ScreenPoint => {
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) return { x: clientX, y: clientY, clientX, clientY };
    const clampedClientX = Math.max(bounds.left, Math.min(bounds.right, clientX));
    const clampedClientY = Math.max(bounds.top, Math.min(bounds.bottom, clientY));
    return {
      x: clampedClientX - bounds.left,
      y: clampedClientY - bounds.top,
      clientX: clampedClientX,
      clientY: clampedClientY,
    };
  };

  const region = useMemo<BoardRegion | undefined>(() => {
    if (mode === "rect") {
      if (!rectStart || !rectEnd) return undefined;
      const s1 = viewportCoordsToSceneCoords({ clientX: rectStart.clientX, clientY: rectStart.clientY }, state);
      const s2 = viewportCoordsToSceneCoords({ clientX: rectEnd.clientX, clientY: rectEnd.clientY }, state);
      const width = Math.abs(s2.x - s1.x);
      const height = Math.abs(s2.y - s1.y);
      if (width < 1 || height < 1) return undefined;
      return {
        x: Math.min(s1.x, s2.x),
        y: Math.min(s1.y, s2.y),
        width,
        height,
        transparentBackground: transparentBg,
      };
    }

    if (!isClosed || vertices.length < 3) return undefined;
    const scenePts: BoardPoint[] = vertices.map((pt) =>
      viewportCoordsToSceneCoords({ clientX: pt.clientX, clientY: pt.clientY }, state),
    );
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of scenePts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 1 || height < 1) return undefined;
    return {
      x: minX,
      y: minY,
      width,
      height,
      points: scenePts,
      transparentBackground: transparentBg,
    };
  }, [mode, rectStart, rectEnd, isClosed, vertices, state, transparentBg]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (mode === "polygon" && !isClosed && vertices.length >= 3) {
          setIsClosed(true);
        } else if (region && !busy) {
          onConfirm(region);
        }
      } else if (event.key === "Backspace" || event.key === "Delete") {
        if (mode === "polygon" && !isClosed && vertices.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setVertices((prev) => prev.slice(0, -1));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode, isClosed, vertices.length, region, busy, onCancel, onConfirm]);

  const rectScreen = useMemo(() => {
    if (mode !== "rect" || !rectStart || !rectEnd) return null;
    return {
      x: Math.min(rectStart.x, rectEnd.x),
      y: Math.min(rectStart.y, rectEnd.y),
      width: Math.abs(rectEnd.x - rectStart.x),
      height: Math.abs(rectEnd.y - rectStart.y),
    };
  }, [mode, rectStart, rectEnd]);

  const hintText =
    mode === "rect"
      ? "拖拽框选矩形区域"
      : mode === "polygon"
        ? isClosed
          ? "可拖拽顶点微调轮廓 · 回车生成"
          : vertices.length === 0
            ? "点击画面依次添加多边形顶点"
            : vertices.length < 3
              ? `已添加 ${vertices.length} 个点（至少 3 个点）`
              : "点击起点或双击闭合 · Backspace 退格"
        : isClosed
          ? "已闭合自由选区 · 重新拖拽可重绘"
          : "按住左键自由涂抹轮廓，松开自动闭合";

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 select-none cursor-crosshair bg-black/15"
      data-testid="human-board-capture-overlay"
      data-capture-mode={mode}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mode === "polygon" && !isClosed && vertices.length > 0) {
          setVertices((prev) => prev.slice(0, -1));
        } else {
          onCancel();
        }
      }}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-capture-toolbar]")) return;
        if (mode === "polygon" && !isClosed && vertices.length >= 3) {
          event.preventDefault();
          setIsClosed(true);
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-capture-toolbar], button, label, input")) return;
        const pt = toScreenPoint(event.clientX, event.clientY);

        if (mode === "rect") {
          event.currentTarget.setPointerCapture(event.pointerId);
          setRectStart(pt);
          setRectEnd(pt);
          setIsDraggingRect(true);
          return;
        }

        if (mode === "lasso") {
          event.currentTarget.setPointerCapture(event.pointerId);
          setVertices([pt]);
          setIsClosed(false);
          setIsDrawingLasso(true);
          return;
        }

        // Polygon mode
        if (isClosed) {
          const hitIdx = vertices.findIndex(
            (v) => Math.hypot(v.x - pt.x, v.y - pt.y) <= CLOSE_THRESHOLD_PX,
          );
          if (hitIdx >= 0) {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDraggingVertexIdx(hitIdx);
          }
          return;
        }

        if (vertices.length >= 3) {
          const first = vertices[0];
          if (Math.hypot(first.x - pt.x, first.y - pt.y) <= CLOSE_THRESHOLD_PX) {
            setIsClosed(true);
            return;
          }
        }
        setVertices((prev) => [...prev, pt]);
        setCursorPt(pt);
      }}
      onPointerMove={(event) => {
        const pt = toScreenPoint(event.clientX, event.clientY);
        if (mode === "rect") {
          if (!isDraggingRect || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          setRectEnd(pt);
          return;
        }

        if (mode === "lasso") {
          if (!isDrawingLasso || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          setVertices((prev) => {
            const last = prev[prev.length - 1];
            if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= LASSO_MIN_DIST_PX) {
              return [...prev, pt];
            }
            return prev;
          });
          return;
        }

        // Polygon mode
        if (draggingVertexIdx !== null && event.currentTarget.hasPointerCapture(event.pointerId)) {
          setVertices((prev) =>
            prev.map((v, idx) => (idx === draggingVertexIdx ? pt : v)),
          );
          return;
        }
        if (!isClosed && vertices.length > 0) {
          setCursorPt(pt);
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (mode === "rect") {
          setIsDraggingRect(false);
        } else if (mode === "lasso" && isDrawingLasso) {
          setIsDrawingLasso(false);
          setVertices((prev) => {
            if (prev.length >= 3) {
              setIsClosed(true);
              return prev;
            }
            return [];
          });
        } else if (mode === "polygon" && draggingVertexIdx !== null) {
          setDraggingVertexIdx(null);
        }
      }}
    >
      {/* Top floating capture toolbar */}
      <div
        data-capture-toolbar="true"
        className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-bg-1/95 px-2.5 py-1.5 text-xs shadow-xl backdrop-blur"
      >
        <div className="flex items-center gap-0.5 rounded-[5px] border border-border bg-bg-2 p-0.5">
          <button
            type="button"
            data-testid="human-board-capture-mode-rect"
            onClick={() => switchMode("rect")}
            className={`inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-colors ${
              mode === "rect"
                ? "bg-accent text-accent-fg"
                : "text-fg-2 hover:bg-bg-3 hover:text-fg"
            }`}
          >
            <Square className="h-3 w-3" />
            <span>矩形</span>
          </button>
          <button
            type="button"
            data-testid="human-board-capture-mode-polygon"
            onClick={() => switchMode("polygon")}
            className={`inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-colors ${
              mode === "polygon"
                ? "bg-accent text-accent-fg"
                : "text-fg-2 hover:bg-bg-3 hover:text-fg"
            }`}
          >
            <Pentagon className="h-3 w-3" />
            <span>多边形</span>
          </button>
          <button
            type="button"
            data-testid="human-board-capture-mode-lasso"
            onClick={() => switchMode("lasso")}
            className={`inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-[11px] font-medium transition-colors ${
              mode === "lasso"
                ? "bg-accent text-accent-fg"
                : "text-fg-2 hover:bg-bg-3 hover:text-fg"
            }`}
          >
            <Lasso className="h-3 w-3" />
            <span>自由形状</span>
          </button>
        </div>

        <label className="inline-flex cursor-pointer items-center gap-1.5 px-1 text-[11px] text-fg-2 hover:text-fg">
          <input
            type="checkbox"
            checked={transparentBg}
            onChange={(e) => setTransparentBg(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-accent"
            data-testid="human-board-capture-transparent"
          />
          <span>透明底</span>
        </label>

        <div className="h-3.5 w-px bg-border" />
        <span className="text-[11px] text-fg-3">{hintText}</span>

        {(vertices.length > 0 || rectScreen) && (
          <button
            type="button"
            onClick={resetSelection}
            className={wbButton.ghost}
            title="重置选区"
            data-testid="human-board-capture-reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}

        {mode === "polygon" && !isClosed && vertices.length >= 3 && (
          <button
            type="button"
            className={wbButton.secondary}
            data-testid="human-board-capture-close-polygon"
            onClick={() => setIsClosed(true)}
          >
            闭合轮廓
          </button>
        )}

        <button
          type="button"
          className={wbButton.primary}
          disabled={!region || busy}
          data-testid="human-board-capture-confirm"
          onClick={() => {
            if (region) onConfirm(region);
          }}
        >
          生成 PNG
        </button>
        <button
          type="button"
          className={wbButton.secondary}
          onClick={onCancel}
        >
          取消
        </button>
      </div>

      {/* Rect visual selection box */}
      {rectScreen && (
        <div
          className="pointer-events-none absolute border-2 border-accent bg-accent/10"
          style={{
            left: rectScreen.x,
            top: rectScreen.y,
            width: rectScreen.width,
            height: rectScreen.height,
          }}
        />
      )}

      {/* Polygon / Lasso SVG visual overlay */}
      {mode !== "rect" && vertices.length > 0 && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          data-testid="human-board-capture-svg"
        >
          {isClosed ? (
            <polygon
              points={vertices.map((pt) => `${pt.x},${pt.y}`).join(" ")}
              fill="rgba(16, 185, 129, 0.14)"
              stroke="#10b981"
              strokeWidth={2}
            />
          ) : (
            <>
              <polyline
                points={vertices.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                fill="none"
                stroke="#10b981"
                strokeWidth={2}
              />
              {mode === "polygon" && cursorPt && (
                <line
                  x1={vertices[vertices.length - 1].x}
                  y1={vertices[vertices.length - 1].y}
                  x2={cursorPt.x}
                  y2={cursorPt.y}
                  stroke="#10b981"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
              )}
            </>
          )}
          {mode === "polygon" &&
            vertices.map((pt, idx) => {
              const isStart = idx === 0 && !isClosed && vertices.length >= 3;
              return (
                <circle
                  key={idx}
                  cx={pt.x}
                  cy={pt.y}
                  r={isStart ? 6 : 4.5}
                  fill={isStart ? "#10b981" : "#ffffff"}
                  stroke="#10b981"
                  strokeWidth={2}
                />
              );
            })}
        </svg>
      )}
    </div>
  );
}
