import { createContext, useContext } from "react";
import type { ReactNode, DragEvent } from "react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@reelterminal/ui";
import { MoreHorizontal } from "lucide-react";
import type { WorkbenchItemView } from "../types";

export type CollectionAction = "select" | "keep-pending" | "discard-pending" | "keep-all" | "discard-all" | "rework" | "retrieve" | "export";
export interface CollectionScope {
  readonly title: string;
  readonly items: readonly WorkbenchItemView[];
  readonly folder: boolean;
}
export interface CollectionInteraction {
  action: (action: CollectionAction, scope: CollectionScope) => void;
  prepareDrag?: (scope: CollectionScope) => void;
  drag?: (event: DragEvent, scope: CollectionScope) => void;
  selectedItems: readonly WorkbenchItemView[];
  busy: boolean;
}
export const CollectionInteractionContext = createContext<CollectionInteraction | null>(null);

/** One menu and drag contract shared by tree rows and collection cards. */
export function CollectionActions({ scope, children }: { scope: CollectionScope; children?: ReactNode }) {
  const interaction = useContext(CollectionInteractionContext);
  if (!interaction) return <>{children}</>;
  const pending = scope.items.filter(item => item.status === "pending").length;
  const processed = scope.items.length - pending;
  const options: { action: CollectionAction; label: string; count: number }[] = [
    { action: "select", label: "全选此范围", count: scope.items.length },
    { action: "keep-pending", label: "保留待审项", count: pending },
    { action: "discard-pending", label: "丢弃待审项", count: pending },
    { action: "rework", label: "批量返工…", count: scope.items.length },
    { action: "retrieve", label: "将已处理项恢复待审", count: processed },
    { action: "keep-all", label: "全部设为保留…", count: scope.items.length },
    { action: "discard-all", label: "全部设为丢弃…", count: scope.items.length },
    ...(interaction.drag ? [{ action: "export" as const, label: "导出此范围…", count: scope.items.length }] : []),
  ];
  const dragScope = !scope.folder && interaction.selectedItems.some(item => item.id === scope.items[0]?.id)
    ? { title: `所选 ${interaction.selectedItems.length} 项`, items: interaction.selectedItems, folder: false }
    : scope;
  const contents = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Label = context ? ContextMenuLabel : DropdownMenuLabel;
    return <>
      <Label>{scope.title} · {scope.items.length} 项 · 当前版本</Label>
      {options.map(option => <Item key={option.action} disabled={interaction.busy || option.count === 0}
        onSelect={() => interaction.action(option.action, scope)}>
        {option.label}（{option.count}）
      </Item>)}
    </>;
  };
  const menu = <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={`${scope.title}的操作`} title="更多操作（也可右键）"
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
        className="shrink-0 rounded p-1 text-fg-3 hover:bg-bg-3 hover:text-fg">
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent onClick={event => event.stopPropagation()}>{contents(false)}</DropdownMenuContent>
  </DropdownMenu>;
  if (!children) return menu;
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div className="relative min-w-0" draggable={!!interaction.drag && !interaction.busy}
        onPointerDown={event => { if (event.button === 0 && !(event.target as HTMLElement).closest("button,input,select,textarea")) interaction.prepareDrag?.(dragScope); }}
        onDragStart={event => { event.stopPropagation(); interaction.drag?.(event, dragScope); }}>
        <div className="pr-7">{children}</div>
        <div className="absolute right-0 top-0">{menu}</div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>{contents(true)}</ContextMenuContent>
  </ContextMenu>;
}
