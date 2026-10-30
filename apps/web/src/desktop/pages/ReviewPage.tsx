import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext, ReviewGroup, ReviewNode } from "@reelterminal/core/review/types";
import type { DirectoryCommand } from "../../services/review-workspace/directory";
import { reviewError, reviewService } from "../../services/review-workspace/service";
import { getReviewContext } from "../../services/review-workspace/context";
import { toast } from "../../stores/notification-store";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { WorkbenchPage, WorkbenchPanel } from "./WorkbenchPage";
import { EditorBootstrapGate } from "../editor/EditorBootstrapGate";
import { useReviewController } from "../workbench/useReviewController";
import { projectHistory } from "../workbench/useWorkbenchController";
import { importReviewFiles, planReviewFiles, prepareReviewFileImport } from "../../services/review-workspace/file-import";
import { ReviewImportDialog } from "../workbench/components/ReviewImportDialog";
import { ReviewExportDialog } from "../workbench/components/ReviewExportDialog";
import { ReviewAttachDialog } from "../workbench/components/ReviewAttachDialog";
import { ReviewProcessView } from "../workbench/components/ReviewProcessView";
import { ReviewCommandActivity } from "../workbench/components/ReviewCommandActivity";
import { ReviewRestoreDialog } from "../workbench/components/ReviewRestoreDialog";
import { ReviewBackupDialog } from "../workbench/components/ReviewBackupDialog";
import { ReviewPurgeDialog } from "../workbench/components/ReviewPurgeDialog";
import { ReviewMigrationDialog } from "../workbench/components/ReviewMigrationDialog";
import { MigratedWorkbenchBackup } from "../workbench/components/MigratedWorkbenchBackup";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { wbButton } from "../workbench/wb-button";
import { ReviewNodeHeader } from "../workbench/components/ReviewNodeHeader";
import { ReviewTaskDirectory, type DirectoryView } from "../workbench/components/ReviewTaskDirectory";
import { WorkbenchTabs } from "../workbench/components/WorkbenchTabs";
import { useWorkbenchTabsStore, workbenchTabKey } from "../../stores/workbench-tabs-store";
import { humanBoardStorage, type HumanBoard } from "../../services/human-board/storage";
import { boardTransferInput, type BoardTransferInput } from "../../services/human-board/documents";
import { resourceImage } from "../../services/human-board/media";
import { reviewItemFromProcess } from "../workbench/review-navigation";
import { ReviewAdminMenu } from "../workbench/components/ReviewAdminMenu";
import { ReviewBranchDialog } from "../workbench/components/ReviewBranchDialog";
import { ReviewBranchListDialog } from "../workbench/components/ReviewBranchListDialog";
import "../workbench/workbench.css";
import type { WorkbenchItemView } from "../workbench/types";

const HumanBoardView = lazy(() => import("../workbench/human-board/HumanBoardView"));

const input = "min-w-0 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg";
const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));
const textEntry = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

export function ReviewPage({ browserDemo = false }: { browserDemo?: boolean }) {
  const { t } = useTranslation();
  const { tabs, activeKey } = useWorkbenchTabsStore();
  const activeTab = tabs.find(tab => workbenchTabKey(tab) === activeKey) ?? null;
  const selectedId = activeTab?.kind === "review" ? activeTab.id : null;
  const [managerOpen, setManagerOpen] = useState(false);
  const [boards, setBoards] = useState<HumanBoard[]>([]);
  const [boardsReady, setBoardsReady] = useState(false);
  const [boardIncoming, setBoardIncoming] = useState<BoardTransferInput | null>(null);
  const newBoardFiles = useRef<HTMLInputElement>(null);
  const emptyHost = useRef<HTMLDivElement>(null);
  const [layoutLocked, setLayoutLocked] = useState(false);
  const [switching, setSwitching] = useState(false);
  const transition = useRef(false);
  const flush = useRef<() => Promise<void>>(async () => {});
  const registerFlush = useCallback((callback: () => Promise<void>) => { flush.current = callback; }, []);
  const consumeIncoming = useCallback(() => setBoardIncoming(null), []);
  const refreshBoards = useCallback(async () => {
    const rows = await humanBoardStorage.list();
    setBoards(rows);
    setBoardsReady(true);
    for (const tab of useWorkbenchTabsStore.getState().tabs) {
      if (tab.kind !== "board") continue;
      const row = rows.find(board => board.id === tab.id);
      if (!row) useWorkbenchTabsStore.getState().close(workbenchTabKey(tab));
      else if (row.name !== tab.name) useWorkbenchTabsStore.getState().rename(workbenchTabKey(tab), row.name);
    }
  }, []);
  useEffect(() => { void refreshBoards().catch(report); }, [refreshBoards]);
  const boardSaved = useCallback(() => { void refreshBoards().catch(report); }, [refreshBoards]);
  const board = activeTab?.kind === "board" ? boards.find(row => row.id === activeTab.id) : null;
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
  const [selectedNode, setSelectedNode] = useState<ReviewNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    if (!activeKey && !legacy && !managerOpen) emptyHost.current?.focus();
  }, [activeKey, legacy, managerOpen]);
  const [backupOpen, setBackupOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<ReviewContext["target"] | null>(null);
  const [trashRequest, setTrashRequest] = useState<{ node: ReviewNode; revision: number } | null>(null);
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
  const [branchListTarget, setBranchListTarget] = useState<ReviewContext["target"] | null>(null);
  const [branchTarget, setBranchTarget] = useState<ReviewContext["target"] | null>(null);
  const loadBranchComparison = useCallback(() => reviewService.compareBranch(branchTarget!), [branchTarget]);
  const adoptBranch = useCallback((input: Omit<Parameters<typeof reviewService.adoptBranch>[0], "target">) =>
    reviewService.adoptBranch({ ...input, target: branchTarget! }), [branchTarget]);

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
      if (!browserDemo && !native?.getReviewAccess) throw reviewError("UNSUPPORTED", "独立审阅服务不可用");
      const identity = await getReviewContext();
      const root = {
        ...identity,
        access: browserDemo ? identity.access : await native!.getReviewAccess!({
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
    };
    void load().catch((problem) => {
      if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
    });
    return () => {
      cancelled = true;
    };
  }, [view, query, groupId, generation, browserDemo]);

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
          useWorkbenchTabsStore.getState().close(`review:${selectedId}`);
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

  const navigate = async (action: () => void | Promise<void>) => {
    if (layoutLocked || busy || transition.current) return;
    transition.current = true;
    setSwitching(true);
    try {
      if (activeTab?.kind === "board" && !legacy) await flush.current();
      await action();
    } finally {
      transition.current = false;
      setSwitching(false);
    }
  };
  const openReview = async (id: string) => {
    if (!context) return;
    const node = nodes.find(row => row.id === id) ?? await reviewService.getNodeMetadata({ ...context.target, nodeId: id });
    useWorkbenchUiStore.getState().activateScope(`review:${id}`);
    useWorkbenchTabsStore.getState().open({ kind: "review", id, name: node.name });
    setSelectedNode(node);
    setLegacy(false);
    setManagerOpen(false);
  };
  const chooseNode = (id: string) => { void navigate(() => openReview(id)).catch(report); };
  const openNewBoard = async (content?: BoardTransferInput) => {
    const name = content?.files?.[0]?.name.replace(/\.[^.]+$/, "") || content?.text?.trim().split("\n")[0].slice(0, 40) || "未命名画板";
    const created = await humanBoardStorage.create(name);
    await refreshBoards();
    setBoardIncoming(content ?? null);
    useWorkbenchTabsStore.getState().open({ kind: "board", id: created.id, name: created.name });
    setManagerOpen(false);
    setLegacy(false);
  };
  const createBoard = (content?: BoardTransferInput) => navigate(() => openNewBoard(content));
  useEffect(() => {
    if (legacy) useWorkbenchUiStore.getState().activateScope("project");
    else if (selectedId) useWorkbenchUiStore.getState().activateScope(`review:${selectedId}`);
  }, [selectedId, legacy]);
  useEffect(() => () => { useWorkbenchUiStore.getState().activateScope("project"); }, []);
  useEffect(() => {
    const listener = (event: Event) => {
      const item = (event as CustomEvent<WorkbenchItemView>).detail;
      void navigate(async () => {
        const resourceId = item.imagePayload?.repairMedia?.mediaId ?? item.imagePayload?.originalMedia.mediaId;
        if (!resourceId) throw new Error("该审阅图片没有可加入画板的资源");
        const [resource] = await reviewService.getResources([resourceId]);
        const image = await resourceImage(resource);
        await openNewBoard({ entries: [{ name: item.title, resource, kind: "image", image }] });
      }).catch(report);
    };
    window.addEventListener("reelterminal:add-to-human-board", listener);
    return () => window.removeEventListener("reelterminal:add-to-human-board", listener);
  });
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    for (const tab of useWorkbenchTabsStore.getState().tabs) {
      if (tab.kind !== "review") continue;
      void reviewService.getNodeMetadata({ ...context.target, nodeId: tab.id }).then(node => {
        if (!cancelled && node.name !== tab.name) useWorkbenchTabsStore.getState().rename(workbenchTabKey(tab), node.name);
      }).catch(problem => {
        if (cancelled) return;
        if ((problem as { code?: string }).code === "NOT_FOUND") useWorkbenchTabsStore.getState().close(workbenchTabKey(tab));
        else report(problem);
      });
    }
    return () => { cancelled = true; };
  }, [context]);
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
      if (!legacy && activeTab?.kind === "board") { window.dispatchEvent(new CustomEvent("reelterminal:human-board-history", { detail: direction })); return; }
      const active = document.activeElement;
      if (textEntry(active) || active?.closest('[role="dialog"]')) return;
      if (legacy) {
        if (migrated) { report(new Error("迁移备份为只读，请在独立审阅任务中操作历史")); return; }
        void projectHistory(direction).then(result => { if (!result.ok) report(new Error(result.message)); });
      }
      else if (active?.closest("[data-review-directory]")) void directoryHistory(direction).catch(report);
      else window.dispatchEvent(new CustomEvent("reelterminal:review-content-history", { detail: direction }));
    };
    window.addEventListener("reelterminal:review-history", listener);
    return () => window.removeEventListener("reelterminal:review-history", listener);
  }, [legacy, migrated, directoryHistory, activeTab?.kind]);

  const [startup, setStartup] = useState<{ key: string; command: string } | null>(null);
  useEffect(() => {
    setStartup(null);
    setCopied(false);
    if (!target || browserDemo) return;
    let cancelled = false;
    void window.reelterminal!.collabControl!.getStartupInfo(target).then(info => {
      if (!info.startCommand) throw new Error("审阅启动命令不可用");
      if (!cancelled) setStartup({ key: `review:${target.nodeId}`, command: info.startCommand });
    }).catch(problem => { if (!cancelled) report(problem); });
    return () => { cancelled = true; };
  }, [target, browserDemo]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const command = startup?.key === activeKey ? startup.command : null;
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

  const adminMenu = browserDemo ? null : (
    <ReviewAdminMenu
      contextLoaded={!!context && !busy}
      hasProject={hasProject}
      projectName={projectName}
      onOpenMigration={() => setMigrationOpen(true)}
      onOpenBackup={() => setBackupOpen(true)}
      onOpenRestore={() => setRestoreOpen(true)}
      onOpenLegacyProject={hasProject ? () => { void navigate(() => setLegacy(true)).catch(report); } : undefined}
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
      onPaste={event => {
        if (activeTab || legacy || textEntry(event.target as Element)) return;
        const content = boardTransferInput(event.clipboardData);
        if (content) { event.preventDefault(); void createBoard(content).catch(report); }
      }}
      onDragOver={event => { if (!activeTab && !legacy && event.dataTransfer.types.some(type => ["Files", "text/plain", "text/uri-list", "text/html"].includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } else if (activeTab?.kind === "review" && !legacy && context && !busy && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDrop={event => {
        if (!activeTab && !legacy && !textEntry(event.target as Element)) {
          const content = boardTransferInput(event.dataTransfer, true);
          if (content) { event.preventDefault(); void createBoard(content).catch(report); }
          return;
        }
        if (activeTab?.kind !== "review" || legacy || !context || busy || !event.dataTransfer.files.length) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        const captured = context;
        setBusy(true);
        void (async () => {
          const plan = await planReviewFiles(files);
          const resources = await prepareReviewFileImport(plan);
          const created = await reviewService.directory.commit({ target: captured.target, expectedWorkspaceRevision: captured.revision,
            requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "node.create", name: files[0].name.replace(/\.[^.]+$/, "") || "拖入文件" }] });
          const node = created.nodes[0];
          try {
            await importReviewFiles({ ...captured.target, nodeId: node.id }, node.revision, "拖入文件", plan, { groupId: null }, resources);
          } catch (error) {
            throw new Error(`任务“${node.name}”已创建，但文件导入失败：${error instanceof Error ? error.message : String(error)}`);
          }
          await openReview(node.id);
        })().catch(report).finally(() => setBusy(false));
      }}
    >
      <input ref={newBoardFiles} type="file" multiple hidden data-testid="workbench-import-files" accept="image/*,video/*,.glb,.txt,.md,.log,.html,.htm" onChange={event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) void createBoard({ files }).catch(report);
      }} />
      <WorkbenchTabs locked={layoutLocked || busy || switching} onOpen={() => { void navigate(() => setManagerOpen(true)).catch(report); }}
        onActivate={key => { if (key === activeKey) return; void navigate(() => {
          if (key.startsWith("review:")) useWorkbenchUiStore.getState().activateScope(key);
          useWorkbenchTabsStore.getState().activate(key);
          setLegacy(false);
          setBoardIncoming(null);
        }).catch(report); }} onClose={key => { void navigate(() => useWorkbenchTabsStore.getState().close(key)).catch(report); }} />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3 text-xs" data-testid="workbench-address-bar">
        {legacy ? <span className="text-fg-3">{t("review.legacyProject", { name: projectName })}</span> : activeTab?.kind === "board" ? <span className="text-fg-3" data-testid="workbench-private-board">私有自由画板 · 没有 Agent target；仅主动导出的单个内容快照进入审阅。</span>
          : command ? <button className="min-w-0 flex-1 truncate rounded border border-border bg-bg-2 px-3 py-1 text-left font-mono text-fg-2 hover:text-fg" data-testid="review-start-command" title={copied ? "已复制" : "点击复制启动命令"} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(report); }}>{command}</button>
          : <span className="text-fg-3">{activeTab ? (browserDemo ? "浏览器演示 · 请在桌面版连接 Agent" : "正在载入启动命令…") : "打开审阅任务或自由画板"}</span>}
        {copied && command && !legacy && <span role="status" className="shrink-0 text-fg-3">已复制</span>}
        {adminMenu}
      </div>
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
      ) : activeTab?.kind === "board" ? board ? <Suspense fallback={<div className="p-8 text-sm">正在载入自由画板…</div>}><div className="min-h-0 flex-1"><HumanBoardView key={board.id} board={board} incoming={boardIncoming} onIncomingConsumed={consumeIncoming} onOpenReview={chooseNode} onSaved={boardSaved} onFlush={registerFlush} onLayoutLockChange={setLayoutLocked} /></div></Suspense> : <div className="p-8 text-sm">{boardsReady ? "画板不存在" : "正在载入画板…"}</div> : (
        <div className="flex min-h-0 flex-1">
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
                    context={context}
                    busy={busy}
                    onToggleAccess={handleToggleAccess}
                    browserDemo={browserDemo}
                  />
                  <div className="grid flex-1 place-items-center p-8 text-sm text-fg-2">
                    {t("review.restoreBeforeEditing")}
                  </div>
                </>
              ) : (
                <ReviewNodeEditor
                  browserDemo={browserDemo}
                  key={selected.id}
                  target={target}
                  renderHeader={(headerControls) => (
                    <ReviewNodeHeader
                      node={selected}
                      context={context}
                      busy={busy}
                      onToggleAccess={handleToggleAccess}
                      browserDemo={browserDemo}
                      {...headerControls}
                      onAttach={browserDemo ? undefined : headerControls.onAttach}
                      onExport={browserDemo ? undefined : headerControls.onExport}
                    />
                  )}
                />
              )
            ) : (
              <>
                <ReviewNodeHeader
                  node={null}
                  context={context}
                  busy={busy}
                  onToggleAccess={handleToggleAccess}
                  browserDemo={browserDemo}
                />
                <div ref={emptyHost} className="grid flex-1 place-items-center p-8 text-center outline-none" data-testid="workbench-empty" tabIndex={0}>
                  <div>
                    <h1 className="text-lg font-semibold">{t("review.title")}</h1>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-fg-2">
                      打开已有审阅任务或私有自由画板，也可以拖入文件或粘贴图片、文字与链接来创建画板。
                    </p>
                    <button className={`${wbButton.primary} mt-4`} onClick={() => setManagerOpen(true)} data-testid="review-empty-create">打开 / 新建</button>
                    <button className={`${wbButton.secondary} ml-2 mt-4`} onClick={() => newBoardFiles.current?.click()}>导入文件并创建画板</button>
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      {managerOpen && <ToolcraftDialog isOpen width={820} purpose="workbench-open" onOpenChange={open => { if (!busy) setManagerOpen(open); }}>
        <ToolcraftDialogHeader title="打开 / 管理工作台" onOpenChange={setManagerOpen} />
        <div className="flex h-[min(65vh,620px)] min-h-0" data-testid="workbench-open-dialog" data-workbench-modal="true">
          <section className="flex min-w-0 flex-1 flex-col border-r border-border">
          <ReviewTaskDirectory
            nodes={nodes}
            selectedId={selectedId}
            onSelectNode={chooseNode}
            directoryScope={context ? { target: context.target, revision: context.revision } : undefined}
            onMoveNode={(nodeId, nextGroupId, revision) => { void mutate([{ kind: "node.update", nodeId, patch: { groupId: nextGroupId } }], revision).catch(report); }}
            onDropFiles={(node, files) => {
              if (!context) return;
              const capturedTarget = { ...context.target, nodeId: node.id };
              const revision = node.revision;
              setBusy(true);
              void planReviewFiles(files).then(plan => importReviewFiles(capturedTarget, revision, "拖入文件", plan))
                .catch(report).finally(() => setBusy(false));
            }}
            onUpdateNode={(nodeId, patch) => {
              if (patch.trashed) {
                const node = nodes.find(node => node.id === nodeId);
                if (node && context) setTrashRequest({ node, revision: context.revision });
              } else void mutate([{ kind: "node.update", nodeId, patch }]).catch(report);
            }}
            onBranches={browserDemo ? undefined : node => {
              if (!context) return;
              const nodeTarget = { ...context.target, nodeId: node.id };
              if (node.branch) setBranchTarget(nodeTarget); else setBranchListTarget(nodeTarget);
            }}
            onRenameNode={node => {
              if (context) setRename({ kind: "node", id: node.id, name: node.name, revision: context.revision });
            }}
            onPurgeNode={node => {
              if (context) setPurgeTarget({ ...context.target, nodeId: node.id });
            }}
            directory={directory}
            view={view}
            onSelectView={setView}
            query={query}
            onQueryChange={setQuery}
            groupId={groupId}
            onSelectGroup={setGroupId}
            onCreateNode={async (name) => {
              const result = await mutate([{ kind: "node.create", name }]);
              setView("recent");
              setGroupId("");
              await openReview(result.nodes[0].id);
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
            busy={busy || switching || !context}
          />
          </section>
          <section className="flex min-w-0 flex-1 flex-col gap-2 p-3">
            <div className="flex items-center justify-between text-xs"><strong>私有自由画板</strong><button disabled={busy || switching} className={wbButton.primary} data-testid="human-board-new" onClick={() => void createBoard().catch(report)}>＋ 新建自由画板</button></div>
            <div className="min-h-0 flex-1 overflow-y-auto">{boards.map(row => <div key={row.id} className="flex items-center rounded hover:bg-bg-2">
              <button disabled={busy || switching} className="min-w-0 flex-1 truncate px-2 py-2 text-left text-xs" data-testid={`human-board-open-${row.id}`} onClick={() => { void navigate(() => {
                useWorkbenchTabsStore.getState().open({ kind: "board", id: row.id, name: row.name });
                setBoardIncoming(null); setManagerOpen(false); setLegacy(false);
              }).catch(report); }}>{row.name}</button>
              <button disabled={busy || switching} className="px-2 text-xs text-fg-3 hover:text-status-error" aria-label={`删除画板 ${row.name}`} data-testid={`human-board-delete-${row.id}`} onClick={() => {
                if (!window.confirm(`删除画板“${row.name}”及其撤销历史？已导出的审阅快照会保留。`)) return;
                void navigate(async () => { await humanBoardStorage.remove(row.id); useWorkbenchTabsStore.getState().close(`board:${row.id}`); await refreshBoards(); }).catch(report);
              }}>删除</button>
            </div>)}</div>
            <p className="text-[11px] leading-relaxed text-fg-3">画板自动保存。关闭标签只关闭视图，可从这里重新打开。删除会移除画板及其撤销历史。</p>
          </section>
        </div>
      </ToolcraftDialog>}

      {branchListTarget && <ReviewBranchListDialog target={branchListTarget} onClose={() => setBranchListTarget(null)} onCompare={nodeId => {
        setBranchTarget({ ...branchListTarget, nodeId });
        setBranchListTarget(null);
      }} />}
      {branchTarget && <ReviewBranchDialog target={branchTarget} load={loadBranchComparison} adopt={adoptBranch} onClose={() => setBranchTarget(null)} />}
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
      {purgeTarget && (
        <ReviewPurgeDialog
          target={purgeTarget}
          onClose={() => setPurgeTarget(null)}
          onPurged={() => {
            setPurgeTarget(null);
            if (selectedId === purgeTarget.nodeId) {
              useWorkbenchTabsStore.getState().close(`review:${purgeTarget.nodeId}`);
              setSelectedNode(null);
            }
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
      {trashRequest && <ToolcraftDialog isOpen width={440} purpose="review-trash-confirm" onOpenChange={open => { if (!open && !busy) setTrashRequest(null); }}>
        <ToolcraftDialogHeader title={t("review.trashConfirm.title", { name: trashRequest.node.name })} onOpenChange={open => { if (!open && !busy) setTrashRequest(null); }} />
        <div className="space-y-5 p-5" data-testid="review-trash-dialog" data-workbench-modal="true">
          <p className="text-sm leading-relaxed text-fg-2">{t("review.trashConfirm.description")}</p>
          <div className="flex justify-end gap-2">
            <button autoFocus className={wbButton.secondary} disabled={busy} onClick={() => setTrashRequest(null)}>{t("review.cancel")}</button>
            <button className={`${wbButton.secondary} text-status-error`} disabled={busy} data-testid="review-trash-submit" onClick={() => {
              void mutate([{ kind: "node.update", nodeId: trashRequest.node.id, patch: { trashed: true } }], trashRequest.revision)
                .then(() => setTrashRequest(null)).catch(report);
            }}>{t("review.moveToTrash")}</button>
          </div>
        </div>
      </ToolcraftDialog>}
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
  browserDemo,
  target,
  renderHeader,
}: {
  browserDemo: boolean;
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
  const view = useWorkbenchUiStore(state => state.reviewView);
  const chooseView = useWorkbenchUiStore(state => state.setReviewView);

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

      {!browserDemo && <ReviewCommandActivity target={target} />}

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
          onReviewItem={(itemId) => { void reviewItemFromProcess(target, itemId).catch(report); }}
        />
      ) : (
        <div className="relative min-h-0 flex-1" inert={state.loading && !state.controller.currentItem}>
          <WorkbenchPanel
            browserDemo={browserDemo}
            controller={state.controller}
            exportTarget={!browserDemo && state.overview ? { target, revision: state.overview.node.revision } : undefined}
            reviewTarget={state.overview ? { target, revision: state.overview.node.revision } : undefined}
            paginated={state.hasPrevious || state.hasNext}
            pageKey={state.pageNumber}
            independent
            loading={state.loading && !state.controller.currentItem}
            onImport={() => browserDemo ? toast.error("请使用桌面版导入文件") : setImportOpen(true)}
              paginationFooter={
                (state.hasPrevious || state.hasNext || (state.loading && !state.controller.currentItem)) ? (
                  <div
                    className="flex shrink-0 items-center justify-between border-t border-border pt-1 text-[11px]"
                    data-testid="review-item-pagination"
                    title={t("review.pageScope")}
                  >
                    {state.loading && <span role="status" className="text-fg-3">{t("review.loading")}</span>}
                    <span className="sr-only">{t("review.pageScope")}</span>
                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        className={wbButton.ghost}
                        disabled={state.loading || !state.hasPrevious}
                        onClick={state.previousPage}
                        title={t("review.previous")}
                      >
                        ‹ <span className="sr-only">{t("review.previous")}</span>
                      </button>
                      <span className="px-1 font-mono text-[10px] text-fg-3">{state.pageNumber}</span>
                      <button
                        type="button"
                        className={wbButton.ghost}
                        disabled={state.loading || !state.hasNext}
                        onClick={state.nextPage}
                        title={t("review.next")}
                      >
                        › <span className="sr-only">{t("review.next")}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="sr-only" data-testid="review-item-pagination">
                    {state.loading && <span role="status">{t("review.loading")}</span>}
                    <span>{t("review.pageScope")}</span>
                  </div>
                )
              }
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
                    onClick={() => browserDemo ? toast.error("请使用桌面版导入文件") : setImportOpen(true)}
                  >
                    {t("review.importTitle")}
                  </button>
                  {!browserDemo && <p className="text-xs text-fg-3">Agent 投递前，请在右上角将“Agent 只读”切换为可写。</p>}
                </div>
              </div>
            }
          />
          {state.loading && state.controller.currentItem && (
            <div role="status" data-testid="review-detail-updating" className="pointer-events-none absolute bottom-3 left-3 rounded border border-border bg-bg-1/95 px-3 py-1.5 text-xs text-fg-2">
              正在载入审阅更新，暂时保留上一版内容
            </div>
          )}
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
