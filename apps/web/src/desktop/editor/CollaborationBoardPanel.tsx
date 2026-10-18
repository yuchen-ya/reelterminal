import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStore, type StoreApi } from "zustand";
import { useTranslation } from "react-i18next";
import type { ProjectState } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { CaptionJobStatus } from "../../components/editor/inspector/LocalCaptionPanel";
import { RequirementBoardDialog } from "./RequirementBoardDialog";
import { CollaborationInstructionsPanel } from "./CollaborationInstructionsPanel";
import { previewSession } from "../../services/preview-session";

export function CollaborationBoardPanel({ store, active, onClose }: {
  store: StoreApi<ProjectState>; active: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const project = useStore(store, state => state.project);
  const openRequest = useUIStore(state => state.boardOpenRequest);
  const modalData = useUIStore(state => state.modalData);
  const lastRequest = useRef(-1);
  const [tab, setTab] = useState<"instructions" | "tasks">("instructions");
  const preview = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  useEffect(() => {
    if (!active || lastRequest.current === openRequest) return;
    if (modalData?.projectId && modalData.projectId !== project.id) return;
    lastRequest.current = openRequest;
    const taskRequested = modalData?.boardTab === "tasks" || Array.isArray(modalData?.referenceIds);
    const needsReview = project.requirements?.items.some(item => item.status === "review" || item.status === "blocked");
    setTab(taskRequested || needsReview ? "tasks" : "instructions");
  }, [active, openRequest, modalData, project.id, project.requirements]);
  return <section className="flex h-full min-h-0 flex-col text-fg" data-testid="collaboration-board">
    <header className="shrink-0 border-b border-border px-4 pt-4">

      <div className="flex items-center gap-5" role="tablist" aria-label={t("requirementBoard.title")}>
        {(["instructions", "tasks"] as const).map(value => <button key={value} role="tab" id={`board-${project.id}-${value}`} aria-selected={tab === value} aria-controls={`board-panel-${project.id}-${value}`} onClick={() => setTab(value)} className={`border-b-2 pb-3 text-xs ${tab === value ? "border-accent text-accent" : "border-transparent text-fg-2 hover:text-fg"}`}>{t(`collaborationInstructions.${value === "instructions" ? "title" : "tasks"}`)}</button>)}
        <button aria-label={t("desktopInspector.close")} onClick={onClose} className="ml-auto h-7 w-7 text-fg-3">×</button>
      </div>
    </header>
    {preview.active && tab === "instructions" && <p className="shrink-0 border-b border-border px-4 py-2 text-[11px] leading-relaxed text-fg-2">{t("requirementBoard.editingTargetHint")}</p>}
    <div role="tabpanel" id={`board-panel-${project.id}-instructions`} aria-labelledby={`board-${project.id}-instructions`} hidden={tab !== "instructions"} className="min-h-0 flex-1 overflow-hidden"><CollaborationInstructionsPanel key={project.id} store={store} /></div>
    <div role="tabpanel" id={`board-panel-${project.id}-tasks`} aria-labelledby={`board-${project.id}-tasks`} hidden={tab !== "tasks"} className="min-h-0 flex-1 overflow-hidden"><div className="px-4 pt-2"><CaptionJobStatus /></div><RequirementBoardDialog store={store} active={active && tab === "tasks"} /></div>
  </section>;
}
