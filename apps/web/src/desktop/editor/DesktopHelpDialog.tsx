import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@reelterminal/ui";
import { BookOpen, Play, Search, X } from "@/icons/lucide-compat";
import { GUI_MANUAL_SCREENS, searchManualScreens, resolveManualShortcuts } from "../../gui-manual";
import { startTour } from "../../components/editor/tour";

export function DesktopHelpDialog({
  open,
  onOpenChange,
  canTour,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canTour: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language.startsWith("zh") ? "zh" : "en";
  const [query, setQuery] = useState("");
  const [screenId, setScreenId] = useState("quick-start");
  const hits = searchManualScreens(query).hits;
  const screen = GUI_MANUAL_SCREENS.find((item) => item.id === screenId)!;
  const shortcuts = resolveManualShortcuts(screen.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="reelterminal-desktop flex h-[min(680px,85vh)] max-w-4xl flex-col gap-0 overflow-hidden border-border bg-bg-1 p-0 text-fg">
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <BookOpen size={20} className="text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base">{t("desktop.help.title")}</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-fg-muted">{t("desktop.help.description")}</DialogDescription>
          </div>
          <button type="button" onClick={() => onOpenChange(false)} aria-label={t("common.close")} className="rounded-md p-2 hover:bg-hover"><X size={16} /></button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t("desktop.help.topics")} className="flex w-56 shrink-0 flex-col border-r border-border bg-bg p-3">
            <label className="mb-3 flex items-center gap-2 rounded-md border border-border bg-bg-2 px-2">
              <Search size={14} className="shrink-0 text-fg-muted" aria-hidden />
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("desktop.help.search")} placeholder={t("desktop.help.search")} className="h-8 min-w-0 w-full bg-transparent text-xs outline-none" />
            </label>
            <div className="min-h-0 space-y-1 overflow-y-auto">
              {hits.map((item) => (
                <button key={item.id} type="button" aria-current={screen.id === item.id ? "page" : undefined} onClick={() => setScreenId(item.id)} className={`w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${screen.id === item.id ? "bg-accent-soft font-medium text-accent" : "text-fg-2 hover:bg-hover hover:text-fg"}`}>
                  {item.title[language]}
                </button>
              ))}
              {hits.length === 0 && <p className="px-2 py-3 text-xs text-fg-muted">{t("desktop.help.noResults")}</p>}
            </div>
          </nav>
          <article className="min-w-0 flex-1 space-y-5 overflow-y-auto p-6 text-sm leading-relaxed">
            <div>
              <h2 className="text-xl font-semibold">{screen.title[language]}</h2>
              <p className="mt-2 text-fg-2">{screen.summary[language]}</p>
            </div>
            {screen.id === "quick-start" && (
              <div>
                <button type="button" disabled={!canTour} onClick={() => { onOpenChange(false); startTour(); }} className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                  <Play size={14} aria-hidden />{t("desktop.help.startTour")}
                </button>
                {!canTour && <p className="mt-2 text-xs text-fg-muted">{t("desktop.help.tourNeedsProject")}</p>}
              </div>
            )}
            <section>
              <h3 className="mb-2 font-medium">{t("desktop.help.entry")}</h3>
              {screen.entry.map((item, index) => <p key={index} className="mb-2 text-fg-2">{item[language]}</p>)}
              {screen.visibility && <p className="text-xs text-fg-muted">{screen.visibility[language]}</p>}
            </section>
            {screen.steps && (
              <section>
                <h3 className="mb-3 font-medium">{t("desktop.help.steps")}</h3>
                <ol className="list-decimal space-y-3 pl-5 text-fg-2">
                  {screen.steps.map((item, index) => <li key={index} className="pl-1">{item[language]}</li>)}
                </ol>
              </section>
            )}
            {shortcuts.length > 0 && (
              <section>
                <h3 className="mb-2 font-medium">{t("desktop.help.shortcuts")}</h3>
                <div className="space-y-2">
                  {shortcuts.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 rounded-md bg-bg-2 px-3 py-2 text-xs"><span>{t(item.name)}</span><kbd className="shrink-0 rounded border border-border px-2 py-0.5 font-mono">{item.key}</kbd></div>)}
                </div>
              </section>
            )}
            {screen.limitations && (
              <section className="rounded-lg border border-border bg-bg-2 p-3">
                <h3 className="mb-2 text-xs font-medium">{t("desktop.help.notes")}</h3>
                {screen.limitations.map((item, index) => <p key={index} className="mb-2 text-xs text-fg-muted last:mb-0">{item[language]}</p>)}
              </section>
            )}
          </article>
        </div>
      </DialogContent>
    </Dialog>
  );
}
