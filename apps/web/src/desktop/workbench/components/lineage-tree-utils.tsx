import type { JSX } from "react";
import {
  Database,
  FileText,
  Film,
  Image as ImageIcon,
} from "lucide-react";
import type { WorkbenchContentType, WorkbenchItemView } from "../types";

export interface WorkbenchLineageNode {
  readonly item: WorkbenchItemView;
  children: WorkbenchLineageNode[];
}

export interface WorkbenchLineageGroup {
  readonly id: string;
  readonly baseName: string;
  readonly isUngrouped: boolean;
  roots: WorkbenchLineageNode[];
}

export interface WorkbenchLineageGroupOptions {
  readonly ungroupedId: string;
  readonly ungroupedLabel: string;
}

/** Group visible items by their source and connect only real parent references. */
export function buildWorkbenchLineageGroups(
  items: readonly WorkbenchItemView[],
  options: WorkbenchLineageGroupOptions,
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
        ? item.lineage.upstreamSourceNode || item.lineage.upstreamGroupTitle || groupId
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
    active.delete(entry.item.id);
  };
  groups.forEach((group) => group.roots.forEach(visit));
  entries.forEach((entry, id) => {
    if (visited.has(id)) return;
    const group = groupOfItem.get(id);
    if (group) group.roots.push(entry);
    visit(entry);
  });

  return Array.from(groups.values()).sort((a, b) => {
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
} {
  switch (status) {
    case "pending":
      return { label: "待审", className: "text-fg-2" };
    case "kept":
      return { label: "保留", className: "text-accent" };
    case "modified":
      return { label: "已改", className: "text-status-info" };
    case "rework":
      return { label: "返工", className: "text-status-warning" };
    case "discarded":
      return { label: "丢弃", className: "text-status-error" };
  }
}
