import { useEffect, useRef } from "react";
import type { FileResource } from "@reelterminal/core/review/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import type { ModelPreviewRuntime } from "../model-preview/runtime";
import { ModelPreview } from "../components/ModelPreview";
import { boardBinding } from "../../../services/human-board/export";
import { boardResourceUrl } from "../../../services/human-board/media";
import type { MediaCapture } from "../../../services/human-board/render";

export function BoardMedia({ element, resource, register, onCapture, onObservation, onError }: {
  element: ExcalidrawElement; resource: FileResource;
  register: (id: string, capture: MediaCapture | null) => void;
  onCapture: (blob: Blob, name: string) => void;
  onObservation: (id: string, observation: ModelObservation) => void;
  onError: (error: unknown) => void;
}) {
  const binding = boardBinding(element)!;
  const video = useRef<HTMLVideoElement>(null);
  const seek = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<ModelPreviewRuntime | null>(null);
  const restore = useRef(element.customData?.observation as ModelObservation | undefined);
  useEffect(() => {
    const capture = async () => {
      let blob: Blob;
      let viewport: HTMLElement;
      if (binding.kind === "model3d") {
        if (!runtime.current) throw new Error("3D 模型尚未就绪");
        viewport = host.current!.querySelector<HTMLCanvasElement>("[data-testid=model-canvas-host] canvas")!;
        blob = (await runtime.current.capture({ width: 1920, height: Math.max(1, Math.round(1920 * viewport.clientHeight / viewport.clientWidth)) })).blob;
      } else {
        const player = video.current!; player.pause(); viewport = player;
        if (player.readyState < 2 || !player.videoWidth) throw new Error("视频帧尚未就绪");
        const canvas = document.createElement("canvas"); canvas.width = player.videoWidth; canvas.height = player.videoHeight;
        canvas.getContext("2d")!.drawImage(player, 0, 0);
        blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("截帧失败")), "image/png"));
      }
      const bitmap = await createImageBitmap(blob);
      try {
        // offset coordinates are local and remain correct under scene rotation/zoom.
        let x = 0, y = 0, node: HTMLElement | null = viewport;
        while (node && node !== host.current) { x += node.offsetLeft; y += node.offsetTop; node = node.offsetParent as HTMLElement | null; }
        const scale = Math.max(bitmap.width / viewport.clientWidth, bitmap.height / viewport.clientHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(host.current!.clientWidth * scale)); canvas.height = Math.max(1, Math.ceil(host.current!.clientHeight * scale));
        const context = canvas.getContext("2d")!;
        const fit = Math.min(viewport.clientWidth / bitmap.width, viewport.clientHeight / bitmap.height);
        context.fillStyle = "#000000"; context.fillRect(x * scale, y * scale, viewport.clientWidth * scale, viewport.clientHeight * scale);
        context.drawImage(bitmap, (x + (viewport.clientWidth - bitmap.width * fit) / 2) * scale, (y + (viewport.clientHeight - bitmap.height * fit) / 2) * scale, bitmap.width * fit * scale, bitmap.height * fit * scale);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("媒体场景冻结失败")), "image/png"));
      } finally { bitmap.close(); }
    };
    register(element.id, capture);
    return () => register(element.id, null);
  }, [element.id, element.width, element.height, binding.kind, register]);

  return <div ref={host} className="relative flex h-full w-full flex-col overflow-hidden rounded border border-border bg-bg text-fg" data-testid="human-board-media" data-media-kind={binding.kind}>
    <div className="flex h-7 shrink-0 items-center justify-between px-2 text-[11px]">
      <span className="truncate">{binding.name}</span>
      {binding.kind === "video" && <><input ref={seek} className="mx-1 w-20 rounded bg-bg-2 px-1" type="number" min={0} step={0.001} defaultValue={0} aria-label="视频定位秒" onChange={event => {
        const time = Number(event.target.value);
        if (video.current && Number.isFinite(time) && time >= 0 && time <= video.current.duration) { video.current.pause(); video.current.currentTime = time; }
      }} /><button data-testid="human-board-video-capture" className="shrink-0 text-accent" onClick={() => {
        video.current!.pause();
        const canvas = document.createElement("canvas"); canvas.width = video.current!.videoWidth; canvas.height = video.current!.videoHeight;
        if (!canvas.width) { onError(new Error("视频帧尚未就绪")); return; }
        canvas.getContext("2d")!.drawImage(video.current!, 0, 0);
        canvas.toBlob(blob => { if (blob) onCapture(blob, `${binding.name}-${video.current!.currentTime.toFixed(3)}s.png`); else onError(new Error("截帧失败")); }, "image/png");
      }}>截取当前帧</button></>}
    </div>
    {binding.kind === "video" ? <video ref={video} controls preload="auto" src={boardResourceUrl(binding.resourceId)} className="min-h-0 w-full flex-1 bg-black object-contain" onTimeUpdate={() => { if (seek.current && document.activeElement !== seek.current) seek.current.value = video.current!.currentTime.toFixed(3); }} onError={() => onError(new Error(`无法播放：${binding.name}`))} />
      : <div className="min-h-0 flex-1 overflow-auto"><ModelPreview resourceId={binding.resourceId} resource={resource} restore={restore.current} captureLabel="截取当前视角"
        onRuntime={value => { runtime.current = value; }} onObservation={observation => onObservation(element.id, observation)}
        onCapture={() => {
          const viewport = host.current!.querySelector<HTMLCanvasElement>("[data-testid=model-canvas-host] canvas")!;
          void runtime.current!.capture({ width: 1920, height: Math.max(1, Math.round(1920 * viewport.clientHeight / viewport.clientWidth)) })
            .then(capture => onCapture(capture.blob, `${binding.name}-视角.png`)).catch(onError);
        }} /></div>}
  </div>;
}
