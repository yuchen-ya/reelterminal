import { useEffect, useRef, useState } from "react";

export function CollectionImage({ src, title, mode }: { src: string; title: string; mode: "fit" | "actual" | "pixel" }) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ src: string; width: number; height: number }>();
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const dimensions = natural?.src === src ? natural : undefined;
  const scale = dimensions && size.width ? Math.max(1, Math.floor(Math.min(size.width / dimensions.width, size.height / dimensions.height))) : 1;
  const nativeSize = mode !== "fit" && dimensions;
  return <div className="w-full min-w-0">
    <div ref={container} className="flex h-60 w-full overflow-auto rounded bg-bg-2">
      <img src={src} alt={title} draggable={false}
        onLoad={event => setNatural({ src, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        className="m-auto min-h-0 shrink-0 object-contain"
        style={{ width: nativeSize ? dimensions.width * (mode === "pixel" ? scale : 1) : "100%",
          height: nativeSize ? dimensions.height * (mode === "pixel" ? scale : 1) : "100%",
          maxWidth: nativeSize ? "none" : "100%", imageRendering: mode === "pixel" ? "pixelated" : "auto" }} />
    </div>
    {dimensions && <p className="mt-1 text-center font-mono text-[10px] text-fg-3">{dimensions.width} × {dimensions.height}{mode === "pixel" ? ` · ${scale}×` : ""}</p>}
  </div>;
}
