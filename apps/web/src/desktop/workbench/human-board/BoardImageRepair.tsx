import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImageElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ImageRepairOperation, ImageRepairPoint } from "@reelterminal/core/review/image-repair";
import { canvasToPngBlob, createImageCanvas, executeImageRepair } from "../../../services/image-repair";
import { wbButton } from "../wb-button";

/** Pixel tools share the review executor, but commit only one native scene image replacement. */
export function BoardImageRepair({ element, files, onClose, onSave, onHistoryReady }: {
  element: ExcalidrawImageElement; files: BinaryFiles; onClose: () => void; onSave: (blob: Blob) => Promise<void>;
  onHistoryReady: (callback: ((direction: "undo" | "redo") => void) | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | undefined>(undefined);
  const composite = useRef<HTMLCanvasElement | undefined>(undefined);
  const layer = useRef<HTMLCanvasElement | undefined>(undefined);
  const draft = useRef<ImageRepairPoint[]>([]);
  const operations = useRef<ImageRepairOperation[]>([]);
  const cursor = useRef(0);
  const patches = useRef(new Map<string, CanvasImageSource>());
  const [tool, setTool] = useState<"brush" | "eraser" | "clone" | "patch">("brush");
  const [color, setColor] = useState("#ff2d55");
  const [size, setSize] = useState(24);
  const [opacity, setOpacity] = useState(1);
  const [hardness, setHardness] = useState(0.8);
  const [source, setSource] = useState<{ x: number; y: number }>();
  const [patch, setPatch] = useState<{ id: string; width: number; height: number }>();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const report = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));
  const paint = (image: HTMLCanvasElement) => {
    const target = canvas.current!;
    if (target.width !== image.width || target.height !== image.height) { target.width = image.width; target.height = image.height; }
    const context = target.getContext("2d")!; context.clearRect(0, 0, target.width, target.height); context.drawImage(image, 0, 0);
  };
  useEffect(() => {
    host.current!.focus();
    let cancelled = false;
    const load = async () => {
      const image = new Image(); image.src = files[element.fileId!].dataURL; await image.decode();
      if (cancelled) return;
      const source = createImageCanvas(image.naturalWidth, image.naturalHeight); source.getContext("2d")!.drawImage(image, 0, 0);
      base.current = source; composite.current = source;
      paint(source); setReady(true);
    };
    void load().catch(report);
    return () => { cancelled = true; };
  }, [element.fileId, files]);
  useEffect(() => () => { for (const image of patches.current.values()) if (image instanceof ImageBitmap) image.close(); }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>): ImageRepairPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.currentTarget.width - 1, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)),
      y: Math.max(0, Math.min(event.currentTarget.height - 1, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height)), pressure: event.pressure || 0.5 };
  };
  const operation = (points: readonly ImageRepairPoint[]): ImageRepairOperation => {
    if (tool === "brush") return { kind: "brush", size, color, points };
    if (tool === "eraser") return { kind: "eraser", size, points };
    if (tool === "clone") return { kind: "clone", size, source: source!, points, hardness, opacity };
    return { kind: "patch", resourceId: patch!.id, x: points[0].x, y: points[0].y, width: size * 4, height: size * 4 * patch!.height / patch!.width, opacity };
  };
  const execute = (points: readonly ImageRepairPoint[]) => executeImageRepair({ base: base.current!, layer: layer.current,
    region: { space: "source-pixels", x: 0, y: 0, width: base.current!.width, height: base.current!.height }, operations: [operation(points)], patches: patches.current });
  const moveHistory = (offset: number) => {
    cursor.current += offset;
    layer.current = undefined; composite.current = base.current!;
    for (const operation of operations.current.slice(0, cursor.current)) {
      const result = executeImageRepair({ base: base.current!, layer: layer.current, region: { space: "source-pixels", x: 0, y: 0, width: base.current!.width, height: base.current!.height }, operations: [operation], patches: patches.current });
      layer.current = result.layer; composite.current = result.composite;
    }
    paint(composite.current); setVersion(value => value + 1);
  };
  const applyHistory = (direction: "undo" | "redo") => {
    if (!base.current || busy) return;
    if (direction === "undo" && cursor.current > 0) moveHistory(-1);
    else if (direction === "redo" && cursor.current < operations.current.length) moveHistory(1);
  };
  useEffect(() => {
    onHistoryReady(applyHistory);
    return () => onHistoryReady(null);
  }, [onHistoryReady, busy]);

  return <div ref={host} tabIndex={-1} role="dialog" aria-modal="true" aria-label="画板图片修补" className="absolute inset-3 z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl outline-none" data-testid="human-board-repair-dialog" onKeyDown={event => {
    if ((event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    applyHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  }}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3 text-xs">
      <strong>源像素修补</strong>
      <select aria-label="修补工具" className="rounded bg-bg-2 p-1" value={tool} onChange={event => setTool(event.target.value as typeof tool)}><option value="brush">画笔</option><option value="eraser">橡皮（当前修补层）</option><option value="clone">仿制图章</option><option value="patch">外部贴片</option></select>
      <input type="color" aria-label="画笔颜色" value={color} onChange={event => setColor(event.target.value)} />
      <label>尺寸 <input className="w-16 rounded bg-bg-2 p-1" aria-label="像素工具尺寸" type="number" min={1} max={2048} value={size} onChange={event => setSize(Math.max(1, Math.min(2048, Number(event.target.value))))} /></label>
      <label>不透明度 <input aria-label="贴片仿制不透明度" type="range" min={0} max={1} step={0.05} value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label>
      {tool === "clone" && <><label>硬度 <input aria-label="仿制硬度" type="range" min={0} max={1} step={0.05} value={hardness} onChange={event => setHardness(Number(event.target.value))} /></label><span>{source ? `取样 ${source.x.toFixed(0)}, ${source.y.toFixed(0)}` : "Alt + 单击选择取样点"}</span></>}
      {tool === "patch" && <label className={wbButton.secondary}>导入贴片<input type="file" accept="image/*" hidden onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        void createImageBitmap(file).then(image => { const id = crypto.randomUUID(); patches.current.set(id, image); setPatch({ id, width: image.width, height: image.height }); }).catch(report);
      }} /></label>}
      <button className={wbButton.secondary} disabled={!ready || cursor.current === 0} onClick={() => moveHistory(-1)}>撤销修补</button>
      <button className={wbButton.secondary} disabled={!ready || cursor.current >= operations.current.length} onClick={() => moveHistory(1)}>重做修补</button>
      <button className={`${wbButton.primary} ml-auto`} data-testid="human-board-repair-save" disabled={!ready || busy || version === 0} onClick={() => {
        setBusy(true); void canvasToPngBlob(composite.current!).then(onSave).catch(report).finally(() => setBusy(false));
      }}>保存到此图片</button><button className={wbButton.secondary} disabled={busy} onClick={onClose}>取消</button>
    </div>
    <p className="px-3 py-2 text-xs text-fg-3">修补原件像素；画板上的裁剪、旋转、翻转会保留。外部贴片在点击位置放置，宽度为工具尺寸的 4 倍。</p>
    {error && <p role="alert" className="px-3 text-xs text-status-error">{error}</p>}
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-[#181818] p-4">
      <canvas ref={canvas} className="max-h-full max-w-full touch-none object-contain" style={{ cursor: tool === "clone" ? "crosshair" : "default" }} data-testid="human-board-repair-canvas"
        onPointerDown={event => {
          if (!ready) return;
          const position = point(event);
          if (tool === "clone" && event.altKey) { setSource(position); return; }
          if (tool === "clone" && !source) { setError("请先 Alt + 单击选择取样点"); return; }
          if (tool === "patch" && !patch) { setError("请先导入贴片"); return; }
          event.currentTarget.setPointerCapture(event.pointerId); draft.current = [position];
          paint(execute(draft.current).composite);
        }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { draft.current.push(point(event)); paint(execute(draft.current).composite); } }}
        onPointerUp={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const result = execute(draft.current); layer.current = result.layer; composite.current = result.composite; paint(result.composite);
          operations.current = [...operations.current.slice(0, cursor.current), operation(draft.current)]; cursor.current++; setVersion(value => value + 1); draft.current = [];
        }} />
    </div>
  </div>;
}
