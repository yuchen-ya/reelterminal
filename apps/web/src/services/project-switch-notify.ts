import { workspaceManager, type WorkspaceTarget } from "./workspace-manager";
import { toast, useNotificationStore } from "../stores/notification-store";
import i18n from "../i18n";

/**
 * User-initiated cross-project switch with the follow-up "copy Agent prompt"
 * notification (docs/VERSION-NODES-UX.md 左上角项目切换与 Agent 提示).
 *
 * Only a successful switch to a *different* project notifies; same-project
 * workspace switches, preview enter/exit and background task completion never
 * route through here. The notification never auto-copies and consecutive
 * switches replace the previous notification instead of stacking.
 */

/** Copy an installation-generated startup command for this exact workspace. */
export async function copyProjectAgentPrompt(target: WorkspaceTarget): Promise<void> {
  const control = window.reelterminal?.collabControl;
  if (!control) throw new Error("Desktop startup information is unavailable");
  const info = await control.getStartupInfo({ kind: "video", ...target });
  if (!info.startCommand) throw new Error("The target startup command is unavailable");
  await navigator.clipboard.writeText(i18n.t("desktop.collaboration.startupPrompt", info));
}

/** Project-menu entry: copy the prompt for the currently active edit target. */
export async function copyCurrentProjectAgentPrompt(): Promise<void> {
  const snapshot = workspaceManager.getSnapshot();
  if (!snapshot.activeProjectId || !snapshot.activeWorkspaceId) {
    throw new Error("No active project workspace");
  }
  await copyProjectAgentPrompt({
    projectId: snapshot.activeProjectId,
    workspaceId: snapshot.activeWorkspaceId,
  });
}

let lastSwitchNotificationId: string | null = null;

/**
 * Switch the active view and, when the user actively moved to a different
 * project, show the one replaceable "copy Agent prompt" notification.
 * Switch errors propagate before any notification is shown.
 */
export async function switchProjectView(target: WorkspaceTarget): Promise<void> {
  const previousProjectId = workspaceManager.getSnapshot().activeProjectId;
  await workspaceManager.switchView(target);
  if (!previousProjectId || previousProjectId === target.projectId) return;
  notifyProjectSwitched(target);
}

function notifyProjectSwitched(target: WorkspaceTarget): void {
  const store = useNotificationStore.getState();
  if (lastSwitchNotificationId) store.removeNotification(lastSwitchNotificationId);
  const projectName =
    workspaceManager.getSnapshot().projects.find((entry) => entry.id === target.projectId)?.name ??
    target.projectId;
  const id = store.addNotification({
    type: "info",
    title: i18n.t("projectSwitch.toast", { name: projectName }),
    duration: 8000,
    onClickLabel: i18n.t("projectSwitch.copyPrompt"),
    onClick: () => {
      void (async () => {
        try {
          await copyProjectAgentPrompt(target);
          useNotificationStore.getState().removeNotification(id);
          toast.success(i18n.t("projectSwitch.copied"));
        } catch (error) {
          toast.error(
            i18n.t("desktop.start.actionFailed"),
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    },
  });
  lastSwitchNotificationId = id;
}
