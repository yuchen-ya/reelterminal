import type { FileResource } from "@reelterminal/core/review/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import { openMaterialDatabase } from "../material-library/storage";

/** Human scenes have no review node, event journal, handoff, or Agent target. */
export interface HumanBoard {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  /** Excalidraw file IDs map to immutable resources; pixels hydrate at runtime. */
  imageFiles: Readonly<Record<string, string>>;
  /** Includes deleted elements and replaced images until the board is deleted. */
  resourceIds: readonly string[];
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, execute: (tx: IDBTransaction, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const database = await openMaterialDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(stores, mode);
      let value: T;
      let failure: Error | undefined;
      execute(tx, result => { value = result; }, error => { failure = error; tx.abort(); });
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error);
    });
  } finally { database.close(); }
}

export const humanBoardStorage = {
  list: () => transaction<HumanBoard[]>(["humanBoards"], "readonly", (tx, result) => {
    const request = tx.objectStore("humanBoards").getAll();
    request.onsuccess = () => result((request.result as HumanBoard[]).sort((a, b) => b.updatedAt - a.updatedAt));
  }),
  async create(name: string): Promise<HumanBoard> {
    const board: HumanBoard = { id: crypto.randomUUID(), name: name.trim().slice(0, 200) || "未命名画板", revision: 0, updatedAt: Date.now(), elements: [], imageFiles: {}, appState: { viewBackgroundColor: "#ffffff", theme: "light" }, resourceIds: [] };
    await transaction(["humanBoards"], "readwrite", (tx, result) => { tx.objectStore("humanBoards").add(board); result(undefined); });
    return board;
  },
  save: (board: HumanBoard) => transaction<HumanBoard>(["humanBoards"], "readwrite", (tx, result, fail) => {
    const store = tx.objectStore("humanBoards");
    const request = store.get(board.id);
    request.onsuccess = () => {
      if (!request.result || request.result.revision !== board.revision) { fail(new Error("画板已在其他窗口修改，请重新打开；当前场景尚未覆盖磁盘内容")); return; }
      const next = { ...board, appState: { ...board.appState, viewBackgroundColor: "#ffffff", theme: "light" as const }, resourceIds: [...new Set([...request.result.resourceIds, ...board.resourceIds])], revision: board.revision + 1, updatedAt: Date.now() };
      store.put(next); result(next);
    };
  }),
  /** Registration and its GC hold are atomic, before the scene references it. */
  retain: (boardId: string, resources: readonly FileResource[]) => transaction<void>(["humanBoards", "fileResources", "resourceRefs"], "readwrite", (tx, result, fail) => {
    const request = tx.objectStore("humanBoards").get(boardId);
    request.onsuccess = () => {
      if (!request.result) { fail(new Error("画板已删除")); return; }
      const board = request.result as HumanBoard;
      for (const resource of resources) {
        tx.objectStore("fileResources").put(resource);
        tx.objectStore("resourceRefs").put({ id: `human-board:${boardId}:${resource.id}`, nodeId: boardId, ownerId: boardId, ownerType: "human-board", resourceId: resource.id });
      }
      tx.objectStore("humanBoards").put({ ...board, resourceIds: [...new Set([...board.resourceIds, ...resources.map(resource => resource.id)])] });
      result(undefined);
    };
  }),
  resources: (boardId: string) => transaction<FileResource[]>(["humanBoards", "fileResources"], "readonly", (tx, result, fail) => {
    const request = tx.objectStore("humanBoards").get(boardId);
    request.onsuccess = () => {
      if (!request.result) { fail(new Error("画板不存在")); return; }
      const ids = (request.result as HumanBoard).resourceIds;
      if (!ids.length) { result([]); return; }
      const requests = ids.map(id => tx.objectStore("fileResources").get(id));
      let pending = requests.length;
      for (const item of requests) item.onsuccess = () => { if (!--pending) {
        if (requests.some(entry => !entry.result)) { fail(new Error("画板资源记录缺失")); return; }
        result(requests.map(entry => entry.result));
      } };
    };
  }),
  remove: (boardId: string) => transaction<void>(["humanBoards", "fileResources", "resourceRefs"], "readwrite", (tx, result) => {
    const store = tx.objectStore("resourceRefs");
    const request = store.index("owner").getAll(boardId);
    request.onsuccess = () => {
      for (const ref of request.result as Array<{ id: string; resourceId: string }>) {
        store.delete(ref.id);
        const holds = store.index("resource").getAll(ref.resourceId);
        holds.onsuccess = () => { if (!holds.result.length) tx.objectStore("fileResources").delete(ref.resourceId); };
      }
      tx.objectStore("humanBoards").delete(boardId); result(undefined);
    };
  }),
};
