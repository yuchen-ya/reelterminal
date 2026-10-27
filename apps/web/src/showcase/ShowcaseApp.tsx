import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ToolcraftButton as Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@reelterminal/ui";
import { EditPage } from "../desktop/pages/EditPage";
import { DesktopTitleBar } from "../desktop/shell/DesktopTitleBar";
import { DesktopProjectNameControl } from "../desktop/shell/DesktopProjectNameControl";
import { DesktopExportButton } from "../desktop/editor/DesktopExportButton";
import { DesktopHelpDialog } from "../desktop/editor/DesktopHelpDialog";
import { WorkspaceModeTabs } from "../components/WorkspaceModeTabs";
import { SettingsDialog } from "../components/editor/settings/SettingsDialog";
import { ToastContainer } from "../components/Toast";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useProjectStore } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";
import { useTimelineStore } from "../stores/timeline-store";
import { toast } from "../stores/notification-store";
import { CircleHelp, Settings, Github } from "../icons/lucide-compat";
import { loadSampleProject } from "./sample-project";
import type { WorkspaceMode } from "../components/WorkspaceModeTabs";

const ReviewPage = lazy(() => import("../desktop/pages/ReviewPage").then(module => ({ default: module.ReviewPage })));

export function ShowcaseApp() {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState<"desktop" | "reset" | null>(null);
  const [resetting, setResetting] = useState(false);
  const [mode, setMode] = useState<WorkspaceMode>("video");
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewLoading = useRef(false);
  const desktopOnly = () => setNotice("desktop");

  const selectMode = (next: WorkspaceMode) => {
    setMode(next);
    if (next !== "workbench" || reviewReady || reviewLoading.current) return;
    reviewLoading.current = true;
    setReviewError(null);
    void import("./review-sample").then(({ ensureReviewSample }) => ensureReviewSample())
      .then(() => setReviewReady(true))
      .catch(error => setReviewError(error instanceof Error ? error.message : String(error)))
      .finally(() => { reviewLoading.current = false; });
  };

  useEffect(() => {
    const pause = () => useTimelineStore.getState().pause();
    const onVisibility = () => {
      if (document.hidden) pause();
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        event.origin === window.location.origin &&
        event.data?.type === "reelterminal-demo:pause"
      )
        pause();
    };
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === "s" || key === "e")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === "e")
          window.dispatchEvent(new CustomEvent("reelterminal:menu:export"));
        else void useProjectStore.getState().forceSave();
      }
      if (
        event.key === "Escape" &&
        !document.querySelector('[role="dialog"]')
      ) {
        window.parent.postMessage(
          { type: "reelterminal-demo:exit" },
          window.location.origin,
        );
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey, true);
    window.parent.postMessage(
      { type: "reelterminal-demo:ready" },
      window.location.origin,
    );
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const reset = async () => {
    setResetting(true);
    try {
      useTimelineStore.getState().pause();
      const project = await loadSampleProject();
      useUIStore.getState().clearSelection();
      useProjectStore.getState().loadProject(project);
      useTimelineStore.getState().seekTo(1);
      useUIStore.getState().showCurrentArchive();
      setNotice(null);
    } catch (error) {
      toast.error(
        "恢复样例失败",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <ErrorBoundary>
      <div className="reelterminal-desktop isolate flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
        <DesktopTitleBar
          platform="browser"
          projectControl={
            <DesktopProjectNameControl
              onNewProject={() => setNotice("reset")}
            />
          }
          centerControl={
            <WorkspaceModeTabs
              activeMode={mode}
              availableModes={["video", "workbench"]}
              onSelectMode={selectMode}
              ariaLabel={t("desktop.workspace.ariaLabel")}
            />
          }
        >
          <DesktopExportButton onExportRequested={desktopOnly} />
          <a
            href="https://github.com/yuchen-ya/reelterminal"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("common.githubRepository")}
            className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-[7px] border border-border bg-bg-2 text-fg-2 hover:bg-bg-3 hover:text-fg"
          >
            <Github size={16} aria-hidden />
          </a>
          <Button
            label={t("desktop.help.title")}
            variant="secondary"
            size="sm"
            icon={<CircleHelp size={15} aria-hidden />}
            onClick={() => setHelpOpen(true)}
            className="mr-2"
          />
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
          {mode === "video" ? <EditPage
            onImportRequested={desktopOnly}
            onConnectRequested={desktopOnly}
          /> : reviewError ? <div role="alert" className="p-6 text-sm">审阅示例加载失败：{reviewError}<button className="ml-3 underline" onClick={() => selectMode("workbench")}>重试</button></div>
            : !reviewReady ? <div role="status" className="p-6 text-sm">正在准备审阅示例…</div>
            : <Suspense fallback={<div role="status" className="p-6 text-sm">正在打开审阅工作台…</div>}><ReviewPage browserDemo /></Suspense>}
        </div>
        <SettingsDialog />
        <DesktopHelpDialog open={helpOpen} onOpenChange={setHelpOpen} canTour />
        <ToastContainer />
        <Dialog
          open={notice !== null}
          onOpenChange={(open) => {
            if (!open) setNotice(null);
          }}
        >
          <DialogContent className="reelterminal-desktop border-border bg-bg-1 text-fg">
            <DialogTitle>
              {notice === "reset" ? "恢复样例工程？" : "在桌面版中继续"}
            </DialogTitle>
            <DialogDescription className="text-fg-2">
              {notice === "reset"
                ? "当前编辑将替换为初始样例。已创建的存档点会保留。"
                : "官网使用正式编辑器界面。素材导入、Agent 连接、本地模型和成片导出需要桌面版。"}
            </DialogDescription>
            {notice === "reset" ? (
              <Button
                label={resetting ? "正在恢复…" : "恢复样例"}
                isDisabled={resetting}
                onClick={() => void reset()}
              />
            ) : (
              <a
                className="inline-flex w-fit rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
                href="https://github.com/yuchen-ya/reelterminal/releases"
                target="_blank"
                rel="noreferrer"
              >
                下载桌面版
              </a>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </ErrorBoundary>
  );
}
