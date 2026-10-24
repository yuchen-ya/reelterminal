import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../../stores/project-store";

/** The old project content remains inspectable, with no second writer. */
export function MigratedWorkbenchBackup({ onOpenNode }: { onOpenNode: (nodeId: string) => void }) {
  const { t } = useTranslation();
  const project = useProjectStore(state => state.project);
  const [page, setPage] = useState(0);
  const [itemId, setItemId] = useState<string | null>(null);
  const items = project.workbench?.items ?? [];
  const selected = items.find(item => item.id === itemId) ?? items[0];
  return <section className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4" data-testid="review-migrated-backup">
    <p role="status" className="text-sm">{t("review.migration.readonly")}</p>
    <button type="button" className="self-start rounded border border-border px-3 py-2 text-sm" onClick={() => onOpenNode(project.reviewMigration!.nodeId)}>{t("review.migration.openNode")}</button>
    <p className="text-xs text-fg-3">{t("review.migration.oldVersion")}</p>
    <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-2"><ul className="max-h-80 overflow-auto text-xs">{items.slice(page * 100, (page + 1) * 100).map(item => <li key={item.id}><button className="w-full rounded border border-border p-2 text-left" onClick={() => setItemId(item.id)}>{item.title} · {item.type} · v{item.version}</button></li>)}</ul>
        <div className="flex gap-2"><button disabled={!page} onClick={() => setPage(value => value - 1)}>{t("review.previous")}</button><span>{page + 1}</span><button disabled={(page + 1) * 100 >= items.length} onClick={() => setPage(value => value + 1)}>{t("review.next")}</button></div></div>
      {selected && <div className="min-w-0 space-y-2"><h2 className="font-medium">{selected.title} · v{selected.version}</h2><p className="text-xs text-fg-3">{selected.status} · {selected.batchId}</p>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-3 text-xs">{selected.content.type === "text" ? selected.content.versions.at(-1)?.text : JSON.stringify(selected.content.type === "data" ? { ...selected.content, rows: selected.content.rows.slice(0, 100) } : selected.content, null, 2)}</pre>
        {selected.content.type === "data" && selected.content.rows.length > 100 && <p className="text-xs text-fg-3">{t("review.process.tablePreview")}</p>}
      </div>}
    </div>
  </section>;
}
