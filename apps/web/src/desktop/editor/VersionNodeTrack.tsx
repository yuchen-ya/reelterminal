import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { workspaceManager, type ProjectNodeSummary } from "../../services/workspace-manager";
import { previewSession } from "../../services/preview-session";
import { useUIStore } from "../../stores/ui-store";
import { toast, useNotificationStore } from "../../stores/notification-store";
import { createHistoryFrameRenderer } from "../../components/editor/preview/history-frame-renderer";
import { activateHistoryComparison } from "../../components/editor/preview/ReferenceComparisonPanel";
const PALETTE = ["#69aaa0", "#b493bc", "#c59b67", "#779ac5", "#a7ad73", "#c7838c", "#8fa3af", "#aa987b"];
const ROW_HEIGHT = 30;
const feedback = "transition-[color,background-color,opacity] duration-150 motion-reduce:transition-none";

/** Identity colors survive rename, reordering and reopening; parent and child differ. */
function nodeColors(nodes: readonly ProjectNodeSummary[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const indices = new Map<string, number>();
  const colorIndex = (node: ProjectNodeSummary): number => {
    if (indices.has(node.id)) return indices.get(node.id)!;
    let index = [...node.id].reduce((value, character) => value * 31 + character.charCodeAt(0) >>> 0, 0) % PALETTE.length;
    const parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    if (parent && index === colorIndex(parent)) index = (index + 1) % PALETTE.length;
    indices.set(node.id, index);
    return index;
  };
  return new Map(nodes.map(node => [node.id, PALETTE[colorIndex(node)]!]));
}

/** Inspector archive browser: read summaries until the user asks to preview. */
export function VersionNodeTrack({
  projectId,
  workspaceId,
  active = true,
  onClose
}: {
  projectId?: string;
  workspaceId?: string;
  active?: boolean;
  onClose?: () => void;
} = {}) {
  const {
    t
  } = useTranslation();
  const snapshot = useSyncExternalStore(workspaceManager.subscribe, workspaceManager.getSnapshot);
  const preview = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const focusRequest = useUIStore(state => state.archiveFocusRequest);
  const id = projectId ?? snapshot.activeProjectId;
  const editId = workspaceId ?? snapshot.activeWorkspaceId;
  const workspace = snapshot.workspaces.find(entry => entry.id === editId);
  const nodes = useMemo(() => snapshot.nodes.filter(node => node.projectId === id && node.recycledAt === undefined).sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)), [snapshot.nodes, id]);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const colors = useMemo(() => nodeColors(snapshot.nodes.filter(node => node.projectId === id)), [snapshot.nodes, id]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [rename, setRename] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(focusRequest);
  const wasActive = useRef(false);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const base = workspace?.baseNodeId ?? null;
  const currentLine = useMemo(() => {
    const lineage = new Set<string>();
    let node = base ? byId.get(base) : nodes[0];
    while (node) {
      lineage.add(node.id);
      node = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    }
    return lineage;
  }, [base, byId, nodes]);
  const roots = nodes.filter(node => !currentLine.has(node.id) && (!node.parentNodeId || currentLine.has(node.parentNodeId) || !byId.has(node.parentNodeId)));
  const laneFor = (node: ProjectNodeSummary): number => {
    if (currentLine.has(node.id)) return 0;
    let cursor = node;
    while (cursor.parentNodeId && byId.has(cursor.parentNodeId) && !currentLine.has(cursor.parentNodeId)) cursor = byId.get(cursor.parentNodeId)!;
    return 1 + Math.max(0, roots.findIndex(root => root.id === cursor.id)) % 3;
  };
  const descendantIds = (rootId: string) => nodes.filter(node => {
    let cursor = node;
    while (cursor.parentNodeId && byId.has(cursor.parentNodeId)) {
      if (cursor.parentNodeId === rootId) return true;
      cursor = byId.get(cursor.parentNodeId)!;
    }
    return false;
  }).map(node => node.id);
  const hiddenIds = new Set([...folded].flatMap(descendantIds));
  const visible = nodes.filter(node => !hiddenIds.has(node.id));
  const rowIndex = new Map(visible.map((node, index) => [node.id, index]));
  useEffect(() => {
    const locateCurrent = active && (!wasActive.current || previousFocus.current !== focusRequest);
    wasActive.current = active;
    previousFocus.current = focusRequest;
    if (!locateCurrent) return;
    requestAnimationFrame(() => listRef.current?.querySelector('[data-base="true"]')?.scrollIntoView({
      block: "nearest"
    }));
  }, [active, focusRequest, base]);
  useEffect(() => {
    if (!active) {
      setMenu(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const expandedMenu = listRef.current?.querySelector<HTMLDetailsElement>("details[open]");
      if (event.key !== "Escape" || !menu && rename === null && !expandedMenu) return;
      event.preventDefault();
      event.stopPropagation();
      if (expandedMenu) expandedMenu.open = false;
      setMenu(null);
      setRename(null);
    };
    const dismiss = () => setMenu(null);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [active, menu, rename]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const previewNode = (nodeId: string) => {
    setSelectedId(nodeId);
    setRename(null);
    setMenu(null);
    void perform(() => previewSession.enter({
      kind: "node",
      nodeId
    }));
  };
  const removeNode = (nodeId: string) => void perform(async () => {
    setMenu(null);
    if (previewSession.getSnapshot().info?.nodeId === nodeId) await previewSession.exit();
    await workspaceManager.deleteNode({
      projectId: id!,
      nodeId
    });
    const notificationId = useNotificationStore.getState().addNotification({
      type: "info",
      title: t("versioning.deletedToast"),
      duration: 6000,
      onClickLabel: t("versioning.deleteUndo"),
      onClick: () => {
        void perform(async () => {
          await workspaceManager.restoreDeletedNode({
            projectId: id!,
            nodeId
          });
        });
        useNotificationStore.getState().removeNotification(notificationId);
      }
    });
  });
  const adopt = (nodeId: string) => void perform(async () => {
    setMenu(null);
    await previewSession.enter({
      kind: "node",
      nodeId
    });
    await previewSession.adopt();
  });
  const commitRename = () => {
    if (!selected || !rename?.trim()) return;
    void perform(async () => {
      await workspaceManager.renameNode({
        projectId: id!,
        nodeId: selected.id,
        name: rename.trim()
      });
      setRename(null);
    });
  };
  const compare = () => void perform(async () => {
    if (previewSession.getSnapshot().active) await previewSession.exit();
    const node = await workspaceManager.getNode(id!, selected!.id);
    if (!node) throw new Error(t("versioning.failed"));
    const renderer = await createHistoryFrameRenderer(id!, node);
    const target = workspaceManager.getActiveTarget();
    if (target?.projectId !== id || target.workspaceId !== editId) {
      renderer.dispose();
      return;
    }
    activateHistoryComparison({
      projectId: id!,
      nodeId: node.id,
      name: node.name,
      createdAt: node.createdAt,
      durationSec: renderer.durationSec,
      width: renderer.width,
      height: renderer.height,
      renderer
    });
  });
  const save = () => void perform(async () => {
    const result = await workspaceManager.saveNode({
      target: {
        projectId: id!,
        workspaceId: editId!
      }
    });
    setSelectedId(result.node.id);
    setFolded(new Set());
    toast.success(t(result.replayed ? "versioning.alreadyRetained" : "versioning.retainSuccess", {
      name: result.node.name
    }));
    const target = workspaceManager.getActiveTarget();
    if (target?.projectId === id && target.workspaceId === editId) useUIStore.getState().showCurrentArchive();
  });
  const menuActions = (nodeId: string, contextMenu = false) => <>
    <button role="menuitem" data-testid={contextMenu ? "version-menu-preview" : undefined} onClick={() => previewNode(nodeId)}>{t("versioning.menuPreview")}</button>
    <button role="menuitem" data-testid={contextMenu ? "version-menu-rename" : undefined} onClick={() => {
      setSelectedId(nodeId);
      setRename(byId.get(nodeId)!.name);
      setMenu(null);
    }}>{t("versioning.menuRename")}</button>
    <button role="menuitem" data-testid={contextMenu ? "version-menu-adopt" : undefined} onClick={() => adopt(nodeId)}>{t("versioning.menuAdopt")}</button>
    <button role="menuitem" data-testid={contextMenu ? "version-menu-delete" : undefined} className="text-destructive" onClick={() => removeNode(nodeId)}>{t("versioning.menuDelete")}</button>
  </>;
  if (!id || !editId) return null;
  return <section aria-label={t("versioning.trackLabel")} data-testid="version-track" className="archive-browser flex h-full min-h-0 flex-col text-xs text-fg">
    <header className="shrink-0 space-y-2 border-b border-border p-3">
      <div className="flex items-center justify-between gap-2"><h2 className="font-medium">{t("versioning.trackLabel")}</h2>
        <div className="flex items-center gap-1"><button type="button" data-testid="create-save-point" disabled={busy} onClick={save} className={`rounded border border-border px-2 py-1 text-fg-2 hover:bg-hover ${feedback}`}>{t("versioning.retainMenu")}</button>
        {onClose ? <button type="button" aria-label={t("desktopInspector.close")} data-testid="close-archives" onClick={onClose} className="h-6 w-6 rounded text-fg-3 hover:bg-hover hover:text-fg">×</button> : null}</div></div>
      {preview.active ? <p className="leading-relaxed text-fg-2">{t("versioning.previewSaveTarget")}</p> : null}
      {base && !byId.has(base) ? <p data-testid="current-edit-endpoint" className="text-fg-2">{t("versioning.recycledBase")}</p> : workspace?.dirty && nodes.length > 0 ? <p className="text-fg-2">{t("versioning.newEdits")}</p> : null}
    </header>
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar">
      {nodes.length === 0 ? <p className="px-3 py-6 leading-relaxed text-fg-2">{t("versioning.emptyArchives")}</p> : <div className="relative">
        <svg aria-hidden className="pointer-events-none absolute left-0 top-0 text-border-strong" width="68" height={visible.length * ROW_HEIGHT}>
          {visible.map(node => {
            const parent = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
            if (!parent || !rowIndex.has(parent.id)) return null;
            const x = 12 + laneFor(node) * 14,
              px = 12 + laneFor(parent) * 14;
            const y = rowIndex.get(node.id)! * ROW_HEIGHT + ROW_HEIGHT / 2,
              py = rowIndex.get(parent.id)! * ROW_HEIGHT + ROW_HEIGHT / 2;
            return <path key={node.id} data-parent-id={parent.id} data-child-id={node.id} d={`M ${x} ${y} V ${py - 8} Q ${x} ${py} ${px} ${py}`} fill="none" stroke={colors.get(node.id)} strokeWidth="1.25" opacity="0.7" />;
          })}
        </svg>
        {visible.map(node => {
          const selectedRow = node.id === selectedId,
            current = node.id === base,
            previewing = preview.active && preview.info?.nodeId === node.id;
          const trial = node.sourceWorkspaceKind === "trial";
          const children = currentLine.has(node.id) ? [] : descendantIds(node.id);
          return <div key={node.id} className="relative flex h-[30px] items-center">
            <button type="button" data-testid={`version-node-${node.id}`} data-base={current ? "true" : undefined} aria-pressed={selectedRow} aria-label={node.name} disabled={busy} className={`flex h-full min-w-0 flex-1 items-center text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg-3 hover:bg-hover ${selectedRow ? "bg-bg-2" : ""} ${feedback}`} onClick={() => {
              setSelectedId(node.id);
              setRename(null);
            }} onDoubleClick={() => previewNode(node.id)} onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                previewNode(node.id);
              }
              if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  nodeId: node.id,
                  x: rect.left,
                  y: rect.bottom
                });
              }
            }} onContextMenu={event => {
              event.preventDefault();
              setSelectedId(node.id);
              setRename(null);
              setMenu({
                nodeId: node.id,
                x: event.clientX,
                y: event.clientY
              });
            }}>
              <span className="relative h-full w-[68px] shrink-0" aria-hidden><span style={{
                  left: 8 + laneFor(node) * 14,
                top: 11,
                  backgroundColor: trial ? "var(--bg-1)" : colors.get(node.id),
                  borderColor: colors.get(node.id),
                  opacity: selectedRow || current || previewing ? 1 : 0.7
                }} className={`absolute h-2 w-2 transition-opacity duration-200 motion-reduce:transition-none ${trial ? "rotate-45 rounded-[1px] border" : "rounded-full"} ${current ? "outline outline-1 outline-offset-2 outline-fg-2" : ""} ${previewing ? "outline outline-1 outline-offset-2 outline-dashed outline-fg" : ""}`} /></span>
              <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
              <span className="archive-date ml-2 mr-2 shrink-0 text-[10px] text-fg-3">{new Date(node.createdAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</span>
              {current || previewing ? <span className="ml-1 mr-2 shrink-0 text-[10px] text-fg-2">{t(previewing ? "versioning.previewingShort" : "versioning.current")}</span> : null}
              {trial ? <span className="mr-2 shrink-0 text-[10px] text-fg-3">{t("versioning.trialDefault")}</span> : null}
            </button>
            {!currentLine.has(node.id) && children.length > 2 ? <button type="button" aria-expanded={!folded.has(node.id)} title={t("versioning.nodeCount", {
              count: children.length
            })} className="mr-2 rounded px-1 text-fg-3 hover:text-fg" onClick={() => setFolded(currentFolded => {
              const next = new Set(currentFolded);
              if (next.has(node.id)) next.delete(node.id);else next.add(node.id);
              return next;
            })}>{folded.has(node.id) ? `+${children.length}` : "−"}</button> : null}
          </div>;
        })}
      </div>}
      {selected ? <div className="space-y-2 border-t border-border p-2" data-testid="archive-details">
        {rename !== null ? <div className="flex gap-1"><input data-testid="version-rename-input" aria-label={t("versioning.renameLabel")} autoFocus className="min-w-0 flex-1 rounded border border-border bg-bg-2 px-2 py-1" value={rename} onChange={event => setRename(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter") commitRename();
          }} />
          <button type="button" disabled={!rename.trim() || busy} onClick={commitRename}>{t("versioning.menuRename")}</button></div> : <h3 className="break-words font-medium">{selected.name}</h3>}
        <p className="text-fg-3">{new Date(selected.createdAt).toLocaleString()}</p>
        {selected.summary ? <p className="whitespace-pre-wrap break-words leading-relaxed text-fg-2">{selected.summary}</p> : null}
        {selected.missingDependencies.length ? <p className="leading-relaxed text-status-warning">{t("versioning.missing")}</p> : null}
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => previewNode(selected.id)} className={`rounded border border-border px-2 py-1.5 hover:bg-hover ${feedback}`}>{t("versioning.menuPreview")}</button>
          <button type="button" disabled={busy} onClick={compare} className={`rounded border border-border px-2 py-1.5 text-fg-2 hover:bg-hover ${feedback}`}>{t("versioning.compareCurrent")}</button>
          <details><summary className="cursor-pointer rounded px-2 py-1.5 text-fg-2 hover:bg-hover">{t("versioning.more")}</summary><div role="menu" className="archive-menu mt-1 rounded border border-border bg-bg-2 p-1">{menuActions(selected.id)}</div></details></div>
      </div> : null}
    </div>
    {menu ? createPortal(<div role="menu" data-testid="version-node-menu" className="reelterminal-desktop archive-menu fixed z-[var(--z-popover)] w-52 rounded-md border border-border bg-bg-1 p-1 text-xs text-fg shadow-md" style={{
      left: Math.max(4, Math.min(menu.x, window.innerWidth - 216)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - 160))
    }} onPointerDown={event => event.stopPropagation()}>{menuActions(menu.nodeId, true)}</div>, document.body) : null}
  </section>;
}
