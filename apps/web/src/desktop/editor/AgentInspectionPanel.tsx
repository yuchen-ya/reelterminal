import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTimelineStore } from "../../stores/timeline-store";
import { useCollabStore } from "../../stores/collab-store";
import { X } from "@/icons/lucide-compat";

/** Ephemeral evidence from the active agent session; never project content. */
export function AgentInspectionPanel() {
  const inspection = useCollabStore((state) => state.inspection);
  const dismiss = useCollabStore((state) => state.dismissInspection);
  const playing = useTimelineStore((state) => state.playbackState === "playing");
  useEffect(() => { if (playing) dismiss(); }, [playing, inspection, dismiss]);
  if (!inspection || playing) return null;
  // Portal to document.body: as an in-app absolute layer (z-40) it sat in the
  // desktop shell's single `isolate` stacking context and lost to the timeline
  // toolbar (z-50) and playhead. Portaled, it uses the --z-popover ladder and
  // is positioned against the viewport (the app shell does not scroll).
  return createPortal(
    <section aria-label="Agent source inspection" className="fixed right-4 top-16 z-[var(--z-popover)] flex max-h-[70vh] w-[min(720px,80vw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{inspection.title}</h2>
          <p className="text-xs text-muted-foreground">{inspection.kind === "cloud-opinion" ? "Cloud model opinion · not audiovisual acceptance" : "Static frame inspection · not audiovisual review"}{inspection.range ? ` · ${inspection.range}` : ""}</p>
        </div>
        <button type="button" onClick={dismiss} aria-label="Close source inspection" className="rounded p-1 hover:bg-muted"><X size={16} /></button>
      </header>
      <div className="overflow-auto p-3">
        {inspection.text && <p className="mb-3 whitespace-pre-wrap text-sm">{inspection.text}</p>}
        {inspection.images.map((image, index) => <img key={index} src={image} alt={`${inspection.title} — sample sheet ${index + 1}`} className="mb-2 h-auto w-full rounded" />)}
        {inspection.limitations.map((text) => <p key={text} className="mt-2 text-xs text-muted-foreground">{text}</p>)}
      </div>
    </section>,
    document.body,
  );
}
