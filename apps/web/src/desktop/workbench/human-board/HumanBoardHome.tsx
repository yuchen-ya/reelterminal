import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { humanBoardStorage, type HumanBoard } from "../../../services/human-board/storage";
import { reviewService } from "../../../services/review-workspace/service";
import type { WorkbenchItemView } from "../types";
import { boardTransferInput, type BoardTransferInput } from "../../../services/human-board/documents";
import { resourceImage } from "../../../services/human-board/media";
import { wbButton } from "../wb-button";

const HumanBoardCanvas = lazy(() => import("./HumanBoardCanvas"));
export type BoardIncoming = BoardTransferInput;

export default function HumanBoardHome({ incomingItem, onIncomingConsumed, onOpenReview }: {
  incomingItem?: WorkbenchItemView | null;
  onIncomingConsumed: () => void;
  onOpenReview: (nodeId: string) => void;
}) {
  const [boards, setBoards] = useState<HumanBoard[]>([]);
  const [board, setBoard] = useState<HumanBoard | null>(null);
  const [incoming, setIncoming] = useState<BoardIncoming | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("reelterminal.humanBoard.sidebarCollapsed") === "true");
  const [layoutLocked, setLayoutLocked] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const flush = useRef<() => Promise<void>>(async () => {});
  const host = useRef<HTMLDivElement>(null);
  const refresh = async () => { const rows = await humanBoardStorage.list(); setBoards(rows); return rows; };
  const report = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));

  useEffect(() => {
    let cancelled = false;
    void humanBoardStorage.list().then(rows => {
      if (cancelled) return;
      setBoards(rows);
      setBoard(rows.find(row => row.id === localStorage.getItem("reelterminal.humanBoard.active")) ?? null);
      setReady(true); host.current?.focus();
    }).catch(report);
    return () => { cancelled = true; };
  }, []);

  const choose = async (next: HumanBoard | null) => {
    await flush.current();
    const rows = await refresh();
    setBoard(next ? rows.find(row => row.id === next.id)! : null);
    setIncoming(null); setError("");
    if (next) localStorage.setItem("reelterminal.humanBoard.active", next.id);
    else localStorage.removeItem("reelterminal.humanBoard.active");
  };
  const create = async (name = "未命名画板", content?: BoardIncoming) => {
    await flush.current();
    const next = await humanBoardStorage.create(name);
    setBoard(next); setIncoming(content ?? null);
    localStorage.setItem("reelterminal.humanBoard.active", next.id);
    await refresh();
  };
  const receive = async (content: BoardIncoming) => {
    if (board) setIncoming(content);
    else await create(content.files?.[0]?.name.replace(/\.[^.]+$/, "") || content.text?.trim().split("\n")[0].slice(0, 40) || "新画板", content);
  };

  useEffect(() => {
    if (!ready || !incomingItem) return;
    let cancelled = false;
    const receiveItem = async () => {
      const resourceId = incomingItem.imagePayload?.repairMedia?.mediaId ?? incomingItem.imagePayload?.originalMedia.mediaId;
      if (!resourceId) throw new Error("该审阅图片没有可加入画板的资源");
      const [resource] = await reviewService.getResources([resourceId]);
      const image = await resourceImage(resource);
      if (!cancelled) {
        await receive({ entries: [{ name: incomingItem.title, resource, kind: "image", image }] });
        onIncomingConsumed();
      }
    };
    void receiveItem().catch(report);
    return () => { cancelled = true; };
  }, [ready, incomingItem]);

  return <div ref={host} tabIndex={0} className="flex h-full min-h-0 outline-none" data-testid="human-board-home"
    onDragOver={event => { if (!board && event.dataTransfer.types.some(type => ["Files", "text/plain", "text/uri-list", "text/html"].includes(type))) event.preventDefault(); }}
    onDrop={event => {
      if (board || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
      const content = boardTransferInput(event.dataTransfer, true);
      if (!content) return;
      event.preventDefault(); event.stopPropagation(); void receive(content).catch(report);
    }}
    onPaste={event => {
      if (board || (event.target as HTMLElement).closest("input,textarea,[contenteditable=true]")) return;
      const content = boardTransferInput(event.clipboardData);
      if (content) { event.preventDefault(); void receive(content).catch(report); }
    }}>
    <aside className={`flex shrink-0 flex-col border-r border-border bg-bg-1 p-2 ${collapsed ? "w-12" : "w-48"}`} data-testid="human-board-list" data-collapsed={collapsed}>
      <button className={`${wbButton.ghost} mb-2`} data-testid="human-board-sidebar-toggle" aria-label={collapsed ? "展开自由画板列表" : "折叠自由画板列表"} aria-expanded={!collapsed} aria-controls="human-board-sidebar-content" disabled={layoutLocked} onClick={() => {
        const next = !collapsed; setCollapsed(next); localStorage.setItem("reelterminal.humanBoard.sidebarCollapsed", String(next));
      }}>{collapsed ? "»" : "« 折叠列表"}</button>
      <div id="human-board-sidebar-content" className="flex min-h-0 flex-1 flex-col" style={collapsed ? { display: "none" } : undefined} hidden={collapsed} inert={collapsed}>
      <button className={wbButton.primary} data-testid="human-board-new" onClick={() => void create().catch(report)}>＋ 新建自由画板</button>
      <button className={`${wbButton.ghost} my-1 text-left`} onClick={() => void choose(null).catch(report)}>空白入口 · 拖入或粘贴</button>
      <div className="min-h-0 flex-1 overflow-auto">{boards.map(row => <div key={row.id} className={`my-1 flex items-center rounded ${board?.id === row.id ? "bg-accent/15" : "hover:bg-bg-2"}`}>
        <button className="min-w-0 flex-1 truncate px-2 py-2 text-left text-xs" data-testid={`human-board-open-${row.id}`} onClick={() => void choose(row).catch(report)}>{row.name}</button>
        <button className="px-2 text-fg-3 hover:text-status-error" aria-label={`删除画板 ${row.name}`} data-testid={`human-board-delete-${row.id}`} onClick={() => {
          if (!window.confirm(`删除画板“${row.name}”及其撤销历史？已导出的审阅快照会保留。`)) return;
          setBusy(true);
          void flush.current().then(() => humanBoardStorage.remove(row.id)).then(async () => {
            if (board?.id === row.id) { setBoard(null); setIncoming(null); localStorage.removeItem("reelterminal.humanBoard.active"); }
            await refresh();
          }).catch(report).finally(() => setBusy(false));
        }}>×</button>
      </div>)}</div>
      <p className="p-2 text-[11px] leading-relaxed text-fg-3">自由画板自动保存。只有主动导出的单个内容快照会进入审阅与 Agent 上下文。</p>
      </div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col" inert={busy}>
      {error && <div role="alert" className="border-b border-border p-2 text-xs text-status-error">{error}<button className="ml-3" onClick={() => setError("")}>关闭</button></div>}
      <input ref={filesInput} data-testid="human-board-import-files" type="file" multiple hidden accept="image/*,video/*,.glb,.txt,.md,.log,.html,.htm" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void receive({ files }).catch(report); }} />
      {board ? <Suspense fallback={<div className="p-8 text-sm">正在载入画板…</div>}><HumanBoardCanvas key={board.id} initialBoard={board} incoming={incoming}
        onIncomingConsumed={() => setIncoming(null)} onImport={() => filesInput.current?.click()} onSaved={() => { void refresh().catch(report); }}
        onFlush={callback => { flush.current = callback; }} onOpenReview={onOpenReview} onLayoutLockChange={setLayoutLocked} /></Suspense>
        : <div className="grid flex-1 place-items-center p-8 text-center" data-testid="human-board-empty">
          <div><h2 className="text-lg font-semibold">从一张空白画板开始</h2><p className="my-3 text-sm text-fg-2">拖入图片、视频、GLB、文本、Markdown、HTML 文件，或直接粘贴图片、文字与 HTTP/S 链接。<br />同次导入的混合内容会放在同一张画板。</p>
            <button className={wbButton.primary} disabled={!ready} onClick={() => filesInput.current?.click()}>导入文件并创建画板</button>
          </div>
        </div>}
    </main>
  </div>;
}
