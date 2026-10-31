import { lazy, Suspense, useRef, useState } from "react";
import type React from "react";
import type { HumanBoard } from "../../../services/human-board/storage";
import type { BoardTransferInput } from "../../../services/human-board/documents";

const HumanBoardCanvas = lazy(() => import("./HumanBoardCanvas"));
export type BoardIncoming = BoardTransferInput;

/** One mounted scene; the workspace owns opening, closing and managing boards. */
export default function HumanBoardView({ board, incoming, onIncomingConsumed, onOpenReview, onSaved, onFlush, onLayoutLockChange, toolbarRight }: {
  board: HumanBoard;
  incoming: BoardIncoming | null;
  onIncomingConsumed: () => void;
  onOpenReview: (nodeId: string) => void;
  onSaved: () => void;
  onFlush: (callback: () => Promise<void>) => void;
  onLayoutLockChange: (locked: boolean) => void;
  toolbarRight?: React.ReactNode;
}) {
  const [initialBoard] = useState(board);
  const [importedFiles, setImportedFiles] = useState<BoardIncoming | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  return <div className="flex h-full min-h-0 flex-col" data-testid="human-board-view">
    <input ref={filesInput} data-testid="human-board-import-files" type="file" multiple hidden accept="image/*,video/*,.glb,.txt,.md,.log,.html,.htm" onChange={event => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length) setImportedFiles({ files });
    }} />
    <Suspense fallback={<div className="p-8 text-sm">正在载入画板…</div>}>
      <HumanBoardCanvas key={board.id} initialBoard={initialBoard} incoming={incoming ?? importedFiles} onIncomingConsumed={() => incoming ? onIncomingConsumed() : setImportedFiles(null)}
        onImport={() => filesInput.current?.click()} onSaved={onSaved} onFlush={onFlush} onOpenReview={onOpenReview} onLayoutLockChange={onLayoutLockChange} toolbarRight={toolbarRight} />
    </Suspense>
  </div>;
}
