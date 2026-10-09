import React, { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Plus,
  FolderOpen,
  Clock,
  FileVideo,
  Save,
  History,
  Copy,
  FlaskConical,
  Layers,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftCard as Card } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { workspaceManager, type WorkspaceTarget } from "../../services/workspace-manager";
import { copyCurrentProjectAgentPrompt } from "../../services/project-switch-notify";
import { RecoveryDraftsDialog } from "../../desktop/editor/RecoveryDraftsDialog";
import {
  listRecentProjects,
  openProject,
  openRecentProject,
  type RecentEntry,
} from "../../desktop/start/desktop-project-actions";
import { useAnchoredBelowStyle } from "../../utils/anchored-position";
import { useTranslation } from "react-i18next";
import { toast } from "../../stores/notification-store";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const ProjectSwitcher: React.FC<{ onNewProject?: () => void }> = ({ onNewProject }) => {

  const { t } = useTranslation();
  const { project, createNewProject } = useProjectStore();
  const [isOpen, setIsOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The dropdown portals to document.body so it can escape the header's
  // stacking context and sit above the editor panes.
  const dropdownStyle = useAnchoredBelowStyle(triggerRef, isOpen, 8);

  // Version-aware project actions (docs/VERSION-NODES-UX.md 左上角项目切换).
  const workspaceSnapshot = useSyncExternalStore(workspaceManager.subscribe, workspaceManager.getSnapshot);
  const activeProjectId = workspaceSnapshot.activeProjectId;
  const activeWorkspaceId = workspaceSnapshot.activeWorkspaceId;
  const projectWorkspaces = useMemo(
    () => workspaceSnapshot.workspaces.filter((entry) => entry.projectId === activeProjectId),
    [workspaceSnapshot.workspaces, activeProjectId],
  );
  const activeTarget: WorkspaceTarget | null =
    activeProjectId && activeWorkspaceId ? { projectId: activeProjectId, workspaceId: activeWorkspaceId } : null;
  const [versioningBusy, setVersioningBusy] = useState(false);
  const [showRecoveryDrafts, setShowRecoveryDrafts] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    listRecentProjects()
      .then((entries) => {
        if (active) setRecentProjects(entries.filter((entry) => entry.id !== project.id));
      })
      .catch((error) => {
        console.warn("[ProjectSwitcher] Failed to load recent projects:", error);
        if (active) setRecentProjects([]);
      });
    return () => {
      active = false;
    };
  }, [isOpen, project.id]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const closeAfter = useCallback((operation: () => void) => {
    operation();
    setIsOpen(false);
  }, []);

  const handleOpenProject = useCallback(async () => {
    setIsLoading(true);
    try {
      if (await openProject()) {
        useUIStore.getState().setDesktopPage("edit");
        setIsOpen(false);
      }
    } catch (error) {
      toast.error(t("desktop.start.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const handleOpenRecent = useCallback(async (id: string) => {
    setIsLoading(true);
    try {
      if (await openRecentProject(id)) {
        useUIStore.getState().setDesktopPage("edit");
        setIsOpen(false);
      }
    } catch (error) {
      toast.error(t("desktop.start.actionFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  const reportVersioningError = useCallback((error: unknown) => {
    toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
  }, [t]);

  /** 留存当前版本: auto-named; identical content replays and still toasts. */
  const handleRetainVersion = useCallback(async () => {
    if (!activeTarget || versioningBusy) return;
    setVersioningBusy(true);
    try {
      const { node } = await workspaceManager.saveNode({ target: activeTarget });
      toast.success(t("versioning.retainSuccess", { name: node.name }));
      setIsOpen(false);
    } catch (error) {
      reportVersioningError(error);
    } finally {
      setVersioningBusy(false);
    }
  }, [activeTarget, versioningBusy, t, reportVersioningError]);

  const handleOpenRecoveryDrafts = useCallback(() => {
    if (!activeTarget) return;
    setIsOpen(false);
    setShowRecoveryDrafts(true);
  }, [activeTarget]);

  const handleCopyAgentPrompt = useCallback(async () => {
    try {
      await copyCurrentProjectAgentPrompt();
      toast.success(t("projectSwitch.copied"));
      setIsOpen(false);
    } catch (error) {
      reportVersioningError(error);
    }
  }, [t, reportVersioningError]);

  /** 试试另一种剪法: isolated trial plan seeded from the current edit. */
  const handleTryAnotherCut = useCallback(async () => {
    if (!activeTarget || versioningBusy) return;
    setVersioningBusy(true);
    try {
      const workspace = await workspaceManager.createWorkspace(activeTarget.projectId, {
        sourceWorkspaceId: activeTarget.workspaceId,
      });
      await workspaceManager.switchView({ projectId: activeTarget.projectId, workspaceId: workspace.id });
      setIsOpen(false);
    } catch (error) {
      reportVersioningError(error);
    } finally {
      setVersioningBusy(false);
    }
  }, [activeTarget, versioningBusy, reportVersioningError]);

  /** 方案切换: same project, so no project-switch notification. */
  const handleSwitchPlan = useCallback(async (workspaceId: string) => {
    if (!activeProjectId || versioningBusy) return;
    setVersioningBusy(true);
    try {
      await workspaceManager.switchView({ projectId: activeProjectId, workspaceId });
      setIsOpen(false);
    } catch (error) {
      reportVersioningError(error);
    } finally {
      setVersioningBusy(false);
    }
  }, [activeProjectId, versioningBusy, reportVersioningError]);

  return (
    <div className="relative min-w-0" ref={triggerRef}>
      <Button
        // Project names are user data, not catalog keys.
        label={project.name}
        onClick={() => setIsOpen((open) => !open)}
        variant="ghost"
        size="md"
        icon={<FileVideo className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
        endContent={
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform duration-200 ${
              isOpen ? "rotate-180" : ""
            }`}
            aria-hidden
          />
        }
        className="max-w-[200px] justify-start truncate hover:bg-background-secondary"
      />

      {isOpen &&
        createPortal(
          <Card
            ref={dropdownRef}
            variant="default"
            padding={0}
            style={dropdownStyle}
            className="z-[var(--z-popover)] w-72 overflow-hidden border border-border bg-background shadow-2xl animate-in fade-in slide-in-from-top-2 duration-150"
          >
            <div className="p-2">
              <ClickableCard
                label={t("New Project")}
                onClick={() => closeAfter(onNewProject ?? createNewProject)}
                isDisabled={isLoading}
                padding={3}
                variant="transparent"
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-primary/10 p-1.5 text-primary group-hover:bg-primary/20">
                  <Plus className="h-4 w-4" aria-hidden />
                </span>
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("New Project")}
                </Text>
              </ClickableCard>
              <ClickableCard
                label={t("common.openProjectPicker")}
                onClick={handleOpenProject}
                isDisabled={isLoading}
                padding={3}
                variant="transparent"
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                  <FolderOpen className="h-4 w-4" aria-hidden />
                </span>
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("common.openProjectPicker")}
                </Text>
              </ClickableCard>
            </div>

            <div className="border-t border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <Clock className="h-3 w-3" aria-hidden />
                <Text
                  type="supporting"
                  color="secondary"
                  className="text-xs font-medium uppercase tracking-wider"
                >
                  {t("Recent Projects")}
                </Text>
              </div>
            </div>
            {recentProjects.length > 0 ? (
              <div className="max-h-64 overflow-y-auto px-2 pb-2">
                {recentProjects.map((recent) => (
                  <ClickableCard
                    key={recent.id}
                    label={t("desktop.start.openProject", { name: recent.name })}
                    onClick={() => handleOpenRecent(recent.id)}
                    isDisabled={isLoading}
                    padding={3}
                    variant="transparent"
                    className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
                  >
                    <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                      <FileVideo className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <Text
                        type="supporting"
                        color="primary"
                        className="truncate text-sm font-medium group-hover:text-primary"
                      >
                        {recent.name}
                      </Text>
                      <Text type="supporting" color="secondary" className="text-xs">
                        {formatTimeAgo(recent.lastOpened)}
                      </Text>
                    </span>
                  </ClickableCard>
                ))}
              </div>
            ) : (
              <Text type="supporting" color="secondary" className="block px-4 pb-4 text-xs">
                {t("No Recent Projects")}
              </Text>
            )}

            <div className="border-t border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <Save className="h-3 w-3" aria-hidden />
                <Text
                  type="supporting"
                  color="secondary"
                  className="text-xs font-medium uppercase tracking-wider"
                >
                  {t("projectSwitch.actionsSection")}
                </Text>
              </div>
            </div>
            <div className="px-2 pb-2">
              <ClickableCard
                label={t("versioning.retain")}
                onClick={handleRetainVersion}
                isDisabled={!activeTarget || versioningBusy}
                padding={3}
                variant="transparent"
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                  <Save className="h-4 w-4" aria-hidden />
                </span>
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("versioning.retain")}
                </Text>
              </ClickableCard>
              <ClickableCard
                label={t("versioning.recoveryMenu")}
                onClick={handleOpenRecoveryDrafts}
                isDisabled={!activeTarget || versioningBusy}
                padding={3}
                variant="transparent"
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                  <History className="h-4 w-4" aria-hidden />
                </span>
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("versioning.recoveryMenu")}
                </Text>
              </ClickableCard>
              <ClickableCard
                label={t("versioning.copyAgentPrompt")}
                onClick={handleCopyAgentPrompt}
                isDisabled={!activeTarget}
                padding={3}
                variant="transparent"
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                  <Copy className="h-4 w-4" aria-hidden />
                </span>
                <Text type="supporting" color="primary" className="text-sm font-medium">
                  {t("versioning.copyAgentPrompt")}
                </Text>
              </ClickableCard>
            </div>

            <div className="border-t border-border px-3 py-2" title={t("versioning.trialMenuHint")}>
              <div className="flex items-center gap-2">
                <FlaskConical className="h-3 w-3" aria-hidden />
                <Text
                  type="supporting"
                  color="secondary"
                  className="text-xs font-medium uppercase tracking-wider"
                >
                  {t("versioning.trialMenu")}
                </Text>
              </div>
            </div>
            <div className="px-2 pb-2">
              <ClickableCard
                label={t("versioning.trialMenu")}
                onClick={handleTryAnotherCut}
                isDisabled={!activeTarget || versioningBusy}
                padding={3}
                variant="transparent"
                title={t("versioning.trialMenuHint")}
                className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
              >
                <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                  <FlaskConical className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <Text type="supporting" color="primary" className="truncate text-sm font-medium">
                    {t("versioning.trialMenu")}
                  </Text>
                  <Text type="supporting" color="secondary" className="text-xs">
                    {t("versioning.trialMenuHint")}
                  </Text>
                </span>
              </ClickableCard>
            </div>

            {projectWorkspaces.length > 1 ? (
              <>
                <div className="border-t border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Layers className="h-3 w-3" aria-hidden />
                    <Text
                      type="supporting"
                      color="secondary"
                      className="text-xs font-medium uppercase tracking-wider"
                    >
                      {t("versioning.plansSection")}
                    </Text>
                  </div>
                </div>
                <div className="max-h-48 overflow-y-auto px-2 pb-2">
                  {projectWorkspaces.map((workspace) => (
                    <ClickableCard
                      key={workspace.id}
                      label={workspace.name}
                      active={workspace.id === activeWorkspaceId}
                      onClick={() => handleSwitchPlan(workspace.id)}
                      isDisabled={versioningBusy}
                      padding={3}
                      variant="transparent"
                      className="group flex w-full items-center gap-3 text-left hover:bg-background-secondary"
                    >
                      <span className="rounded-md bg-background-tertiary p-1.5 text-text-muted group-hover:text-text-secondary">
                        <Layers className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <Text
                          type="supporting"
                          color="primary"
                          className="truncate text-sm font-medium group-hover:text-primary"
                        >
                          {workspace.name}
                        </Text>
                        <Text type="supporting" color="secondary" className="text-xs">
                          {workspace.kind === "trial"
                            ? t("versioning.trialDefault")
                            : t("versioning.workspace")}
                        </Text>
                      </span>
                    </ClickableCard>
                  ))}
                </div>
              </>
            ) : null}
          </Card>,
          document.body,
        )}
      {showRecoveryDrafts && activeTarget ? (
        <RecoveryDraftsDialog target={activeTarget} onClose={() => setShowRecoveryDrafts(false)} />
      ) : null}
    </div>
  );
};
