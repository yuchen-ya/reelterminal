import { useEffect, useRef, useState } from "react";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import { reviewService } from "../../../services/review-workspace/service";
import type { ModelPreviewRuntime, PreviewInfo, StandardView } from "../model-preview/runtime";

const control = "rounded border border-border bg-bg-2 px-2 py-1 text-xs text-fg disabled:opacity-40";
export interface ModelCapture { blob: Blob; observation: ModelObservation }
export function ModelPreview({ resourceId, restore, onCapture, onRuntime, onObservation }: {
  resourceId: string; restore?: ModelObservation;
  onCapture?: (capture: ModelCapture) => void;
  onRuntime?: (runtime: ModelPreviewRuntime | null) => void;
  onObservation?: (view: ModelObservation) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<ModelPreviewRuntime | null>(null);
  const callbacks = useRef({ onRuntime, onObservation }); callbacks.current = { onRuntime, onObservation };
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "context-lost">("loading");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<PreviewInfo>();
  const [view, setView] = useState<ModelObservation>();
  const [fileInfo, setFileInfo] = useState("");
  const [playing, setPlaying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPhase("loading"); setInfo(undefined); setView(undefined); setError(""); setPlaying(false);
    const load = async () => {
      const [resource] = await reviewService.getResources([resourceId]);
      setFileInfo(`${resource.originalFileName} · ${resource.size.toLocaleString()} B`);
      if (resource.modelPreview && resource.modelPreview.status !== "ready") throw new Error(resource.modelPreview.reason ?? "模型不支持预览");
      if (resource.storage.kind === "unavailable") throw new Error(resource.storage.reason);
      const resolved = await window.reelterminal!.reviewFiles!.resolve(resourceId);
      if (!resolved.ok) throw new Error(resolved.error.message);
      const { ModelPreviewRuntime } = await import("../model-preview/runtime");
      if (cancelled) return;
      const instance = new ModelPreviewRuntime(host.current!, next => {
        if (cancelled) return;
        setView(next); callbacks.current.onObservation?.(next);
      }, () => { if (!cancelled) { setPhase("context-lost"); setPlaying(false); } });
      runtime.current = instance; callbacks.current.onRuntime?.(instance);
      const result = await instance.load(`app://reelterminal/review-media/${resourceId}`, restore);
      if (cancelled || !result) return;
      setInfo(result); setPhase("ready");
    };
    void load().catch(problem => {
      if (cancelled) return;
      runtime.current?.dispose(); runtime.current = null; callbacks.current.onRuntime?.(null);
      setError(problem instanceof Error ? problem.message : String(problem)); setPhase("error");
    });
    return () => { cancelled = true; runtime.current?.dispose(); runtime.current = null; callbacks.current.onRuntime?.(null); };
  }, [resourceId, restore, attempt]);
  const animate = (index: number, time: number, play: boolean) => { runtime.current!.setAnimation(index, time, play); setPlaying(play); };
  return <div className="flex h-full min-h-[320px] flex-col" data-testid="model-preview" data-resource-id={resourceId} data-phase={phase} data-observation={view ? JSON.stringify(view) : ""}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 p-2">
      <button className={control} disabled={phase !== "ready"} onClick={() => runtime.current!.fit()}>适应画面</button>
      <select className={control} aria-label="标准视角" disabled={phase !== "ready"} defaultValue="" onChange={event => { runtime.current!.fit(event.target.value as StandardView); event.target.value = ""; }}>
        <option value="" disabled>标准视角</option>{[["front", "前"], ["back", "后"], ["left", "左"], ["right", "右"], ["top", "顶"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <select className={control} aria-label="模型背景" value={view?.background ?? "dark"} disabled={phase !== "ready"} onChange={event => { runtime.current!.setBackground(event.target.value as "light" | "dark"); setView(runtime.current!.observation()); }}><option value="dark">深背景</option><option value="light">浅背景</option></select>
      {onCapture && <button className={control} disabled={phase !== "ready"} data-testid="model-capture" onClick={() => { setPlaying(false); void runtime.current!.capture().then(onCapture).catch(problem => setError(String(problem))); }}>截图反馈</button>}
    </div>
    <div ref={host} className="relative grid min-h-[220px] flex-1 place-items-center overflow-hidden" data-testid="model-canvas-host" />
    {phase !== "ready" && <div className="p-3 text-xs text-fg-2" role={phase === "error" ? "alert" : "status"}>{phase === "loading" ? "正在加载 GLB…" : phase === "context-lost" ? "WebGL 上下文丢失；原件与反馈已保留" : error}
      {phase !== "loading" && <button className={`${control} ml-2`} onClick={() => setAttempt(value => value + 1)}>重载预览</button>}
    </div>}
    {phase === "ready" && info && <>
      {info.animations.length > 0 && <div className="flex shrink-0 flex-wrap items-center gap-2 p-2">
        <select className={control} aria-label="模型动画" value={view?.animation?.index ?? 0} onChange={event => animate(Number(event.target.value), 0, false)}>{info.animations.map((clip, index) => <option key={index} value={index}>{clip.name}</option>)}</select>
        <button className={control} data-testid="model-play" onClick={() => animate(view!.animation!.index, view!.animation!.time, !playing)}>{playing ? "暂停" : "播放"}</button>
        <input aria-label="动画时间" className="min-w-16 flex-1" type="range" min={0} step={0.001} max={info.animations[view?.animation?.index ?? 0].duration} value={view?.animation?.time ?? 0} onChange={event => animate(view!.animation!.index, Number(event.target.value), false)} />
        <output className="text-xs tabular-nums">{(view?.animation?.time ?? 0).toFixed(3)} s</output>
      </div>}
      <details className="shrink-0 px-2 pb-2 text-xs text-fg-3"><summary>模型信息 · 约定轴向，非自动识别朝向</summary><p>{fileInfo}</p><p>{info.scenes} 场景 · {info.meshes} meshes · {info.triangles.toLocaleString()} 三角图元（含 {info.instances} 节点实例）</p><p>glTF 约定单位；边界范围 {info.bounds.map(value => value.toPrecision(4)).join(" × ")}</p><p>几何展开预算计数 {info.decodedBytes.toLocaleString()} B · 纹理 {info.texturePixels.toLocaleString()} pixels · neutral-r182-v1</p>{info.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>左键旋转 · 右键平移 · 滚轮缩放</p></details>
    </>}
  </div>;
}
