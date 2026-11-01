import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import type { ModelObservation } from "@reelterminal/core/types/workbench";
import type { ModelPreviewRuntime } from "../model-preview/runtime";
import { ModelPreview } from "./ModelPreview";

export function ModelComparison({ left, right }: { left: string; right: string }) {
  const { t } = useTranslation();
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
      <select aria-label={t("Model camera linking")} className="rounded border border-border bg-bg-2 p-1" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="independent">{t("Fit each view")}</option><option value="direction">{t("Link direction (independent scales)")}</option><option value="coordinates" disabled={!confirmed}>{t("Same-coordinate cameras")}</option></select>
      <label><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); if (!event.target.checked && mode === "coordinates") setMode("independent"); }} />{t("I confirm both versions share coordinates")}</label>
      <span>{t("No automatic registration. Animations remain independent; matching names do not imply a mapping.")}</span>
    </div>
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">{[left, right].map((resourceId, index) => <div key={`${index}:${resourceId}`} className="h-[460px] min-w-0 rounded border border-border"><ModelPreview resourceId={resourceId} onRuntime={value => { runtimes.current[index] = value; }} onObservation={view => change(index, view)} /></div>)}</div>
  </div>;
}
