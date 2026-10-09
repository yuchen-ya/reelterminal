import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { StoreApi } from "zustand";
import type { ProjectState } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { InspectorPanel } from "../../components/editor/InspectorPanel";
import { workspaceManager } from "../../services/workspace-manager";
import { toast } from "../../stores/notification-store";
import { VersionNodeTrack } from "./VersionNodeTrack";
import { RequirementBoardDialog } from "./RequirementBoardDialog";

/** Keep each project's panel forms mounted for this editor session. */
export function DesktopInspector() {
  const {
    t
  } = useTranslation();
  const snapshot = useSyncExternalStore(workspaceManager.subscribe, workspaceManager.getSnapshot);
  const tab = useUIStore(state => state.desktopInspectorTab);
  const [contexts, setContexts] = useState<Record<string, {
    workspaceId: string;
    store: StoreApi<ProjectState>;
  }>>({});
  const projectId = snapshot.activeProjectId;
  const workspaceId = snapshot.activeWorkspaceId;
  useEffect(() => {
    if (!projectId || !workspaceId) return;
    let active = true;
    void workspaceManager.getWorkspaceContext({
      projectId,
      workspaceId
    }).then(context => {
      if (active) setContexts(current => ({
        ...current,
        [projectId]: {
          workspaceId,
          store: context.store
        }
      }));
    }).catch((error: unknown) => toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, [projectId, workspaceId, t]);
  return <div className="flex h-full min-h-0 flex-col" data-testid="desktop-inspector">
    <div className="flex h-9 shrink-0 items-stretch border-b border-border px-2" role="tablist" aria-label={t("desktop.editor.inspector")}>
      {(["properties", "archives", "board"] as const).map(item => <button key={item} type="button" role="tab" data-testid={`inspector-tab-${item}`} aria-selected={tab === item} aria-controls={`inspector-panel-${item}`} onClick={() => useUIStore.getState().setDesktopInspectorTab(item)} className={`relative flex-1 rounded-sm px-2 text-xs transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent motion-reduce:transition-none ${tab === item ? "text-fg after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-accent" : "text-fg-3"}`}>
        {t(`desktopInspector.${item}`)}
      </button>)}
    </div>
    <div role="tabpanel" id="inspector-panel-properties" hidden={tab !== "properties"} className="min-h-0 flex-1 overflow-hidden"><InspectorPanel /></div>
    {Object.entries(contexts).map(([id, context]) => <div key={id} hidden={id !== projectId || context.workspaceId !== workspaceId || tab === "properties"} className="min-h-0 flex-1 overflow-hidden">
      <div role="tabpanel" id={id === projectId ? "inspector-panel-archives" : undefined} hidden={tab !== "archives"} className="h-full min-h-0">
        <VersionNodeTrack projectId={id} workspaceId={context.workspaceId} active={id === projectId && tab === "archives"} />
      </div>
      <div role="tabpanel" id={id === projectId ? "inspector-panel-board" : undefined} hidden={tab !== "board"} className="h-full min-h-0">
        <RequirementBoardDialog store={context.store} active={id === projectId && context.workspaceId === workspaceId && tab === "board"} />
      </div>
    </div>)}
  </div>;
}
