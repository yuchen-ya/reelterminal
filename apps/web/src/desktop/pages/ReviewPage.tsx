import { LocalizedMessage } from "../../i18n/LocalizedMessage";
import { t as translate } from "../../i18n";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Folder, MoreHorizontal } from "lucide-react";
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
import { ReviewRepairDraftPreview } from "../workbench/components/ReviewRepairDraftPreview";
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
import { FreeBoardIcon, WorkspaceDirectoryIcon } from "../workbench/components/WorkbenchIcons";
import { useWorkbenchTabsStore, workbenchTabKey, type WorkbenchTab } from "../../stores/workbench-tabs-store";
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
const TaskReviewWorkspace = lazy(() => import("../workbench/task-review/TaskReviewWorkspace").then(module => ({ default: module.TaskReviewWorkspace })));

const input = "min-w-0 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg";
const compactIconButton = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-fg-2 hover:bg-bg-2 hover:text-fg disabled:opacity-40";
const report = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error));
const textEntry = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

export function ReviewPage({ browserDemo = false }: { browserDemo?: boolean }) {
  const { t } = useTranslation();
  const { tabs, activeKey, recentFolders } = useWorkbenchTabsStore();
  const activeTab = tabs.find(tab => workbenchTabKey(tab) === activeKey) ?? null;
  const selectedId = activeTab?.kind === "review" ? activeTab.id : null;
  const [managerOpen, setManagerOpen] = useState(!activeKey);
  const [newFolderTask, setNewFolderTask] = useState<{ tasksRoot: string; name: string; folderName: string } | null>(null);
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

  useEffect(() => {
    if (!managerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !busy &&
        !trashRequest &&
        !rename &&
        !document.querySelector('[role="menu"], [role="dialog"]')
      ) {
        setManagerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [managerOpen, busy, trashRequest, rename]);

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
      if (!browserDemo && !native?.getReviewAccess) throw reviewError("UNSUPPORTED", translate("The independent review service is unavailable"));
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
      if ((activeTab?.kind === "board" || activeTab?.kind === "folder") && !legacy && !managerOpen) await flush.current();
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
  const openFolder = (root?: string) => navigate(async () => {
    const task = await window.reelterminal!.folderReview!.open(root);
    if (!task) return;
    useWorkbenchTabsStore.getState().open({ kind: "folder", id: task.root, root: task.root, name: task.name });
    setLegacy(false);
    setManagerOpen(false);
  });
  const showNewFolderTask = async () => {
    const { tasksRoot } = await window.reelterminal!.folderReview!.defaults();
    setNewFolderTask({ tasksRoot, name: "", folderName: `task-${crypto.randomUUID().slice(0, 8)}` });
  };
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [folderRename, setFolderRename] = useState<{ id: string; root: string; name: string; revision: number } | null>(null);
  // open(root) with an explicit root scans and registers the folder without a
  // picker dialog, giving the current revision renameTask needs.
  const beginFolderRename = async (folder: WorkbenchTab) => {
    if (!folder.root) return;
    const snapshot = await window.reelterminal!.folderReview!.open(folder.root);
    if (!snapshot) return;
    setFolderMenu(null);
    setFolderRename({ id: folder.id, root: snapshot.root, name: snapshot.name, revision: snapshot.revision });
  };
  const saveFolderRename = () => navigate(async () => {
    const row = folderRename;
    if (!row || !row.name.trim()) return;
    const { snapshot } = await window.reelterminal!.folderReview!.renameTask({ root: row.root, expectedRevision: row.revision, name: row.name });
    setFolderRename(null);
    useWorkbenchTabsStore.getState().rename(workbenchTabKey({ kind: "folder", id: row.id }), snapshot.name);
  });
  const createFolderTask = () => navigate(async () => {
    if (!newFolderTask) return;
    const task = await window.reelterminal!.folderReview!.create({ name: newFolderTask.name, folderName: newFolderTask.folderName });
    useWorkbenchTabsStore.getState().open({ kind: "folder", id: task.root, root: task.root, name: task.name });
    setNewFolderTask(null);
    setLegacy(false);
    setManagerOpen(false);
  });
  const openNewBoard = async (content?: BoardTransferInput) => {
    const name = content?.files?.[0]?.name.replace(/\.[^.]+$/, "") || content?.text?.trim().split("\n")[0].slice(0, 40) || translate("Untitled board");
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
        if (!resourceId) throw new Error(translate("This review image has no resource that can be added to a board"));
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
    if (!context || expectedRevision === undefined) throw reviewError("CONFLICT", translate("The review directory has not loaded"));
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
      if (!legacy && !managerOpen && activeTab?.kind === "board") { window.dispatchEvent(new CustomEvent("reelterminal:human-board-history", { detail: direction })); return; }
      const active = document.activeElement;
      if (textEntry(active) || active?.closest('[role="dialog"]')) return;
      if (legacy) {
        if (migrated) { report(new Error(translate("The migration backup is read-only. Use the independent review task to edit its history."))); return; }
        void projectHistory(direction).then(result => { if (!result.ok) report(new Error(result.message)); });
      }
      else if (managerOpen || active?.closest("[data-review-directory]")) void directoryHistory(direction).catch(report);
      else window.dispatchEvent(new CustomEvent("reelterminal:review-content-history", { detail: direction }));
    };
    window.addEventListener("reelterminal:review-history", listener);
    return () => window.removeEventListener("reelterminal:review-history", listener);
  }, [legacy, managerOpen, migrated, directoryHistory, activeTab?.kind]);

  const [startup, setStartup] = useState<{ key: string; command: string } | null>(null);
  useEffect(() => {
    setStartup(null);
    setCopied(false);
    if (!target || browserDemo) return;
    let cancelled = false;
    void window.reelterminal!.collabControl!.getStartupInfo(target).then(info => {
      if (!info.startCommand) throw new Error(translate("The review startup command is unavailable"));
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
      onImportToBoard={
        activeTab?.kind === "board" && !managerOpen && !legacy
          ? () => document.querySelector<HTMLInputElement>('[data-testid="human-board-import-files"]')?.click()
          : undefined
      }
      onOpenMigration={() => setMigrationOpen(true)}
      onOpenBackup={() => setBackupOpen(true)}
      onOpenRestore={() => setRestoreOpen(true)}
      onOpenLegacyProject={hasProject ? () => { void navigate(() => { setManagerOpen(false); setLegacy(true); }).catch(report); } : undefined}
      onOpenLegacyMotion={
        hasProject
          ? () => {
              useUIStore.getState().setDesktopPage("motion");
            }
          : undefined
      }
    />
  );

  const reviewAddressContent = (
    <>
      {command ? (
        <button
          className="h-6 min-w-0 max-w-[340px] xl:max-w-[460px] truncate rounded-[5px] border border-border bg-bg-2 px-2.5 text-left font-mono text-[11px] text-fg-2 transition-colors hover:border-border-strong hover:bg-bg-3 hover:text-fg"
          data-testid="review-start-command"
          title={copied ? t("material.copied") : t("Click to copy the startup command")}
          onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(report); }}
        >
          {command}
        </button>
      ) : (
        <span className="truncate text-fg-3">
          {activeTab ? (browserDemo ? t("Browser demo · Use the desktop app to connect an Agent") : t("Loading the startup command…")) : t("Open a review task or free board")}
        </span>
      )}
      {copied && command && !legacy && <span role="status" className="shrink-0 text-[11px] text-accent">{t("material.copied")}</span>}
    </>
  );

  const boardToolbarRight = (
    <div className="flex shrink-0 items-center gap-1" data-testid="workbench-address-bar">
      <span
        className="sr-only"
        data-testid="workbench-private-board"
      >{t("Free Board · Export files or review snapshots")}</span>
      {browserDemo && adminMenu}
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="review-page"
      data-workbench-scope="true"
      onPaste={event => {
        if ((activeTab && !managerOpen) || legacy || textEntry(event.target as Element)) return;
        const content = boardTransferInput(event.clipboardData);
        if (content) { event.preventDefault(); void createBoard(content).catch(report); }
      }}
      onDragOver={event => { if ((!activeTab || managerOpen) && !legacy && event.dataTransfer.types.some(type => ["Files", "text/plain", "text/uri-list", "text/html"].includes(type))) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } else if (activeTab?.kind === "review" && !managerOpen && !legacy && context && !busy && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDrop={event => {
        if ((!activeTab || managerOpen) && !legacy && !textEntry(event.target as Element)) {
          const content = boardTransferInput(event.dataTransfer, true);
          if (content) { event.preventDefault(); void createBoard(content).catch(report); }
          return;
        }
        if (activeTab?.kind !== "review" || managerOpen || legacy || !context || busy || !event.dataTransfer.files.length) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        const captured = context;
        setBusy(true);
        void (async () => {
          const plan = await planReviewFiles(files);
          const resources = await prepareReviewFileImport(plan);
          const created = await reviewService.directory.commit({ target: captured.target, expectedWorkspaceRevision: captured.revision,
            requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "node.create", name: files[0].name.replace(/\.[^.]+$/, "") || translate("Dropped files") }] });
          const node = created.nodes[0];
          try {
            await importReviewFiles({ ...captured.target, nodeId: node.id }, node.revision, translate("Dropped files"), plan, { groupId: null }, resources);
          } catch (error) {
            throw new Error(translate("Task “{{v0}}” was created, but file import failed: {{v1}}", { v0: node.name, v1: error instanceof Error ? error.message : String(error) }));
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
      <WorkbenchTabs
        locked={layoutLocked || busy || switching}
        managerOpen={managerOpen}
        onOpen={() => { void navigate(() => setManagerOpen(true)).catch(report); }}
        onCloseManager={() => setManagerOpen(false)}
        onActivate={key => {
          if (key === activeKey && !managerOpen) return;
          void navigate(() => {
            if (key.startsWith("review:")) useWorkbenchUiStore.getState().activateScope(key);
            useWorkbenchTabsStore.getState().activate(key);
            setManagerOpen(false);
            setLegacy(false);
            setBoardIncoming(null);
          }).catch(report);
        }}
        onClose={key => { void navigate(() => useWorkbenchTabsStore.getState().close(key)).catch(report); }}
      />
      {managerOpen ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3 text-xs" data-testid="workbench-address-bar">
            <div className="flex min-w-0 items-center gap-2">
              <WorkspaceDirectoryIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
              <strong className="shrink-0 font-semibold text-fg">{t("Open and manage workspaces")}</strong>
              {selected && (
                <span className="sr-only" data-testid="review-node-title" data-node-id={selected.id}>
                  {selected.name}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {activeTab && (
                <button
                  type="button"
                  className={wbButton.secondary}
                  onClick={() => setManagerOpen(false)}
                >{t("Return to the current tab")}</button>
              )}
              {browserDemo && adminMenu}
            </div>
          </div>
          <div
            className="grid min-h-0 flex-1 bg-bg lg:grid-cols-12"
            data-testid="workbench-open-dialog"
            data-workbench-modal="true"
          >
            <section className="flex min-h-0 min-w-0 flex-col border-b border-border lg:col-span-8 lg:border-b-0 lg:border-r">
              {browserDemo ? <ReviewTaskDirectory
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
                  void planReviewFiles(files).then(plan => importReviewFiles(capturedTarget, revision, translate("Dropped files"), plan))
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
              /> : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="folder-task-directory">
                  <div className="flex h-7 items-center justify-between gap-2 px-1 text-xs">
                    <strong className="font-semibold">任务文件夹</strong>
                    <div className="flex gap-1.5">
                      <button type="button" className={wbButton.secondary} disabled={switching} onClick={() => void openFolder().catch(report)}>打开文件夹</button>
                      <button type="button" className={wbButton.primary} disabled={switching} aria-expanded={!!newFolderTask} data-testid="folder-task-new" onClick={() => { if (newFolderTask) setNewFolderTask(null); else void showNewFolderTask().catch(report); }}>＋ 新建任务</button>
                    </div>
                  </div>
                  {newFolderTask ? (
                    <form role="dialog" aria-label="新建任务" className="mx-1 flex flex-col gap-2 rounded-md border border-accent/60 bg-bg-1 p-2.5" onSubmit={event => { event.preventDefault(); void createFolderTask().catch(report); }}>
                      <label className="flex flex-col gap-1">任务名称<input autoFocus className={input} value={newFolderTask.name} onChange={event => setNewFolderTask({ ...newFolderTask, name: event.target.value })} /></label>
                      <label className="flex flex-col gap-1">文件夹名称<input className={input} value={newFolderTask.folderName} onChange={event => setNewFolderTask({ ...newFolderTask, folderName: event.target.value })} /></label>
                      <p className="break-all font-mono text-xs text-fg-3">保存位置：{newFolderTask.tasksRoot}{newFolderTask.tasksRoot.includes("\\") ? "\\" : "/"}{newFolderTask.folderName}</p>
                      <div className="flex justify-end gap-2"><button type="button" className={wbButton.ghost} onClick={() => setNewFolderTask(null)}>取消</button><button className={wbButton.primary} disabled={switching || !newFolderTask.name.trim() || !newFolderTask.folderName}>创建</button></div>
                    </form>
                  ) : (
                    <p className="px-1 text-xs text-fg-3">在选择窗口中选择已有文件夹，或新建文件夹作为任务。</p>
                  )}
                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto border-t border-border px-1 pt-1.5" onClick={() => { if (folderMenu) setFolderMenu(null); }}>
                    {recentFolders.map(folder => {
                      const active = activeKey === workbenchTabKey(folder);
                      const renaming = folderRename?.id === folder.id ? folderRename : null;
                      return (
                        <div key={folder.id}
                          className={`group relative rounded-md border px-2.5 py-2 text-xs transition-colors ${active || folderMenu === folder.id || renaming ? "border-accent/60 bg-bg-2" : "border-border hover:border-accent/60 hover:bg-bg-2"}`}
                          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setFolderMenu(folder.id); }}>
                          {renaming ? (
                            <form className="flex items-center gap-1.5" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void saveFolderRename().catch(report); }}>
                              <input autoFocus className={`${input} min-w-0 flex-1`} aria-label="重命名任务" maxLength={200} value={renaming.name} disabled={switching}
                                onChange={event => setFolderRename({ ...renaming, name: event.target.value })}
                                onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setFolderRename(null); } }} />
                              <button type="submit" className={wbButton.secondary} disabled={switching || !renaming.name.trim()}>保存</button>
                              <button type="button" className={wbButton.ghost} onClick={() => setFolderRename(null)}>取消</button>
                            </form>
                          ) : (
                            <>
                              <button type="button" disabled={switching} data-testid="folder-task-recent" title={folder.root}
                                className="block w-full pr-7 text-left"
                                onClick={() => void openFolder(folder.root).catch(report)}>
                                <span className="block truncate font-semibold text-fg">{folder.name}</span>
                                <span className="mt-0.5 flex min-w-0 items-center gap-1 text-fg-3">
                                  <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
                                  <span className="truncate font-mono">{folder.root}</span>
                                </span>
                              </button>
                              <button type="button" className={`${compactIconButton} absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                                aria-label={`任务 ${folder.name} 的操作`} aria-haspopup="menu" aria-expanded={folderMenu === folder.id}
                                disabled={switching}
                                onClick={event => { event.stopPropagation(); setFolderMenu(folderMenu === folder.id ? null : folder.id); }}>
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                              {folderMenu === folder.id && (
                                <div role="menu" className="absolute right-1.5 top-8 z-20 w-44 rounded-md border border-border bg-bg-1 py-1 shadow-lg" onClick={event => event.stopPropagation()}>
                                  <button type="button" role="menuitem" disabled={switching || !folder.root}
                                    className="block w-full px-3 py-1.5 text-left text-fg-2 hover:bg-bg-2 hover:text-fg"
                                    onClick={() => {
                                      setFolderMenu(null);
                                      if (folder.root) {
                                        void window.reelterminal?.folderReview?.showInFolder({ root: folder.root }).catch(report);
                                      }
                                    }}>打开文件所在位置</button>
                                  <button type="button" role="menuitem" disabled={switching}
                                    className="block w-full px-3 py-1.5 text-left text-fg-2 hover:bg-bg-2 hover:text-fg"
                                    onClick={() => { setFolderMenu(null); void beginFolderRename(folder).catch(report); }}>重命名</button>
                                  <button type="button" role="menuitem" disabled={switching}
                                    className="block w-full px-3 py-1.5 text-left text-fg-2 hover:bg-bg-2 hover:text-fg"
                                    onClick={() => {
                                      setFolderMenu(null);
                                      useWorkbenchTabsStore.getState().removeFolder(folder.id);
                                    }}>从列表中移除</button>
                                  <button type="button" role="menuitem" disabled={switching || !folder.root}
                                    className="block w-full px-3 py-1.5 text-left text-status-error hover:bg-bg-2 hover:text-status-error"
                                    onClick={() => {
                                      setFolderMenu(null);
                                      if (!folder.root) return;
                                      const confirmed = window.confirm(`确定要将任务文件夹 "${folder.name}" 移入回收站吗？\n路径：${folder.root}`);
                                      if (!confirmed) return;
                                      void (async () => {
                                        try {
                                          await window.reelterminal?.folderReview?.trash({ root: folder.root!, trashRoot: true });
                                          useWorkbenchTabsStore.getState().removeFolder(folder.id);
                                          toast.info(`已将 "${folder.name}" 移入回收站`);
                                        } catch (err) {
                                          report(err);
                                        }
                                      })();
                                    }}>移入回收站</button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                    {!recentFolders.length && <p className="px-2 py-6 text-center text-xs text-fg-3">打开或新建任务文件夹后，它会显示在这里。</p>}
                  </div>
                </div>
              )}
            </section>
            <section className="flex min-h-0 min-w-0 flex-col gap-2 bg-bg-1/40 p-3 lg:col-span-4">
              <div className="flex h-7 items-center justify-between px-1 text-xs">
                <strong className="inline-flex items-center gap-1.5 font-semibold text-fg">
                  <FreeBoardIcon className="h-3.5 w-3.5 text-sky-400" />
                  <span>{t("Free Boards")}</span>
                </strong>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy || switching}
                    className={wbButton.secondary}
                    onClick={() => newBoardFiles.current?.click()}
                  >{t("Create a board from files")}</button>
                  <button
                    type="button"
                    disabled={busy || switching}
                    className={wbButton.primary}
                    data-testid="human-board-new"
                    onClick={() => void createBoard().catch(report)}
                  >{t("＋ New Free Board")}</button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto border-t border-border pt-1.5">
                {boards.map(row => (
                  <div key={row.id} className="group flex items-center rounded px-2 hover:bg-bg-2">
                    <FreeBoardIcon className="mr-2 h-3.5 w-3.5 shrink-0 text-sky-400" />
                    <button
                      disabled={busy || switching}
                      className="min-w-0 flex-1 truncate py-2 text-left text-xs text-fg-2 group-hover:text-fg"
                      data-testid={`human-board-open-${row.id}`}
                      onClick={() => {
                        void navigate(() => {
                          useWorkbenchTabsStore.getState().open({ kind: "board", id: row.id, name: row.name });
                          setBoardIncoming(null);
                          setManagerOpen(false);
                          setLegacy(false);
                        }).catch(report);
                      }}
                    >
                      {row.name}
                    </button>
                    <button
                      disabled={busy || switching}
                      className="px-2 py-1 text-xs text-fg-3 hover:text-status-error"
                      aria-label={t("Delete board {{v0}}", { v0: row.name })}
                      data-testid={`human-board-delete-${row.id}`}
                      onClick={() => {
                        if (!window.confirm(translate("Delete board “{{v0}}” and its undo history? Exported review snapshots are preserved.", { v0: row.name }))) return;
                        void navigate(async () => {
                          await humanBoardStorage.remove(row.id);
                          useWorkbenchTabsStore.getState().close(`board:${row.id}`);
                          await refreshBoards();
                        }).catch(report);
                      }}
                    >{t("projectLibrary.recycle")}</button>
                  </div>
                ))}
                {!boards.length && (
                  <p className="px-2 py-6 text-center text-xs text-fg-3">{t("No free boards yet. Choose ＋ New Free Board at the top right or drop files to get started.")}</p>
                )}
              </div>
            </section>
          </div>
        </div>
      ) : legacy && hasProject ? (
        <>
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3 text-xs" data-testid="workbench-address-bar">
            <button
              type="button"
              className={wbButton.secondary}
              onClick={() => setLegacy(false)}
              data-testid="review-legacy-project"
            >
              {t("review.backToNodes")}
            </button>
            <strong className="text-xs">{t("review.legacyProject", { name: projectName })}</strong>
            {adminMenu}
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
      ) : activeTab?.kind === "folder" && activeTab.root ? (
        <Suspense fallback={<div className="p-6 text-sm">正在打开任务文件夹…</div>}>
          <TaskReviewWorkspace
            key={activeTab.id}
            root={activeTab.root}
            name={activeTab.name}
            onFlush={registerFlush}
            onClose={() => { void navigate(() => useWorkbenchTabsStore.getState().close(activeKey!)).catch(report); }}
          />
        </Suspense>
      ) : activeTab?.kind === "board" ? board ? (
        <Suspense fallback={<div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-3 text-xs"><span className="text-fg-3">{t("Loading free boards…")}</span>{boardToolbarRight}</div>}>
          <div className="min-h-0 flex-1">
            <HumanBoardView
              key={board.id}
              board={board}
              incoming={boardIncoming}
              onIncomingConsumed={consumeIncoming}
              onOpenReview={chooseNode}
              onSaved={boardSaved}
              onFlush={registerFlush}
              onLayoutLockChange={setLayoutLocked}
              toolbarRight={boardToolbarRight}
            />
          </div>
        </Suspense>
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-3 text-xs">
            <span className="text-fg-3">{boardsReady ? t("Board not found") : t("Loading the board…")}</span>
            {boardToolbarRight}
          </div>
          <div className="p-8 text-sm">{boardsReady ? t("Board not found") : t("Loading the board…")}</div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div
                role="alert"
                className="flex items-center gap-3 border-b border-border p-3 text-xs text-status-error"
              >
                <LocalizedMessage>{error}</LocalizedMessage>
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
                    addressContent={reviewAddressContent}
                    adminMenu={adminMenu}
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
                      addressContent={reviewAddressContent}
                      commandActivity={!browserDemo ? <ReviewCommandActivity target={target} inline /> : undefined}
                      adminMenu={adminMenu}
                      {...headerControls}
                      onAttach={browserDemo ? undefined : headerControls.onAttach}
                      onExport={browserDemo ? undefined : headerControls.onExport}
                    />
                  )}
                />
              )
            ) : (
              <div ref={emptyHost} className="grid flex-1 place-items-center p-8 text-center outline-none" data-testid="workbench-empty" tabIndex={0}>
                <div>
                  <h1 className="text-lg font-semibold">{t("review.title")}</h1>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-fg-2">{browserDemo ? t("Open an existing review task or free board, or create a board by dropping files or pasting images, text and links.") : "打开真实文件夹，直接查看和整理素材文件。台词审阅在任务工作台逐条进行，导出只包含人工判定通过的条目；对文件的移动或复制只是文件操作。审阅记录随任务文件夹保存。"}</p>
                  {!browserDemo && window.reelterminal?.folderReview && <button className={`${wbButton.primary} mt-4`} onClick={() => void openFolder().catch(report)}>打开任务文件夹</button>}
                  <button className={`${wbButton.secondary} ml-2 mt-4`} onClick={() => setManagerOpen(true)} data-testid="review-empty-create">{t("Open / New")}</button>
                  <button className={`${wbButton.secondary} ml-2 mt-4`} onClick={() => newBoardFiles.current?.click()}>{t("Import files and create a board")}</button>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

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
      ? translate("Video projects do not support models. Submit a rendered video separately.")
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

      {!browserDemo && <ReviewRepairDraftPreview target={target} />}

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
            loading={state.loading}
            onImport={() => browserDemo ? toast.error(translate("Use the desktop app to import files")) : setImportOpen(true)}
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
                    onClick={() => browserDemo ? toast.error(translate("Use the desktop app to import files")) : setImportOpen(true)}
                  >
                    {t("review.importTitle")}
                  </button>
                  {!browserDemo && <p className="text-xs text-fg-3">{t("Before Agent submission, enable editing with the Agent read-only control at the top right.")}</p>}
                </div>
              </div>
            }
          />
          {state.loading && state.controller.currentItem && (
            <div role="status" data-testid="review-detail-updating" className="pointer-events-none absolute bottom-3 left-3 rounded border border-border bg-bg-1/95 px-3 py-1.5 text-xs text-fg-2">{t("Loading review updates. The previous content remains visible.")}</div>
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
