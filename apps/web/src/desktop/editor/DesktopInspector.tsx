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
    <div data-testid="inspector-properties" hidden={tab !== "properties"} className="min-h-0 flex-1 overflow-hidden"><InspectorPanel /></div>
    {Object.entries(contexts).map(([id, context]) => <div key={id} hidden={id !== projectId || context.workspaceId !== workspaceId || tab === "properties"} className="min-h-0 flex-1 overflow-hidden">
      <div hidden={tab !== "archives"} className="h-full min-h-0">
        <VersionNodeTrack projectId={id} workspaceId={context.workspaceId} active={id === projectId && tab === "archives"} onClose={() => useUIStore.getState().setDesktopInspectorTab("properties")} />
      </div>
      <div hidden={tab !== "board"} className="h-full min-h-0">
        <RequirementBoardDialog store={context.store} active={id === projectId && context.workspaceId === workspaceId && tab === "board"} onClose={() => useUIStore.getState().setDesktopInspectorTab("properties")} />
      </div>
    </div>)}
  </div>;
}
