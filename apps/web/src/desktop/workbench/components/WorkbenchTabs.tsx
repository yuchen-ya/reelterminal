import { useRef } from "react";
import { useWorkbenchTabsStore, workbenchTabKey } from "../../../stores/workbench-tabs-store";
import { wbButton } from "../wb-button";

export function WorkbenchTabs({ locked, onActivate, onClose, onOpen }: {
  locked: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onOpen: () => void;
}) {
  const { tabs, activeKey, move } = useWorkbenchTabsStore();
  const dragging = useRef<string | null>(null);
  return <div className="flex h-10 shrink-0 items-center border-b border-border bg-bg-1 px-2" data-testid="workbench-tabs">
    <div role="tablist" aria-label="审阅工作台" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map(tab => {
        const key = workbenchTabKey(tab);
        return <div key={key} className={`flex max-w-64 shrink-0 items-center rounded-t border border-b-0 ${key === activeKey ? "border-border bg-bg text-fg" : "border-transparent text-fg-2 hover:bg-bg-2"}`}
          draggable={!locked} onDragStart={event => { dragging.current = key; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-reelterminal-workbench-tab", key); }}
          onDragEnd={() => { dragging.current = null; }} onDragOver={event => { if (!locked && dragging.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDrop={event => { if (!locked && dragging.current) { event.preventDefault(); event.stopPropagation(); move(dragging.current, key); dragging.current = null; } }}>
          <button role="tab" aria-selected={key === activeKey} disabled={locked} data-testid={`${tab.kind === "review" ? "review" : "board"}-tab-${tab.id}`} className="min-w-0 truncate px-3 py-2 text-xs disabled:opacity-50" onClick={() => onActivate(key)} title={tab.name}>{tab.kind === "review" ? "▤" : "◇"} {tab.name}</button>
          <button disabled={locked} className="mr-1 rounded px-1.5 text-fg-3 hover:bg-bg-3 hover:text-fg disabled:opacity-40" aria-label={`关闭 ${tab.name}`} data-testid={`close-tab-${tab.kind}-${tab.id}`} onClick={() => onClose(key)}>×</button>
        </div>;
      })}
    </div>
    <button disabled={locked} className={`${wbButton.ghost} ml-2 shrink-0`} data-testid="review-workspace-open" onClick={onOpen}>＋ 打开 / 管理</button>
  </div>;
}
