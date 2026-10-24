import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext, ReviewGroup, ReviewNode } from "@reelterminal/core/review/types";
import type { DirectoryCommand } from "../../services/review-workspace/directory";
import { reviewError, reviewService } from "../../services/review-workspace/service";
import { UUID } from "../../services/review-workspace/guards";
import { getReviewContext } from "../../services/review-workspace/context";
import { toast } from "../../stores/notification-store";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { WorkbenchPage, WorkbenchPanel } from "./WorkbenchPage";
import { EditorBootstrapGate } from "../editor/EditorBootstrapGate";
import { useReviewController } from "../workbench/useReviewController";
import { ReviewImportDialog } from "../workbench/components/ReviewImportDialog";
import { ReviewExportDialog } from "../workbench/components/ReviewExportDialog";
import { ReviewAttachDialog } from "../workbench/components/ReviewAttachDialog";
import { ReviewProcessView } from "../workbench/components/ReviewProcessView";
import { ReviewRestoreDialog } from "../workbench/components/ReviewRestoreDialog";
import { ReviewBackupDialog } from "../workbench/components/ReviewBackupDialog";
import { ReviewPurgeDialog } from "../workbench/components/ReviewPurgeDialog";
import { ReviewMigrationDialog } from "../workbench/components/ReviewMigrationDialog";
import { MigratedWorkbenchBackup } from "../workbench/components/MigratedWorkbenchBackup";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { wbButton } from "../workbench/wb-button";
import { ReviewNodeHeader } from "../workbench/components/ReviewNodeHeader";
import { ReviewNodeSidebar, type DirectoryView } from "../workbench/components/ReviewNodeSidebar";
import { ReviewAdminMenu } from "../workbench/components/ReviewAdminMenu";
import "../workbench/workbench.css";

const input = "min-w-0 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg";
const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));
const textEntry = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

export function ReviewPage() {
  const { t } = useTranslation();
  const [context, setContext] = useState<ReviewContext | null>(null);
  const [directory, setDirectory] = useState<{
    groups: readonly ReviewGroup[];
    canUndo: boolean;
    canRedo: boolean;
  }>({ groups: [], canUndo: false, canRedo: false });
  const [nodes, setNodes] = useState<readonly ReviewNode[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DirectoryView>("recent");
  const [groupId, setGroupId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const id = localStorage.getItem("reelterminal.review.activeNodeId");
    return id && UUID.test(id) ? id : null;
  });
  const [selectedNode, setSelectedNode] = useState<ReviewNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default: collapsed when a node is selected; expanded when empty/no node selected
  const userToggledSidebar = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !selectedId);

  useEffect(() => {
    if (!userToggledSidebar.current) {
      setSidebarOpen(!selectedId);
    }
  }, [selectedId]);

  const handleToggleSidebar = (open: boolean) => {
    userToggledSidebar.current = true;
    setSidebarOpen(open);
  };

  const [legacy, setLegacy] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [rename, setRename] = useState<{
    kind: "node" | "group";
    id: string;
    name: string;
    revision: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const hasProject = useProjectStore((state) => state.hasOpenProject);
  const projectName = useProjectStore((state) => state.project.name);
  const migrated = useProjectStore((state) => !!state.project.reviewMigration);

  const refresh = useCallback(() => setGeneration((val) => val + 1), []);
  useEffect(() => reviewService.subscribe(refresh), [refresh]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = async () => {
      const native = window.reelterminal?.collabControl;
      if (!native?.getReviewAccess) throw reviewError("UNSUPPORTED", "独立审阅服务不可用");
      const identity = await getReviewContext();
      const root = {
        ...identity,
        access: await native.getReviewAccess({
          reviewWorkspaceId: identity.target.reviewWorkspaceId,
          instanceId: identity.target.instanceId,
        }),
      };
      const [metadata, page] = await Promise.all([
        reviewService.directory.get(root.target),
        reviewService.listNodes(root.target, { view, query, ...(groupId ? { groupId } : {}) }),
      ]);
      if (cancelled) return;
      setContext({ ...root, revision: metadata.revision });
      setDirectory(metadata);
      setNodes(page.nodes);
      setCursor(page.cursor);
      setSelectedId((current) => current ?? page.nodes[0]?.id ?? null);
    };
    void load().catch((problem) => {
      if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
    });
    return () => {
      cancelled = true;
    };
  }, [view, query, groupId, generation]);

  useEffect(() => {
    let cancelled = false;
    if (!context || !selectedId) {
      setSelectedNode(null);
      return;
    }
    const listed = nodes.find((node) => node.id === selectedId);
    if (listed) {
      setSelectedNode(listed);
      return;
    }
    void reviewService
      .getNodeMetadata({ ...context.target, nodeId: selectedId })
      .then((node) => {
        if (!cancelled) setSelectedNode(node);
      })
      .catch((problem) => {
        if (cancelled) return;
        if ((problem as { code?: string }).code === "NOT_FOUND") {
          setSelectedId(null);
          setSelectedNode(null);
        } else report(problem);
      });
    return () => {
      cancelled = true;
    };
  }, [context, nodes, selectedId]);

  useEffect(() => {
    if (groupId && !directory.groups.some((group) => group.id === groupId)) setGroupId("");
  }, [groupId, directory.groups]);

  const chooseNode = (id: string) => {
    setSelectedId(id);
    setSelectedNode(nodes.find((node) => node.id === id) ?? null);
    localStorage.setItem("reelterminal.review.activeNodeId", id);
  };
  const selected = selectedNode?.id === selectedId ? selectedNode : null;
  const target = useMemo(
    () => (context && selectedId ? { ...context.target, nodeId: selectedId } : null),
    [context?.target.reviewWorkspaceId, context?.target.instanceId, selectedId]
  );

  const mutate = async (
    commands: readonly DirectoryCommand[],
    expectedRevision = context?.revision
  ) => {
    if (!context || expectedRevision === undefined) throw reviewError("CONFLICT", "审阅目录尚未载入");
    setBusy(true);
    try {
      return await reviewService.directory.commit({
        target: context.target,
        expectedWorkspaceRevision: expectedRevision,
        requestId: crypto.randomUUID(),
        actor: "human",
        commands,
      });
    } finally {
      setBusy(false);
    }
  };

  const directoryHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (!context) return;
      setBusy(true);
      try {
        await reviewService.directory.history({
          target: context.target,
          expectedWorkspaceRevision: context.revision,
          requestId: crypto.randomUUID(),
          actor: "human",
          direction,
        });
      } finally {
        setBusy(false);
      }
    },
    [context]
  );

  useEffect(() => {
    const listener = (event: Event) => {
      const direction: unknown = (event as CustomEvent).detail;
      if (direction !== "undo" && direction !== "redo") return;
      const active = document.activeElement;
      if (textEntry(active) || active?.closest('[role="dialog"]')) return;
      if (legacy) void useProjectStore.getState()[direction]();
      else if (active?.closest("[data-review-directory]")) void directoryHistory(direction).catch(report);
      else window.dispatchEvent(new CustomEvent("reelterminal:review-content-history", { detail: direction }));
    };
    window.addEventListener("reelterminal:review-history", listener);
    return () => window.removeEventListener("reelterminal:review-history", listener);
  }, [legacy, directoryHistory]);

  const copyInstructions = async () => {
    if (!context) throw reviewError("CONFLICT", "审阅服务尚未载入");
    const info = await window.reelterminal!.collabControl!.getStartupInfo();
    await navigator.clipboard.writeText(
      t("review.startupPrompt", {
        cli: info.cliCommand,
        target: JSON.stringify(target ?? context.target),
        interpolation: { escapeValue: false },
      })
    );
    setCopied(true);
  };

  const update = (patch: Extract<DirectoryCommand, { kind: "node.update" }>["patch"]) => {
    if (selected) void mutate([{ kind: "node.update", nodeId: selected.id, patch }]).catch(report);
  };

  const loadMore = async () => {
    if (!context || !cursor) return;
    const page = await reviewService.listNodes(context.target, {
      cursor,
      view,
      query,
      ...(groupId ? { groupId } : {}),
    });
    setNodes((previous) => [...previous, ...page.nodes]);
    setCursor(page.cursor);
  };

  const handleToggleAccess = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!context) return;
    setBusy(true);
    void window
      .reelterminal!.collabControl!.setReviewAccess!({
        access: event.target.checked ? "write" : "read-only",
        reviewWorkspaceId: context.target.reviewWorkspaceId,
        instanceId: context.target.instanceId,
      })
      .then(setContext)
      .catch(report)
      .finally(() => setBusy(false));
  };

  const adminMenu = (
    <ReviewAdminMenu
      contextLoaded={!!context && !busy}
      hasProject={hasProject}
      projectName={projectName}
      copied={copied}
      onCopyInstructions={() => void copyInstructions().catch(report)}
      onOpenMigration={() => setMigrationOpen(true)}
      onOpenBackup={() => setBackupOpen(true)}
      onOpenRestore={() => setRestoreOpen(true)}
      onOpenLegacyProject={hasProject ? () => setLegacy(true) : undefined}
      onOpenLegacyMotion={
        hasProject
          ? () => {
              useUIStore.getState().setDesktopPage("motion");
            }
          : undefined
      }
    />
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="review-page"
      data-workbench-scope="true"
    >
      {legacy && hasProject ? (
        <>
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-3">
            <button
              type="button"
              className={wbButton.secondary}
              onClick={() => setLegacy(false)}
              data-testid="review-legacy-project"
            >
              {t("review.backToNodes")}
            </button>
            <strong className="text-xs">{t("review.legacyProject", { name: projectName })}</strong>
          </div>
          <div className="min-h-0 flex-1" data-review-legacy="true">
            <EditorBootstrapGate>
              {migrated ? (
                <MigratedWorkbenchBackup
                  onOpenNode={(nodeId) => {
                    setLegacy(false);
                    chooseNode(nodeId);
                  }}
                />
              ) : (
                <WorkbenchPage />
              )}
            </EditorBootstrapGate>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ReviewNodeSidebar
            open={sidebarOpen}
            onToggleOpen={handleToggleSidebar}
            nodes={nodes}
            selectedId={selectedId}
            onSelectNode={chooseNode}
            directory={directory}
            view={view}
            onSelectView={(v) => {
              setView(v);
              setGroupId("");
            }}
            query={query}
            onQueryChange={setQuery}
            groupId={groupId}
            onSelectGroup={setGroupId}
            onCreateNode={async (name) => {
              const result = await mutate([{ kind: "node.create", name }]);
              setView("recent");
              setGroupId("");
              chooseNode(result.nodes[0].id);
            }}
            onCreateGroup={async (name) => {
              await mutate([{ kind: "group.create", name }]);
            }}
            onRenameGroup={(id) => {
              const g = directory.groups.find((group) => group.id === id);
              if (g && context) {
                setRename({ kind: "group", id, name: g.name, revision: context.revision });
              }
            }}
            onRemoveGroup={(id) => {
              void mutate([{ kind: "group.remove", groupId: id }])
                .then(() => setGroupId(""))
                .catch(report);
            }}
            onDirectoryHistory={(direction) => void directoryHistory(direction).catch(report)}
            cursor={cursor}
            onLoadMore={() => void loadMore().catch(report)}
            busy={busy}
          />

          <main className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div
                role="alert"
                className="flex items-center gap-3 border-b border-border p-3 text-xs text-status-error"
              >
                {error}
                <button type="button" className={wbButton.ghost} onClick={refresh}>
                  {t("review.retry")}
                </button>
              </div>
            )}

            {selected && target ? (
              selected.trashedAt ? (
                <>
                  <ReviewNodeHeader
                    node={selected}
                    groups={directory.groups}
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={handleToggleSidebar}
                    onUpdateNode={update}
                    onRenameNode={() =>
                      setRename({
                        kind: "node",
                        id: selected.id,
                        name: selected.name,
                        revision: context!.revision,
                      })
                    }
                    onPurgeNode={() => setPurgeOpen(true)}
                    context={context}
                    busy={busy}
                    onToggleAccess={handleToggleAccess}
                    adminMenu={adminMenu}
                  />
                  <div className="grid flex-1 place-items-center p-8 text-sm text-fg-2">
                    {t("review.restoreBeforeEditing")}
                  </div>
                </>
              ) : (
                <ReviewNodeEditor
                  key={selected.id}
                  target={target}
                  renderHeader={(headerControls) => (
                    <ReviewNodeHeader
                      node={selected}
                      groups={directory.groups}
                      sidebarOpen={sidebarOpen}
                      onToggleSidebar={handleToggleSidebar}
                      onUpdateNode={update}
                      onRenameNode={() =>
                        setRename({
                          kind: "node",
                          id: selected.id,
                          name: selected.name,
                          revision: context!.revision,
                        })
                      }
                      onPurgeNode={() => setPurgeOpen(true)}
                      context={context}
                      busy={busy}
                      onToggleAccess={handleToggleAccess}
                      adminMenu={adminMenu}
                      {...headerControls}
                    />
                  )}
                />
              )
            ) : (
              <>
                <ReviewNodeHeader
                  node={null}
                  groups={directory.groups}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={handleToggleSidebar}
                  context={context}
                  busy={busy}
                  onToggleAccess={handleToggleAccess}
                  adminMenu={adminMenu}
                />
                <div className="grid flex-1 place-items-center p-8 text-center">
                  <div>
                    <h1 className="text-lg font-semibold">{t("review.title")}</h1>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-fg-2">
                      {t("review.emptyWorkspace")}
                    </p>
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {backupOpen && context && (
        <ReviewBackupDialog target={context.target} onClose={() => setBackupOpen(false)} />
      )}
      {migrationOpen && context && (
        <ReviewMigrationDialog
          target={context.target}
          onClose={() => setMigrationOpen(false)}
          onOpenNode={(nodeId) => {
            setMigrationOpen(false);
            setLegacy(false);
            setView("recent");
            setGroupId("");
            chooseNode(nodeId);
          }}
        />
      )}
      {purgeOpen && target && (
        <ReviewPurgeDialog
          target={target}
          onClose={() => setPurgeOpen(false)}
          onPurged={() => {
            setPurgeOpen(false);
            setSelectedId(null);
            setSelectedNode(null);
            localStorage.removeItem("reelterminal.review.activeNodeId");
          }}
        />
      )}
      {restoreOpen && context && (
        <ReviewRestoreDialog
          target={context.target}
          onClose={() => setRestoreOpen(false)}
          onRestored={(node) => {
            setView("recent");
            setGroupId("");
            chooseNode(node.id);
            setRestoreOpen(false);
            refresh();
          }}
        />
      )}
      {rename && (
        <ToolcraftDialog
          isOpen
          onOpenChange={(open) => {
            if (!open && !busy) setRename(null);
          }}
          width={440}
          purpose="review-rename"
        >
          <ToolcraftDialogHeader
            title={t("review.rename")}
            onOpenChange={(open) => {
              if (!open && !busy) setRename(null);
            }}
          />
          <form
            className="space-y-3 p-5"
            data-workbench-modal="true"
            onSubmit={(event) => {
              event.preventDefault();
              const command: DirectoryCommand =
                rename.kind === "node"
                  ? { kind: "node.update", nodeId: rename.id, patch: { name: rename.name } }
                  : { kind: "group.update", groupId: rename.id, name: rename.name };
              void mutate([command], rename.revision)
                .then(() => setRename(null))
                .catch(report);
            }}
          >
            <input
              autoFocus
              className={`${input} w-full`}
              aria-label={t("review.name")}
              value={rename.name}
              maxLength={200}
              onChange={(event) => setRename({ ...rename, name: event.target.value })}
            />
            <button className={wbButton.primary} disabled={busy || !rename.name.trim()}>
              {t("review.save")}
            </button>
          </form>
        </ToolcraftDialog>
      )}
    </div>
  );
}

function ReviewNodeEditor({
  target,
  renderHeader,
}: {
  target: ReviewContext["target"];
  renderHeader: (controls: {
    view: "content" | "process";
    onSelectView: (view: "content" | "process") => void;
    stepCount: number;
    canAttach: boolean;
    attachTitle?: string;
    onAttach: () => void;
    canExport: boolean;
    onExport: () => void;
  }) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const state = useReviewController(target);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [attachItem, setAttachItem] = useState<string | null>(null);
  const [view, setView] = useState<"content" | "process">(() =>
    localStorage.getItem(`reelterminal.review.view:${target.nodeId}`) === "process"
      ? "process"
      : "content"
  );
  const chooseView = (next: "content" | "process") => {
    setView(next);
    localStorage.setItem(`reelterminal.review.view:${target.nodeId}`, next);
  };

  useEffect(() => {
    const listener = (event: Event) => {
      const direction: unknown = (event as CustomEvent).detail;
      if ((direction !== "undo" && direction !== "redo") || state.loading) return;
      void state.controller[direction === "undo" ? "undoLast" : "redoLast"]().then((result) => {
        if (!result.ok) report(new Error(result.message));
      });
    };
    window.addEventListener("reelterminal:review-content-history", listener);
    return () => window.removeEventListener("reelterminal:review-content-history", listener);
  }, [state.controller, state.loading]);

  const canAttach =
    !state.loading &&
    !!state.controller.currentItem &&
    ["image", "video"].includes(state.controller.currentItem.type);
  const attachTitle =
    state.controller.currentItem?.type === "model3d"
      ? "视频项目不支持模型；请另行提交渲染视频"
      : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="review-node-editor">
      {renderHeader({
        view,
        onSelectView: chooseView,
        stepCount: state.overview?.stepCount ?? 0,
        canAttach,
        attachTitle,
        onAttach: () => setAttachItem(state.controller.currentItem!.id),
        canExport: !state.loading && !!state.overview,
        onExport: () => setExportOpen(true),
      })}

      {state.error && (
        <div role="alert" className="flex items-center gap-2 p-2 text-xs text-status-error">
          {state.error}
          <button type="button" className={wbButton.ghost} onClick={state.refresh}>
            {t("review.retry")}
          </button>
        </div>
      )}

      {exportOpen && state.overview && (
        <ReviewExportDialog
          target={target}
          revision={state.overview.node.revision}
          selectedIds={state.controller.selectedIds.filter((id) =>
            state.controller.visibleItemIds.includes(id)
          )}
          filter={{
            batchId: state.controller.activeBatch?.id,
            type: state.controller.typeFilter,
            query: state.controller.searchQuery,
          }}
          onClose={() => setExportOpen(false)}
        />
      )}

      {attachItem && state.overview && (
        <ReviewAttachDialog
          target={target}
          revision={state.overview.node.revision}
          itemId={attachItem}
          onClose={() => setAttachItem(null)}
        />
      )}

      {view === "process" ? (
        <ReviewProcessView
          target={target}
          onReviewItem={(itemId) => {
            void reviewService
              .getItem(target, itemId)
              .then(({ item }) => {
                useWorkbenchUiStore.getState().setActiveBatchId(item.batchId);
                useWorkbenchUiStore.getState().setCursor(item.batchId, item.id);
                chooseView("content");
              })
              .catch(report);
          }}
        />
      ) : (
        <div className="min-h-0 flex-1" inert={state.loading}>
          <WorkbenchPanel
            controller={state.controller}
            independent
            loading={state.loading}
            onImport={() => setImportOpen(true)}
            emptyContent={
              <div className="grid h-full place-items-center p-8 text-center">
                <div className="space-y-3">
                  <h2 className="font-semibold">{t("review.emptyNode")}</h2>
                  <p className="max-w-md text-xs leading-relaxed text-fg-2">
                    {t("review.emptyNodeDescription")}
                  </p>
                  <button
                    type="button"
                    className={wbButton.primary}
                    disabled={!state.overview}
                    onClick={() => setImportOpen(true)}
                  >
                    {t("review.importTitle")}
                  </button>
                </div>
              </div>
            }
          />
        </div>
      )}

      {view === "content" && (
        <div
          className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1.5 text-xs"
          data-testid="review-item-pagination"
        >
          {state.loading && <span role="status" className="mr-auto">{t("review.loading")}</span>}
          <span className="mr-auto text-fg-3">{t("review.pageScope")}</span>
          <button
            type="button"
            className={wbButton.ghost}
            disabled={state.loading || !state.hasPrevious}
            onClick={state.previousPage}
          >
            {t("review.previous")}
          </button>
          <span>{state.pageNumber}</span>
          <button
            type="button"
            className={wbButton.ghost}
            disabled={state.loading || !state.hasNext}
            onClick={state.nextPage}
          >
            {t("review.next")}
          </button>
        </div>
      )}

      {importOpen && state.overview && (
        <ReviewImportDialog
          isOpen
          target={target}
          expectedNodeRevision={state.overview.node.revision}
          onOpenChange={setImportOpen}
        />
      )}
    </div>
  );
}

export default ReviewPage;
