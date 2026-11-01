import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
import { createContext, useContext } from "react";
import type { ReactNode, DragEvent } from "react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@reelterminal/ui";
import { FolderOutput, MoreHorizontal } from "lucide-react";
import type { WorkbenchItemView } from "../types";

export type CollectionAction = "select" | "keep-pending" | "discard-pending" | "keep-all" | "discard-all" | "rework" | "retrieve" | "export";
export interface CollectionScope {
  readonly title: string;
  readonly items: readonly WorkbenchItemView[];
  readonly folder: boolean;
  readonly rootItemId?: string;
  readonly placementGroupId?: string | null;
}
export interface CollectionInteraction {
  action: (action: CollectionAction, scope: CollectionScope) => void;
  prepareDrag?: (scope: CollectionScope) => void;
  drag?: (event: DragEvent, scope: CollectionScope) => void;
  selectedItems: readonly WorkbenchItemView[];
  busy: boolean;
  moveDrag?: (event: DragEvent, scope: CollectionScope) => void;
  drop?: (event: DragEvent, groupId: string | null, targetItemId?: string) => void;
  acceptsDrop?: (event: DragEvent) => boolean;
}
export const CollectionInteractionContext = createContext<CollectionInteraction | null>(null);

/** One menu and drag contract shared by tree rows and collection cards. */
export function CollectionActions({ scope, children }: { scope: CollectionScope; children?: ReactNode }) {
  const { t } = useTranslation();
  const interaction = useContext(CollectionInteractionContext);
  if (!interaction) return <>{children}</>;
  const pending = scope.items.filter(item => item.status === "pending").length;
  const processed = scope.items.length - pending;
  const options: { action: CollectionAction; label: string; count: number }[] = [
    { action: "select", label: translate("Select all in this scope"), count: scope.items.length },
    { action: "keep-pending", label: translate("Keep pending items"), count: pending },
    { action: "discard-pending", label: translate("Discard pending items"), count: pending },
    { action: "rework", label: translate("Rework selected items…"), count: scope.items.length },
    { action: "retrieve", label: translate("Reopen processed items for review"), count: processed },
    { action: "keep-all", label: translate("Keep all…"), count: scope.items.length },
    { action: "discard-all", label: translate("Discard all…"), count: scope.items.length },
    ...(interaction.drag ? [{ action: "export" as const, label: translate("Export this scope…"), count: scope.items.length }] : []),
  ];
  const dragScope = !scope.folder && interaction.selectedItems.some(item => item.id === scope.items[0]?.id)
    ? { title: translate("Selected items ({{v0}})", { v0: interaction.selectedItems.length }), items: interaction.selectedItems, folder: false }
    : scope;
  const contents = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Label = context ? ContextMenuLabel : DropdownMenuLabel;
    return <>
      <Label>{t("{{v0}} · {{v1}} items · current version", { v0: scope.title, v1: scope.items.length })}</Label>
      {options.map(option => <Item key={option.action} disabled={interaction.busy || option.count === 0}
        onSelect={() => interaction.action(option.action, scope)}>
        {option.label}（{option.count}）
      </Item>)}
    </>;
  };
  const menu = <div className="flex">{interaction.drag && <button type="button" draggable={!interaction.busy && scope.items.length > 0} disabled={interaction.busy || scope.items.length === 0}
    aria-label={t("Drag out copies of {{v0}}", { v0: scope.title })} title={t("Drag copies to another application (originals remain)")} data-testid="collection-native-drag"
    className="shrink-0 cursor-grab rounded p-1 text-fg-3 hover:bg-bg-3 hover:text-fg"
    onClick={event => event.stopPropagation()} onPointerDown={event => { event.stopPropagation(); interaction.prepareDrag?.(dragScope); }}
    onDragStart={event => { event.stopPropagation(); interaction.drag?.(event, dragScope); }}><FolderOutput className="h-3.5 w-3.5" /></button>}<DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={t("Actions for {{v0}}", { v0: scope.title })} title={t("More actions (also available by right-click)")}
        onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
        className="shrink-0 rounded p-1 text-fg-3 hover:bg-bg-3 hover:text-fg">
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent onClick={event => event.stopPropagation()}>{contents(false)}</DropdownMenuContent>
  </DropdownMenu></div>;
  if (!children) return menu;
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div className="relative min-w-0" draggable={!!interaction.moveDrag && !!scope.rootItemId && !interaction.busy}
        title={interaction.moveDrag ? scope.rootItemId ? t("Drag to another group in this batch. The original provenance chain remains intact.") : t("Drop an item into this group or drop supported files") : undefined}
        data-review-drop-group={scope.placementGroupId === null ? "ungrouped" : scope.placementGroupId}
        onDragOver={event => { if (!interaction.busy && interaction.acceptsDrop?.(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move"; } }}
        onDrop={event => { if (!interaction.busy && interaction.acceptsDrop?.(event)) { event.preventDefault(); event.stopPropagation(); interaction.drop?.(event, scope.placementGroupId ?? null, scope.rootItemId); } }}
        onDragStart={event => { event.stopPropagation(); interaction.moveDrag?.(event, dragScope); }}>
        <div className={interaction.drag ? "pr-12" : "pr-7"}>{children}</div>
        <div className="absolute right-0 top-0">{menu}</div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>{contents(true)}</ContextMenuContent>
  </ContextMenu>;
}
