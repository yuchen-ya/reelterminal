import type { JSX } from "react";
import {
  Database,
  FileText,
  Film,
  Image as ImageIcon,
} from "lucide-react";
import type {
  WorkbenchContentType,
  WorkbenchItemView,
  WorkbenchParentMode,
} from "../types";

export interface WorkbenchLineageNode {
  readonly item: WorkbenchItemView;
  children: WorkbenchLineageNode[];
  /** Present when this node has children: "board" (adaptive board, collapsed by default) or "category". */
  mode?: WorkbenchParentMode;
  updatedAt?: number;
}

export interface WorkbenchLineageGroup {
  readonly id: string;
  readonly baseName: string;
  readonly isUngrouped: boolean;
  roots: WorkbenchLineageNode[];
  /** Group-level parent mode: "board" (adaptive board, collapsed by default) or "category" (folder). */
  mode?: WorkbenchParentMode;
  updatedAt?: number;
}

export interface WorkbenchLineageGroupOptions {
  readonly ungroupedId: string;
  readonly ungroupedLabel: string;
}

/**
 * Infer parent container presentation mode ("board" vs "category") from explicit
 * backend fields (`groupMode` on item or lineage) or lightweight conventions
 * (`connectorEdgeLabel === "board"`, `userCategoryTags` containing `"board"`).
 */
export function inferParentModeFromItem(item: {
  readonly groupMode?: WorkbenchParentMode;
  readonly userCategoryTags?: readonly string[];
  readonly lineage?: {
    readonly groupMode?: WorkbenchParentMode;
    readonly connectorEdgeLabel?: string;
    readonly basedOnLabel?: string;
  };
}): WorkbenchParentMode | undefined {
  if (item.groupMode === "board" || item.groupMode === "category") {
    return item.groupMode;
  }
  const lineageMode = (
    item.lineage as { readonly groupMode?: WorkbenchParentMode } | undefined
  )?.groupMode;
  if (lineageMode === "board" || lineageMode === "category") {
    return lineageMode;
  }
  const edge = item.lineage?.connectorEdgeLabel?.toLowerCase();
  const base = item.lineage?.basedOnLabel?.toLowerCase();
  if (edge === "board" || base === "board") return "board";
  if (edge === "category" || base === "category") return "category";
  const tags = item.userCategoryTags ?? [];
  if (tags.some((t) => t === "board" || t === "@board")) return "board";
  if (tags.some((t) => t === "category" || t === "@category")) return "category";
  return undefined;
}

/** Collect all items inside a tree node (the node itself + all descendants in DFS order). */
export function collectSubtreeItems(
  node: WorkbenchLineageNode,
): WorkbenchItemView[] {
  const result: WorkbenchItemView[] = [node.item];
  for (const child of node.children) {
    result.push(...collectSubtreeItems(child));
  }
  return result;
}

/** Collect all items inside a lineage group in tree order. */
export function collectGroupItems(
  group: WorkbenchLineageGroup,
): WorkbenchItemView[] {
  const result: WorkbenchItemView[] = [];
  for (const root of group.roots) {
    result.push(...collectSubtreeItems(root));
  }
  return result;
}

/** Resolve an Agent-specified or lineage-linked comparison video/image item id. */
export function resolveItemCompareTargetId(
  item: WorkbenchItemView,
  batchItems: readonly WorkbenchItemView[],
): string | null {
  const explicit =
    item.compareWithItemId ??
    item.videoPayload?.compareWithItemId ??
    (
      item.lineage as
        | { readonly compareWithItemId?: string }
        | undefined
    )?.compareWithItemId;
  if (explicit && explicit !== item.id && batchItems.some((i) => i.id === explicit)) {
    return explicit;
  }
  const tagTarget = (item.userCategoryTags ?? [])
    .find((t) => t.startsWith("compare:") || t.startsWith("@compare:"))
    ?.replace(/^@?compare:/, "");
  if (tagTarget && tagTarget !== item.id && batchItems.some((i) => i.id === tagTarget)) {
    return tagTarget;
  }
  const parentId = item.lineage?.parentNodeId;
  if (parentId && parentId !== item.id) {
    const parent = batchItems.find((i) => i.id === parentId);
    if (parent && parent.type === item.type) {
      return parent.id;
    }
  }
  return null;
}

/** Group visible items by their source and connect only real parent references. */
export function buildWorkbenchLineageGroups(
  items: readonly WorkbenchItemView[],
  options: WorkbenchLineageGroupOptions = {
    ungroupedId: "__ungrouped__",
    ungroupedLabel: "本批内容",
  },
): WorkbenchLineageGroup[] {
  const entries = new Map<string, WorkbenchLineageNode>();
  for (const item of items) entries.set(item.id, { item, children: [] });

  const groups = new Map<string, WorkbenchLineageGroup>();
  const groupOfItem = new Map<string, WorkbenchLineageGroup>();
  const ensureGroup = (item: WorkbenchItemView): WorkbenchLineageGroup => {
    const groupId = item.lineage?.upstreamGroupId ?? options.ungroupedId;
    const existing = groups.get(groupId);
    if (existing) return existing;
    const group: WorkbenchLineageGroup = {
      id: groupId,
      baseName: item.lineage
        ? item.lineage.upstreamGroupTitle || item.lineage.upstreamSourceNode || groupId
        : options.ungroupedLabel,
      isUngrouped: !item.lineage,
      roots: [],
    };
    groups.set(groupId, group);
    return group;
  };

  entries.forEach((entry, id) => {
    const group = ensureGroup(entry.item);
    groupOfItem.set(id, group);
    const parentId = entry.item.lineage?.parentNodeId;
    const parent = parentId && parentId !== id ? entries.get(parentId) : undefined;
    if (parent) parent.children.push(entry);
    else group.roots.push(entry);
  });

  // Cycles have no natural root. Promote an unvisited member and remove the
  // back edge that closes the cycle so both tree renderers remain finite.
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (entry: WorkbenchLineageNode): void => {
    if (visited.has(entry.item.id)) return;
    visited.add(entry.item.id);
    active.add(entry.item.id);
    for (let index = 0; index < entry.children.length;) {
      const child = entry.children[index];
      if (active.has(child.item.id)) {
        entry.children.splice(index, 1);
        continue;
      }
      visit(child);
      index += 1;
    }
    if (entry.children.length > 0) {
      const explicitNodeMode =
        inferParentModeFromItem(entry.item) ??
        entry.children.map((c) => inferParentModeFromItem(c.item)).find(Boolean);
      entry.mode = explicitNodeMode ?? "board";
    }
    entry.updatedAt = Math.max(entry.item.updatedAt ?? 0, ...entry.children.map(child => child.updatedAt ?? 0));
    active.delete(entry.item.id);
  };
  groups.forEach((group) => group.roots.forEach(visit));
  entries.forEach((entry, id) => {
    if (visited.has(id)) return;
    const group = groupOfItem.get(id);
    if (group) group.roots.push(entry);
    visit(entry);
  });

  const sortParents = (nodes: WorkbenchLineageNode[]) => {
    const parents = nodes.filter(node => node.children.length > 0).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    let index = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].children.length > 0) nodes[i] = parents[index++];
      sortParents(nodes[i].children);
    }
  };
  groups.forEach((group) => {
    group.updatedAt = Math.max(0, ...group.roots.map(root => root.updatedAt ?? 0));
    sortParents(group.roots);
    if (group.isUngrouped || group.roots.some((r) => r.children.length > 0)) {
      group.mode = "category";
      return;
    }
    const allGroupItems = collectGroupItems(group);
    const explicitGroupMode = allGroupItems
      .map((item) => inferParentModeFromItem(item))
      .find(Boolean);
    group.mode = explicitGroupMode ?? "category";
  });

  return Array.from(groups.values()).sort((a, b) => {
    const modifiedOrder = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    if (modifiedOrder) return modifiedOrder;
    if (a.isUngrouped === b.isUngrouped) return 0;
    return a.isUngrouped ? 1 : -1;
  });
}

export function getWorkbenchTypeIcon(type: WorkbenchContentType): JSX.Element {
  switch (type) {
    case "model3d":
      return <span className="text-[10px] font-bold text-accent">3D</span>;
    case "image":
      return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-accent" />;
    case "text":
      return <FileText className="h-3.5 w-3.5 shrink-0 text-status-info" />;
    case "data":
      return <Database className="h-3.5 w-3.5 shrink-0 text-status-warning" />;
    case "video":
      return <Film className="h-3.5 w-3.5 shrink-0 text-status-error" />;
  }
}

export function getWorkbenchStatusView(status: WorkbenchItemView["status"]): {
  readonly label: string;
  readonly className: string;
  readonly dotClassName: string;
} {
  switch (status) {
    case "pending":
      return { label: "待审", className: "text-fg-2", dotClassName: "bg-accent" };
    case "kept":
      return { label: "保留", className: "text-accent", dotClassName: "bg-accent/70" };
    case "modified":
      return { label: "已改", className: "text-status-info", dotClassName: "bg-status-info" };
    case "rework":
      return { label: "返工", className: "text-status-warning", dotClassName: "bg-status-warning" };
    case "discarded":
      return { label: "丢弃", className: "text-status-error", dotClassName: "bg-status-error/70" };
  }
}
