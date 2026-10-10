import { LayoutGrid, List, Search, X } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import "./asset-browser.css";

export type AssetView = "grid" | "list";

export function AssetViewToggle({ value, onChange }: {
  value: AssetView;
  onChange: (value: AssetView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="asset-view-toggle" role="group" aria-label={t("assetBrowser.view")}>
      {(["grid", "list"] as const).map((view) => {
        const Icon = view === "grid" ? LayoutGrid : List;
        return (
          <button key={view} type="button" aria-label={t(`assetBrowser.${view}`)}
            title={t(`assetBrowser.${view}`)} aria-pressed={value === view}
            onClick={() => onChange(view)}><Icon size={14} aria-hidden /></button>
        );
      })}
    </div>
  );
}

export function AssetSearch({ value, onChange, label }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="asset-search">
      <Search size={14} aria-hidden />
      <input aria-label={label} placeholder={label} value={value}
        onChange={(event) => onChange(event.target.value)} />
      {value && <button type="button" aria-label={t("assetBrowser.clearSearch")}
        onClick={() => onChange("")}><X size={13} aria-hidden /></button>}
    </div>
  );
}
