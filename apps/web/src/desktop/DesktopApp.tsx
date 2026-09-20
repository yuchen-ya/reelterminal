import type { JSX } from "react";
import { useEffect } from "react";
import { DesktopTitleBar } from "./shell/DesktopTitleBar";
import { Workspace } from "./shell/Workspace";
import { DesktopProjectNameControl } from "./shell/DesktopProjectNameControl";
import { DesktopStartScreen } from "./start/DesktopStartScreen";
import { DesktopExportButton } from "./editor/DesktopExportButton";
import { EditorBootstrapGate } from "./editor/EditorBootstrapGate";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useProjectStore } from "../stores/project-store";
import { autoSaveManager } from "../services/auto-save";
import { UpdateBanner } from "./UpdateBanner";
import { installRendererCrashHandlers, reportRendererCrash } from "./crash-reporting";
import { installLiveBridge } from "../services/agent/live-bridge";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";
import { SettingsDialog } from "../components/editor/settings/SettingsDialog";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { Settings } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import { toast } from "../stores/notification-store";
import { ToastContainer } from "../components/Toast";
import "./theme/desktop-theme.css";

function detectPlatform(): string {
  if (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)) return "darwin";
  if (typeof navigator !== "undefined" && /Win/i.test(navigator.platform)) return "win32";
  return "linux";
}

export function DesktopApp(): JSX.Element {
  const { t } = useTranslation();
  const platform = detectPlatform();
  const hasProject = useProjectStore((state) => state.hasOpenProject);
  const desktopPage = useUIStore((state) => state.desktopPage);
  const isVideoEditing = desktopPage !== "motion";

  // Drive native-menu actions into the app: undo/redo hit the project store
  // directly; new/open/export are broadcast as events for the relevant UI to
  // pick up (e.g. the export button opens its dialog on "export").
  useEffect(() => {
    const bridge = window.reelterminal;
    if (!bridge?.onMenuAction) return;
    return bridge.onMenuAction((id) => {
      switch (id) {
        case "undo":
          void useProjectStore.getState().undo();
          break;
        case "redo":
          void useProjectStore.getState().redo();
          break;
        case "newProject":
        case "open":
        case "export":
          window.dispatchEvent(new CustomEvent(`openreel:menu:${id}`));
          break;
        case "settings":
          useSettingsStore.getState().openSettings();
          break;
      }
    });
  }, []);

  // DOM-level undo/redo (G-01 fix): the native menu accelerator above only
  // fires for real OS key events; this handler makes the SAME store
  // undo/redo reachable to DOM-level keyboard input (and any front-end where
  // the native menu is unavailable). No double-fire with real keyboards:
  // NSMenu consumes the key equivalent before the renderer sees it. The
  // focus guard mirrors services/keyboard-shortcuts.ts — never hijack text
  // entry in an input, textarea, or contenteditable.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      const isRedo =
        (key === "z" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) ||
        (key === "y" && e.ctrlKey && !e.shiftKey && !e.altKey);
      if (!isUndo && !isRedo) return;
      e.preventDefault();
      e.stopPropagation();
      if (isUndo) {
        void useProjectStore.getState().undo();
      } else {
        void useProjectStore.getState().redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Forward uncaught renderer errors + unhandled rejections to the native crash
  // collector so editor-side faults are captured alongside main-process crashes.
  useEffect(() => installRendererCrashHandlers(), []);

  // ADR 0004 Decision 1: serve the main-process live facade session's store
  // requests (getState/getContext/applyActions/requestSave) against the
  // canonical renderer store. No-op off desktop.
  useEffect(() => installLiveBridge(), []);

  // Saving errors must be visible even when the Settings dialog is closed.
  // The dirty revision remains set, so this notification reflects recoverable
  // unsaved work rather than claiming the failed write succeeded.
  useEffect(() => {
    const onAutoSaveError = (): void => {
      toast.error(
        t("settings.autoSaveFailed"),
        t("settings.autoSaveFailedDescription"),
      );
    };
    autoSaveManager.on("error", onAutoSaveError);
    if (autoSaveManager.getStatus() === "error") onAutoSaveError();
    return () => autoSaveManager.off("error", onAutoSaveError);
  }, [t]);

  // Answer the native unsaved-changes guard on window close / quit: report
  // dirty state and flush pending changes on request.
  useEffect(() => {
    const lifecycle = window.reelterminal?.lifecycle;
    if (!lifecycle) return;
    const offQuery = lifecycle.onQueryUnsaved(() =>
      autoSaveManager.hasUnsavedChanges(useProjectStore.getState().getFullProject()),
    );
    const offFlush = lifecycle.onFlush(() =>
      useProjectStore.getState().forceSave(),
    );
    return () => {
      offQuery();
      offFlush();
    };
  }, []);

  return (
    <div className="reelterminal-desktop isolate flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <DesktopTitleBar
        platform={platform}
        // The desktop chrome carries the rename entry, not just the
        // browser-only Toolbar. Shown whenever a project is open (both the
        // edit and motion pages rename the same project).
        projectControl={hasProject ? <DesktopProjectNameControl /> : null}
      >
        {hasProject && isVideoEditing ? <DesktopExportButton /> : null}
        <Button
          label={t("desktop.settings")}
          variant="secondary"
          size="sm"
          icon={<Settings size={15} aria-hidden />}
          onClick={() => useSettingsStore.getState().openSettings()}
          className="mr-2"
        />
      </DesktopTitleBar>
      <div className="min-h-0 flex-1">
        <ErrorBoundary
          onError={(error, info) =>
            reportRendererCrash({
              type: "react-error",
              message: error.message,
              stack: error.stack,
              context: { componentStack: info.componentStack },
            })
          }
        >
          {hasProject ? (
            <EditorBootstrapGate>
              <Workspace />
            </EditorBootstrapGate>
          ) : (
            <DesktopStartScreen />
          )}
        </ErrorBoundary>
      </div>
      <UpdateBanner />
      <SettingsDialog />
      <ToastContainer />
    </div>
  );
}
