import { useRef, useState } from "react";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import type { ModelPreviewRuntime } from "../model-preview/runtime";
import { ModelPreview } from "./ModelPreview";

export function ModelComparison({ left, right }: { left: string; right: string }) {
  const runtimes = useRef<Array<ModelPreviewRuntime | null>>([null, null]);
  const syncing = useRef(false);
  const [mode, setMode] = useState<"independent" | "direction" | "coordinates">("independent");
  const [confirmed, setConfirmed] = useState(false);
  const change = (index: number, view: ModelObservation) => {
    if (syncing.current || mode === "independent") return;
    syncing.current = true;
    try { runtimes.current[1 - index]?.linkView(view, mode === "coordinates"); }
    finally { syncing.current = false; }
  };
  return <div data-testid="model-comparison" className="space-y-2">
    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
      <select aria-label="模型相机联动" className="rounded border border-border bg-bg-2 p-1" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="independent">各自适应画面</option><option value="direction">联动方向（各自尺度）</option><option value="coordinates" disabled={!confirmed}>相同坐标相机</option></select>
      <label><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); if (!event.target.checked && mode === "coordinates") setMode("independent"); }} />我确认两版本坐标一致</label>
      <span>不自动配准；动画各自定位，不映射同名动画。</span>
    </div>
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">{[left, right].map((resourceId, index) => <div key={`${index}:${resourceId}`} className="h-[460px] min-w-0 rounded border border-border"><ModelPreview resourceId={resourceId} onRuntime={value => { runtimes.current[index] = value; }} onObservation={view => change(index, view)} /></div>)}</div>
  </div>;
}
