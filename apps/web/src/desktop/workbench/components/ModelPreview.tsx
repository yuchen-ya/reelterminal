import { LocalizedMessage } from "../../../i18n/LocalizedMessage";
import { getAppLocale } from "../../../i18n";
import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
import { useEffect, useRef, useState } from "react";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import type { FileResource } from "@reelterminal/core/review/types";
import { reviewService } from "../../../services/review-workspace/service";
import type { ModelPreviewRuntime, PreviewInfo, StandardView } from "../model-preview/runtime";
import { wbButton } from "../wb-button";

const selectControl = "h-7 rounded-[6px] border border-border bg-bg-2 px-2 text-xs text-fg hover:bg-bg-3 focus:outline-none disabled:opacity-40";

export interface ModelCapture { blob: Blob; observation: ModelObservation }

export function ModelPreview({ resourceId, restore, onCapture, onRuntime, onObservation, resource: suppliedResource, captureLabel = translate("Capture feedback") }: {
  resourceId: string; restore?: ModelObservation;
  resource?: FileResource;
  captureLabel?: string;
  onCapture?: (capture: ModelCapture) => void;
  onRuntime?: (runtime: ModelPreviewRuntime | null) => void;
  onObservation?: (view: ModelObservation) => void;
}) {
  const { t } = useTranslation();
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
      const resource = suppliedResource ?? (await reviewService.getResources([resourceId]))[0];
      if (cancelled) return;
      setFileInfo(`${resource.originalFileName} · ${resource.size.toLocaleString(getAppLocale())} B`);
      if (resource.modelPreview && resource.modelPreview.status !== "ready") throw new Error(resource.modelPreview.reason ?? translate("Model preview unsupported"));
      if (resource.storage.kind === "unavailable") throw new Error(resource.storage.reason);
      const resolved = await window.reelterminal!.reviewFiles!.resolve(resourceId);
      if (cancelled) return;
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
  }, [resourceId, suppliedResource, restore, attempt]);

  const animate = (index: number, time: number, play: boolean) => { runtime.current!.setAnimation(index, time, play); setPlaying(play); };

  return (
    <div className="flex h-full min-h-[320px] flex-col" data-testid="model-preview" data-resource-id={resourceId} data-phase={phase} data-observation={view ? JSON.stringify(view) : ""}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-bg-1 px-3">
        <button className={wbButton.secondary} disabled={phase !== "ready"} onClick={() => runtime.current!.fit()}>{t("Fit view")}</button>
        <select className={selectControl} aria-label={t("Standard view")} disabled={phase !== "ready"} defaultValue="" onChange={event => { runtime.current!.fit(event.target.value as StandardView); event.target.value = ""; }}>
          <option value="" disabled>{t("Standard view")}</option>{[["front", t("Front")], ["back", t("editorTour.back")], ["left", t("Left")], ["right", t("Right")], ["top", t("Top")]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select className={selectControl} aria-label={t("Model background")} value={view?.background ?? "dark"} disabled={phase !== "ready"} onChange={event => { runtime.current!.setBackground(event.target.value as "light" | "dark"); setView(runtime.current!.observation()); }}>
          <option value="dark">{t("Dark background")}</option><option value="light">{t("Light background")}</option>
        </select>
        {onCapture && <button className={wbButton.secondary} disabled={phase !== "ready"} data-testid="model-capture" onClick={() => { setPlaying(false); void runtime.current!.capture().then(onCapture).catch(problem => setError(String(problem))); }}>{captureLabel}</button>}
      </div>
      <div ref={host} className="relative grid min-h-[220px] flex-1 place-items-center overflow-hidden" data-testid="model-canvas-host" />
      {phase !== "ready" && (
        <div className="p-3 text-xs text-fg-2" role={phase === "error" ? "alert" : "status"}>
          <LocalizedMessage>{phase === "loading" ? t("Loading GLB…") : phase === "context-lost" ? t("WebGL context lost. Originals and feedback are preserved.") : error}</LocalizedMessage>
          {phase !== "loading" && <button className={`${wbButton.secondary} ml-2`} onClick={() => setAttempt(value => value + 1)}>{t("Reload preview")}</button>}
        </div>
      )}
      {phase === "ready" && info && (
        <>
          {info.animations.length > 0 && (
            <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-bg-1 px-3">
              <select className={selectControl} aria-label={t("Model animation")} value={view?.animation?.index ?? 0} onChange={event => animate(Number(event.target.value), 0, false)}>
                {info.animations.map((clip, index) => <option key={index} value={index}>{clip.name}</option>)}
              </select>
              <button className={wbButton.secondary} data-testid="model-play" onClick={() => animate(view!.animation!.index, view!.animation!.time, !playing)}>
                {playing ? t("Pause") : t("Play")}
              </button>
              <input aria-label={t("Animation time")} className="min-w-16 flex-1 accent-accent" type="range" min={0} step={0.001} max={info.animations[view?.animation?.index ?? 0].duration} value={view?.animation?.time ?? 0} onChange={event => animate(view!.animation!.index, Number(event.target.value), false)} />
              <output className="text-xs tabular-nums text-fg-2">{(view?.animation?.time ?? 0).toFixed(3)} s</output>
            </div>
          )}
          <details className="shrink-0 border-t border-border/40 px-3 py-1.5 text-xs text-fg-3">
            <summary className="cursor-pointer select-none font-medium text-fg-2 hover:text-fg">{t("Model information · conventional axes, orientation is not auto-detected")}</summary>
            <div className="mt-1 space-y-0.5">
              <p>{fileInfo}</p>
              <p>{t("Scenes: {{v0}} · Meshes: {{v1}} · Triangles: {{v2}} ({{v3}} node instances)", { v0: info.scenes, v1: info.meshes, v2: info.triangles.toLocaleString(getAppLocale()), v3: info.instances })}</p>
              <p>{t("glTF conventional units; bounds {{v0}}", { v0: info.bounds.map(value => value.toPrecision(4)).join(" × ") })}</p>
              <p>{t("Decoded geometry budget: {{v0}} B · Textures: {{v1}} pixels · neutral-r182-v1", { v0: info.decodedBytes.toLocaleString(getAppLocale()), v1: info.texturePixels.toLocaleString(getAppLocale()) })}</p>
              {info.warnings.map(warning => <p key={warning}><LocalizedMessage>{warning}</LocalizedMessage></p>)}
              <p>{t("Left-drag to orbit · Right-drag to pan · Scroll to zoom")}</p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
