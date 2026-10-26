import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EXTERNAL_RESOURCES, RESOURCE_CATEGORIES, type ResourceCategory } from "../../../data/external-resources";
import { AssetSearch } from "../asset-browser-controls";

export function ExternalResourcesTab() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ResourceCategory>("all");
  const language = i18n.language.startsWith("zh") ? "zh" : "en";
  const search = query.trim().toLocaleLowerCase();
  const resources = EXTERNAL_RESOURCES.filter((resource) =>
    (category === "all" || resource.categories.includes(category)) &&
    [resource.name, resource.description.en, resource.description.zh, ...resource.tags,
      ...resource.categories.map((value) => t(`externalResources.categories.${value}`))]
      .join(" ").toLocaleLowerCase().includes(search),
  );

  return <section className="h-full overflow-y-auto space-y-4 p-4">
    <p className="text-xs leading-5 text-text-muted">{t("externalResources.notice")}</p>
    <AssetSearch value={query} onChange={setQuery} label={t("externalResources.search")} />
    <div className="flex flex-wrap gap-2" aria-label={t("externalResources.filter")}>
      {RESOURCE_CATEGORIES.map((value) => <button key={value} type="button" aria-pressed={category === value}
        onClick={() => setCategory(value)} className={`rounded-full border px-3 py-1 text-xs ${category === value ? "border-primary text-primary bg-primary/10" : "border-border text-text-muted"}`}>
        {t(`externalResources.categories.${value}`)}
      </button>)}
    </div>
    <div className="space-y-3">
      {resources.map((resource) => <article key={resource.id} className="rounded-lg border border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-text-primary">{resource.name}</h3>
          <span className="text-[10px] shrink-0 text-text-muted">{t("externalResources.external")}</span>
        </div>
        <p className="text-xs leading-5 text-text-muted">{resource.description[language]}</p>
        <div className="flex flex-wrap gap-2 text-[10px] text-text-muted">
          {resource.categories.map((value) => <span key={value}>{t(`externalResources.categories.${value}`)}</span>)}
          {resource.tags.filter((tag) => !["字幕", "字体", "subtitles"].includes(tag)).map((tag) => <span key={tag} className="rounded bg-background-tertiary px-1.5">{tag}</span>)}
        </div>
        <a href={resource.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-xs text-primary">
          {t("externalResources.visit")} <ExternalLink size={12} aria-hidden />
          <span className="truncate text-text-muted">{new URL(resource.url).hostname}</span>
        </a>
      </article>)}
      {resources.length === 0 && <p className="py-8 text-center text-xs text-text-muted">{t("externalResources.empty")}</p>}
    </div>
  </section>;
}
