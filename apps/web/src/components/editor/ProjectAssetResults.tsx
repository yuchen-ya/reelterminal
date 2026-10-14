import { useTranslation } from "react-i18next";
import { PROJECT_ASSET_SORTS, type ProjectAssetSort } from "./project-asset-filters";

export function ProjectAssetResults({ count, sort, onSort }: { count: number; sort: ProjectAssetSort; onSort: (sort: ProjectAssetSort) => void }) {
  const { t } = useTranslation();
  return <div className="project-asset-results">
    <span role="status">{t("projectMediaFilters.matches", { count })}</span>
    <select aria-label={t("Sort media")} value={sort} onChange={event => onSort(event.target.value as ProjectAssetSort)}>
      {PROJECT_ASSET_SORTS.map(value => <option key={value} value={value}>{t(`projectMediaFilters.sort.${value}`)}</option>)}
    </select>
  </div>;
}
