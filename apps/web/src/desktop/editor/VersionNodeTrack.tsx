import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  workspaceManager,
  type ProjectNodeSummary,
  type WorkspaceSummary,
} from "../../services/workspace-manager";
import { previewSession } from "../../services/preview-session";
import { toast, useNotificationStore } from "../../stores/notification-store";

/**
 * Compact horizontal version track (docs/VERSION-NODES-UX.md 默认界面).
 *
 * One main line of small dots (oldest left, newest right) connected by a thin,
 * dimmer line; off-mainline branches hang below their anchor in a single
 * compact secondary level, with deeper subtrees folded behind a toggle
 * indicator. Hover and focus show summaries only — never a snapshot load.
 * States are distinguished by shape and ring (base = filled accent + ring,
 * previewed = rotated square + dashed outline, selected = faint ring), never
 * by brightness alone. The track renders nothing while the project has no
 * versions and no trial plans.
 */

interface NodeMenuState {
  nodeId: string;
  x: number;
  y: number;
}

interface RenameState {
  nodeId: string;
  value: string;
  error: boolean;
}

interface TipState {
  key: string;
  anchor: { left: number; top: number; width: number };
  title: string;
  meta: string;
  detail?: string;
  warning?: string;
}

interface BranchColumn {
  main: ProjectNodeSummary;
  branches: ProjectNodeSummary[];
}

/** Ancestry chain of `start` (root first). Cycle-safe. */
function ancestryChain(
  start: ProjectNodeSummary,
  byId: Map<string, ProjectNodeSummary>,
): ProjectNodeSummary[] {
  const chain: ProjectNodeSummary[] = [];
  const seen = new Set<string>();
  let current: ProjectNodeSummary | undefined = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentNodeId ? byId.get(current.parentNodeId) : undefined;
  }
  return chain.reverse();
}

function descendantsOf(
  rootId: string,
  childrenOf: Map<string, ProjectNodeSummary[]>,
): ProjectNodeSummary[] {
  const out: ProjectNodeSummary[] = [];
  const queue = [...(childrenOf.get(rootId) ?? [])];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    queue.push(...(childrenOf.get(node.id) ?? []));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

interface TrackLayout {
  columns: BranchColumn[];
  /** Off-mainline nodes whose visible lineage never reaches the main chain. */
  orphans: ProjectNodeSummary[];
}

function buildTrackLayout(
  nodes: readonly ProjectNodeSummary[],
  baseNodeId: string | null | undefined,
): TrackLayout {
  const ordered = [...nodes].sort((a, b) => a.createdAt - b.createdAt);
  if (ordered.length === 0) return { columns: [], orphans: [] };
  const byId = new Map(ordered.map((node) => [node.id, node]));

  // Main line: the active workspace's ancestry chain. When the base reference
  // is absent or recycled, walk from the most recent node instead.
  const start = (baseNodeId ? byId.get(baseNodeId) : undefined) ?? ordered[ordered.length - 1];
  const chain = ancestryChain(start, byId);
  const chainIds = new Set(chain.map((node) => node.id));

  const childrenOf = new Map<string, ProjectNodeSummary[]>();
  for (const node of ordered) {
    if (!node.parentNodeId) continue;
    const siblings = childrenOf.get(node.parentNodeId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentNodeId, siblings);
  }

  // Level-1 branch roots: off-chain nodes whose parent sits on the main
  // chain. Their deeper descendants stay folded behind the root's indicator.
  const branchRoots = new Map<string, ProjectNodeSummary>();
  const orphans: ProjectNodeSummary[] = [];
  for (const node of ordered) {
    if (chainIds.has(node.id)) continue;
    let branchRoot: ProjectNodeSummary | undefined;
    let cursor: ProjectNodeSummary | undefined = node;
    const walked = new Set<string>();
    while (cursor && !walked.has(cursor.id)) {
      walked.add(cursor.id);
      const parent: ProjectNodeSummary | undefined = cursor.parentNodeId
        ? byId.get(cursor.parentNodeId)
        : undefined;
      if (parent && chainIds.has(parent.id)) {
        branchRoot = cursor;
        break;
      }
      if (!parent) break;
      cursor = parent;
    }
    if (!branchRoot) {
      orphans.push(node);
      continue;
    }
    branchRoots.set(branchRoot.id, branchRoot);
  }

  const branchesByAnchor = new Map<string, ProjectNodeSummary[]>();
  for (const root of branchRoots.values()) {
    const anchorId = root.parentNodeId!;
    const group = branchesByAnchor.get(anchorId) ?? [];
    group.push(root);
    branchesByAnchor.set(anchorId, group);
  }

  const columns: BranchColumn[] = chain.map((node) => ({
    main: node,
    branches: (branchesByAnchor.get(node.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
  }));

  return { columns, orphans: orphans.sort((a, b) => a.createdAt - b.createdAt) };
}

const STATE_TRANSITION =
  "transition-[color,opacity,box-shadow] duration-200 ease-out motion-reduce:transition-none";

const HIT_AREA_CLASSES = [
  "grid h-7 w-7 shrink-0 place-items-center rounded-full outline-none",
  "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
  "focus-visible:ring-1 focus-visible:ring-fg-2",
].join(" ");

/** Width-collapse placeholder so a deleted dot folds away smoothly. */
function CollapsingUnit({ nodeId, onCollapsed }: { nodeId: string; onCollapsed: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const callbackRef = useRef(onCollapsed);
  callbackRef.current = onCollapsed;
  const finishedRef = useRef(false);
  useEffect(() => {
    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      callbackRef.current(nodeId);
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const raf = requestAnimationFrame(() => setCollapsed(true));
    const timer = window.setTimeout(finish, 240);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [nodeId]);
  return (
    <div className="flex shrink-0 flex-col">
      <div className="flex h-7 items-center">
        <span
          aria-hidden
          data-testid="version-node-collapsing"
          className={`pointer-events-none transition-all duration-200 ease-out motion-reduce:transition-none ${
            collapsed ? "w-0 opacity-0" : "w-7 opacity-100"
          }`}
        />
      </div>
    </div>
  );
}

export function VersionNodeTrack() {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(workspaceManager.subscribe, workspaceManager.getSnapshot);
  const preview = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<NodeMenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [renameShake, setRenameShake] = useState(false);
  const [sheetNodeId, setSheetNodeId] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(() => new Set());
  const [collapsingIds, setCollapsingIds] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const seenNodeIdsRef = useRef<Set<string> | null>(null);
  const lastFocusRef = useRef<{ workspaceId: string | null; baseNodeId: string | null } | null>(null);

  const activeProjectId = snapshot.activeProjectId;
  const activeWorkspace = snapshot.workspaces.find((entry) => entry.id === snapshot.activeWorkspaceId);
  const projectNodes = useMemo(
    () =>
      activeProjectId
        ? snapshot.nodes
            .filter((node) => node.projectId === activeProjectId && node.recycledAt === undefined)
            .sort((a, b) => a.createdAt - b.createdAt)
        : [],
    [snapshot.nodes, activeProjectId],
  );
  const projectTrials = useMemo(
    () =>
      activeProjectId
        ? snapshot.workspaces.filter(
            (workspace) => workspace.projectId === activeProjectId && workspace.kind === "trial",
          )
        : [],
    [snapshot.workspaces, activeProjectId],
  );
  const baseNodeId = activeWorkspace?.baseNodeId ?? null;
  /** Base reference points outside the visible list: the node was recycled. */
  const baseRecycled = baseNodeId !== null && !projectNodes.some((node) => node.id === baseNodeId);
  const previewedNodeId = preview.active ? preview.info?.nodeId ?? null : null;
  const previewedWorkspaceId = preview.active ? preview.info?.workspaceId ?? null : null;

  // Node appear/collapse bookkeeping: fresh ids fade in on the next paint,
  // removed ids fold away via a collapsing placeholder.
  const seenIds = seenNodeIdsRef.current;
  const freshIds = useMemo(
    () =>
      seenIds
        ? new Set(projectNodes.filter((node) => !seenIds.has(node.id)).map((node) => node.id))
        : new Set<string>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectNodes],
  );
  useEffect(() => {
    const previous = seenNodeIdsRef.current;
    seenNodeIdsRef.current = new Set(projectNodes.map((node) => node.id));
    if (!previous) return;
    const gone = [...previous].filter((id) => !projectNodes.some((node) => node.id === id));
    if (gone.length > 0) {
      setCollapsingIds((current) => [...current, ...gone.filter((id) => !current.includes(id))]);
    }
  }, [projectNodes]);

  const dismissCollapsing = useCallback((id: string) => {
    setCollapsingIds((current) => current.filter((entry) => entry !== id));
  }, []);

  // Auto-scroll to the current node only when the edit target itself moved
  // (workspace switch or a newly retained version), never on background updates.
  useEffect(() => {
    const key = { workspaceId: snapshot.activeWorkspaceId, baseNodeId };
    const previous = lastFocusRef.current;
    lastFocusRef.current = key;
    if (!previous) return;
    if (previous.workspaceId === key.workspaceId && previous.baseNodeId === key.baseNodeId) return;
    scrollRef.current
      ?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        inline: "center",
        block: "nearest",
      });
  }, [snapshot.activeWorkspaceId, baseNodeId]);

  const layout = useMemo(() => buildTrackLayout(projectNodes, baseNodeId), [projectNodes, baseNodeId]);

  const byId = useMemo(() => new Map(projectNodes.map((node) => [node.id, node])), [projectNodes]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, ProjectNodeSummary[]>();
    for (const node of projectNodes) {
      if (!node.parentNodeId) continue;
      const siblings = map.get(node.parentNodeId) ?? [];
      siblings.push(node);
      map.set(node.parentNodeId, siblings);
    }
    return map;
  }, [projectNodes]);
  const chainIds = useMemo(
    () => new Set(layout.columns.map((column) => column.main.id)),
    [layout],
  );

  useEffect(() => {
    void workspaceManager.initialize().catch(() => {
      // Initialization failures surface via the bootstrap gate; the track
      // simply stays empty until the snapshot populates.
    });
  }, []);

  // The menu / rename / sheet own Escape (capture) so page-level shortcut
  // handlers do not act while they are open.
  useEffect(() => {
    if (!menu && !rename && !sheetNodeId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      if (rename) setRename(null);
      else if (sheetNodeId) setSheetNodeId(null);
      else setMenu(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [menu, rename, sheetNodeId]);

  useEffect(() => {
    if (!menu && !sheetNodeId) return;
    const close = () => {
      setMenu(null);
      setSheetNodeId(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu, sheetNodeId]);

  const showTip = useCallback(
    (
      key: string,
      element: HTMLElement,
      title: string,
      meta: string,
      detail?: string,
      warning?: string,
    ) => {
      const rect = element.getBoundingClientRect();
      setTip({ key, anchor: { left: rect.left, top: rect.top, width: rect.width }, title, meta, detail, warning });
    },
    [],
  );

  const nodeTip = useCallback(
    (node: ProjectNodeSummary, element: HTMLElement) => {
      showTip(
        node.id,
        element,
        node.name,
        new Date(node.createdAt).toLocaleString(),
        node.summary || undefined,
        node.missingDependencies.length > 0 ? t("versioning.missing") : undefined,
      );
    },
    [showTip, t],
  );

  const trialTip = useCallback(
    (workspace: WorkspaceSummary, element: HTMLElement) => {
      showTip(
        `trial:${workspace.id}`,
        element,
        t("versioning.agentTrial"),
        workspace.name,
        t("versioning.agentTrialHint"),
      );
    },
    [showTip, t],
  );

  const hideTip = useCallback(() => setTip(null), []);

  const isCoarsePointer = useMemo(
    () => window.matchMedia?.("(pointer: coarse)")?.matches ?? false,
    [],
  );

  const previewNode = useCallback(
    (nodeId: string) => {
      setSelectedId(nodeId);
      setMenu(null);
      setSheetNodeId(null);
      void previewSession.enter({ kind: "node", nodeId }).catch((error: unknown) => {
        toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
      });
    },
    [t],
  );

  const previewTrial = useCallback(
    (workspaceId: string) => {
      setMenu(null);
      setSheetNodeId(null);
      void previewSession.enter({ kind: "workspace", workspaceId }).catch((error: unknown) => {
        toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
      });
    },
    [t],
  );

  const adoptNode = useCallback(
    async (nodeId: string) => {
      setMenu(null);
      setSheetNodeId(null);
      try {
        await previewSession.enter({ kind: "node", nodeId });
        await previewSession.adopt();
      } catch (error) {
        toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
      }
    },
    [t],
  );

  const deleteNode = useCallback(
    async (nodeId: string) => {
      setMenu(null);
      setSheetNodeId(null);
      if (!activeProjectId) return;
      try {
        // Deleting the previewed node returns to current editing first.
        const previewState = previewSession.getSnapshot();
        if (previewState.active && previewState.info?.nodeId === nodeId) {
          await previewSession.exit();
        }
        await workspaceManager.deleteNode({ projectId: activeProjectId, nodeId });
        const notificationId = useNotificationStore.getState().addNotification({
          type: "info",
          title: t("versioning.deletedToast"),
          duration: 6000,
          onClickLabel: t("versioning.deleteUndo"),
          onClick: () => {
            void workspaceManager
              .restoreDeletedNode({ projectId: activeProjectId, nodeId })
              .catch((error: unknown) => {
                toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
              });
            useNotificationStore.getState().removeNotification(notificationId);
          },
        });
      } catch (error) {
        toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
      }
    },
    [activeProjectId, t],
  );

  const commitRename = useCallback(async () => {
    if (!rename || !activeProjectId) return;
    const name = rename.value.trim();
    if (!name) {
      // Empty name: error style only, never a request.
      setRename((current) => (current ? { ...current, error: true } : current));
      setRenameShake(true);
      window.setTimeout(() => setRenameShake(false), 200);
      return;
    }
    try {
      await workspaceManager.renameNode({ projectId: activeProjectId, nodeId: rename.nodeId, name });
      setRename(null);
      setMenu(null);
    } catch (error) {
      toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
    }
  }, [rename, activeProjectId, t]);

  const openMenu = useCallback((nodeId: string, x: number, y: number) => {
    setRename(null);
    setMenu({ nodeId, x, y });
  }, []);

  if (!activeProjectId || (projectNodes.length === 0 && projectTrials.length === 0)) {
    return null;
  }

  const renderDot = (node: ProjectNodeSummary, depth: number) => {
    const isBase = node.id === baseNodeId;
    const isPreviewed = previewedNodeId === node.id;
    const isSelected = selectedId === node.id;
    return (
      <button
        key={node.id}
        type="button"
        data-testid={`version-node-${node.id}`}
        data-base={isBase ? "true" : undefined}
        data-current={isBase ? "true" : undefined}
        aria-pressed={isSelected}
        aria-label={node.name}
        className={HIT_AREA_CLASSES}
        onClick={() => {
          if (isCoarsePointer) {
            // Touch: tap opens the info + action sheet; key actions must not
            // hide behind hover or right-click.
            setSheetNodeId(node.id);
            return;
          }
          setSelectedId(node.id);
        }}
        onDoubleClick={() => previewNode(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            previewNode(node.id);
            return;
          }
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(node.id, rect.left, rect.bottom);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(node.id, event.clientX, event.clientY);
        }}
        onMouseEnter={(event) => nodeTip(node, event.currentTarget)}
        onMouseLeave={hideTip}
        onFocus={(event) => nodeTip(node, event.currentTarget)}
        onBlur={hideTip}
      >
        <span
          aria-hidden
          className={[
            STATE_TRANSITION,
            "block h-2 w-2",
            isPreviewed ? "rotate-45 rounded-[2px]" : "rounded-full",
            isBase ? "bg-accent ring-1 ring-accent" : "bg-fg-3 group-hover:bg-fg-2",
            isSelected && !isBase ? "ring-1 ring-fg-2" : "",
            isPreviewed ? "outline outline-1 outline-dashed outline-fg-2" : "",
            depth > 1 ? "opacity-90" : "",
            freshIds.has(node.id) ? "animate-in fade-in duration-200 motion-reduce:animate-none" : "",
          ].join(" ")}
        />
      </button>
    );
  };

  const renderTrialDot = (workspace: WorkspaceSummary) => {
    const isPreviewed = previewedWorkspaceId === workspace.id && preview.info?.agentTrial === true;
    return (
      <button
        key={workspace.id}
        type="button"
        data-testid={`version-trial-${workspace.id}`}
        aria-label={t("versioning.agentTrial")}
        className={`group shrink-0 opacity-70 hover:opacity-100 ${STATE_TRANSITION} ${HIT_AREA_CLASSES}`}
        onDoubleClick={() => previewTrial(workspace.id)}
        onClick={() => {
          if (isCoarsePointer) previewTrial(workspace.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            previewTrial(workspace.id);
          }
        }}
        onMouseEnter={(event) => trialTip(workspace, event.currentTarget)}
        onMouseLeave={hideTip}
        onFocus={(event) => trialTip(workspace, event.currentTarget)}
        onBlur={hideTip}
      >
        <span
          aria-hidden
          className={[
            STATE_TRANSITION,
            "block h-2 w-2 rotate-45 rounded-[2px] border border-fg-2 bg-transparent",
            isPreviewed ? "outline outline-1 outline-dashed outline-fg-2" : "",
          ].join(" ")}
        />
      </button>
    );
  };

  const branchCell = (branch: ProjectNodeSummary): ReactNode => {
    const descendants = descendantsOf(branch.id, childrenOf).filter((node) => !chainIds.has(node.id));
    const expanded = expandedBranches.has(branch.id);
    return (
      <div key={branch.id} className="flex shrink-0 items-center">
        <span aria-hidden className="h-px w-2 shrink-0 bg-border" />
        {renderDot(branch, 1)}
        {expanded
          ? descendants.map((child) => (
              <div key={child.id} className="flex shrink-0 items-center">
                <span aria-hidden className="h-px w-2 shrink-0 bg-border" />
                {renderDot(child, 2)}
              </div>
            ))
          : null}
        {descendants.length > 0 ? (
          <button
            type="button"
            data-testid={`branch-fold-${branch.id}`}
            aria-expanded={expanded}
            aria-label={t("versioning.nodeCount", { count: descendants.length })}
            className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-fg-3 outline-none hover:text-fg-2 focus-visible:ring-1 focus-visible:ring-fg-2"
            onClick={() =>
              setExpandedBranches((current) => {
                const next = new Set(current);
                if (next.has(branch.id)) next.delete(branch.id);
                else next.add(branch.id);
                return next;
              })
            }
          >
            <span
              aria-hidden
              className={`block h-1.5 w-1.5 rounded-full border border-current ${STATE_TRANSITION}`}
            />
          </button>
        ) : null}
      </div>
    );
  };

  /** One vertical unit: main dot on the top line, its branch row below. */
  const renderUnit = (key: string, main: ReactNode, branchRow: ReactNode) => (
    <div key={key} className="flex shrink-0 flex-col items-center">
      <div className="flex h-7 items-center">{main}</div>
      {branchRow ? (
        <>
          <span aria-hidden className="h-1.5 w-px shrink-0 bg-border" />
          <div className="flex h-7 items-center">{branchRow}</div>
        </>
      ) : null}
    </div>
  );

  const connector = (
    <span aria-hidden className="h-px w-4 shrink-0 bg-border" />
  );
  /** Connectors align with the top (main) line of the taller unit columns. */
  const connectorUnit = (
    <div className="flex h-7 shrink-0 items-center self-start">{connector}</div>
  );

  const units: ReactNode[] = [];
  layout.columns.forEach((column, index) => {
    if (index > 0) units.push(<div key={`conn-${column.main.id}`}>{connectorUnit}</div>);
    const branchRow =
      column.branches.length > 0 ? <div className="flex items-center">{column.branches.map(branchCell)}</div> : null;
    units.push(renderUnit(column.main.id, renderDot(column.main, 0), branchRow));
  });
  if (layout.orphans.length > 0) {
    if (units.length > 0) units.push(<div key="conn-orphans">{connectorUnit}</div>);
    units.push(
      renderUnit(
        "orphans",
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border border-dashed border-border" />,
        <div className="flex items-center">
          {layout.orphans.map((node, index) => (
            <div key={node.id} className="flex shrink-0 items-center">
              {index > 0 ? <span aria-hidden className="h-px w-2 shrink-0 bg-border" /> : null}
              {renderDot(node, 1)}
            </div>
          ))}
        </div>,
      ),
    );
  }
  if (baseRecycled) {
    if (units.length > 0) units.push(<div key="conn-endpoint">{connectorUnit}</div>);
    units.push(
      <div key="endpoint" className="flex shrink-0 flex-col items-center">
        <div className="flex h-7 items-center">
          <span
            data-testid="current-edit-endpoint"
            data-current="true"
            className="flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-bg-2 px-2 text-[10px] text-fg-2"
          >
            {t("versioning.currentEndpoint")}
          </span>
        </div>
      </div>,
    );
  }
  projectTrials.forEach((workspace) => {
    units.push(
      <div key={`trial-${workspace.id}`} className="flex shrink-0 items-center pl-1">
        <span aria-hidden className="h-px w-2 shrink-0 border-t border-dashed border-border" />
        {renderTrialDot(workspace)}
      </div>,
    );
  });
  collapsingIds.forEach((id) => {
    units.push(<CollapsingUnit key={`collapse-${id}`} nodeId={id} onCollapsed={dismissCollapsing} />);
  });

  const menuNode = menu ? byId.get(menu.nodeId) : undefined;
  const sheetNode = sheetNodeId ? byId.get(sheetNodeId) : undefined;
  const hasBranches =
    layout.columns.some((column) => column.branches.length > 0) || layout.orphans.length > 0;

  return (
    <section
      aria-label={t("versioning.trackLabel")}
      data-testid="version-track"
      data-project-id={activeProjectId}
      data-workspace-id={activeWorkspace?.id}
      className="shrink-0 overflow-hidden border-b border-border bg-bg-1"
    >
      <div ref={scrollRef} className="overflow-x-auto">
        <div className={`flex min-w-max items-start px-2 ${hasBranches ? "py-1" : "h-9"}`}>
          {units}
        </div>
      </div>

      {/* Hover / focus tooltip: summaries only, never a snapshot load */}
      {tip
        ? createPortal(
            <div
              role="tooltip"
              data-testid="version-node-tooltip"
              style={tipStyle(tip.anchor)}
              className="pointer-events-none fixed z-[var(--z-popover)] w-64 rounded-md border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg shadow-md"
            >
              <p className="truncate font-medium">{tip.title}</p>
              <p className="text-fg-2">{tip.meta}</p>
              {tip.detail ? <p className="truncate text-fg-2">{tip.detail}</p> : null}
              {tip.warning ? <p className="font-medium text-amber-500">{tip.warning}</p> : null}
            </div>,
            document.body,
          )
        : null}

      {/* Node context menu: exactly four actions */}
      {menu && menuNode
        ? createPortal(
            <div
              role="menu"
              data-testid="version-node-menu"
              style={{ position: "fixed", left: menu.x, top: menu.y }}
              className="z-[var(--z-popover)] w-52 rounded-md border border-border bg-bg-1 py-1 text-xs shadow-lg"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {rename && rename.nodeId === menu.nodeId ? (
                <div className="px-2 py-1.5">
                  <style>{`@keyframes vnt-shake { 25% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }
@media (prefers-reduced-motion: reduce) { .vnt-shake { animation: none !important; } }`}</style>
                  <label className="block text-fg-2">
                    {t("versioning.renameLabel")}
                    <input
                      autoFocus
                      data-testid="version-rename-input"
                      aria-label={t("versioning.renameLabel")}
                      value={rename.value}
                      aria-invalid={rename.error}
                      onChange={(event) =>
                        setRename({ nodeId: rename.nodeId, value: event.target.value, error: false })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitRename();
                        }
                      }}
                      className={`mt-1 w-full rounded border bg-bg-2 px-2 py-1 text-fg outline-none ${
                        rename.error ? "border-destructive" : "border-border focus:border-accent"
                      } ${renameShake ? "vnt-shake" : ""}`}
                    />
                  </label>
                  <div className="mt-2 flex justify-end gap-1">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="version-rename-cancel"
                      className="rounded border border-border px-2 py-1 hover:bg-hover"
                      onClick={() => {
                        setRename(null);
                        setMenu(null);
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="version-rename-commit"
                      className="rounded bg-accent px-2 py-1 text-accent-fg hover:bg-accent-strong"
                      onClick={() => void commitRename()}
                    >
                      {t("versioning.menuRename")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="version-menu-preview"
                    className="block w-full px-3 py-1.5 text-left hover:bg-hover"
                    onClick={() => previewNode(menu.nodeId)}
                  >
                    {t("versioning.menuPreview")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="version-menu-rename"
                    className="block w-full px-3 py-1.5 text-left hover:bg-hover"
                    onClick={() => setRename({ nodeId: menu.nodeId, value: menuNode.name, error: false })}
                  >
                    {t("versioning.menuRename")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="version-menu-adopt"
                    className="block w-full px-3 py-1.5 text-left hover:bg-hover"
                    onClick={() => void adoptNode(menu.nodeId)}
                  >
                    {t("versioning.menuAdopt")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="version-menu-delete"
                    className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-hover"
                    onClick={() => void deleteNode(menu.nodeId)}
                  >
                    {t("versioning.menuDelete")}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}

      {/* Touch action sheet: info header plus the same four actions */}
      {sheetNode
        ? createPortal(
            <div
              role="dialog"
              aria-label={sheetNode.name}
              data-testid="version-node-sheet"
              className="fixed inset-x-2 bottom-2 z-[var(--z-modal)] rounded-lg border border-border bg-bg-1 p-3 text-xs shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="font-medium text-fg">{sheetNode.name}</p>
              <p className="text-fg-2">{new Date(sheetNode.createdAt).toLocaleString()}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="version-sheet-preview"
                  className="rounded border border-border px-2 py-1.5 hover:bg-hover"
                  onClick={() => previewNode(sheetNode.id)}
                >
                  {t("versioning.menuPreview")}
                </button>
                <button
                  type="button"
                  data-testid="version-sheet-rename"
                  className="rounded border border-border px-2 py-1.5 hover:bg-hover"
                  onClick={() => {
                    const nodeId = sheetNode.id;
                    setSheetNodeId(null);
                    setMenu({ nodeId, x: Math.max(8, window.innerWidth / 2 - 104), y: Math.max(8, window.innerHeight / 2 - 60) });
                    setRename({ nodeId, value: sheetNode.name, error: false });
                  }}
                >
                  {t("versioning.menuRename")}
                </button>
                <button
                  type="button"
                  data-testid="version-sheet-adopt"
                  className="rounded border border-border px-2 py-1.5 hover:bg-hover"
                  onClick={() => void adoptNode(sheetNode.id)}
                >
                  {t("versioning.menuAdopt")}
                </button>
                <button
                  type="button"
                  data-testid="version-sheet-delete"
                  className="rounded border border-border px-2 py-1.5 text-destructive hover:bg-hover"
                  onClick={() => void deleteNode(sheetNode.id)}
                >
                  {t("versioning.menuDelete")}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function tipStyle(anchor: { left: number; top: number; width: number }): CSSProperties {
  return {
    position: "fixed",
    left: Math.max(4, anchor.left + anchor.width / 2 - 128),
    top: Math.max(4, anchor.top - 72),
    width: 256,
  };
}
