import { buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions } from "@reelterminal/core/actions/workbench-actions";
import { getReviewContext } from "../services/review-workspace/context";
import { useWorkbenchTabsStore } from "../stores/workbench-tabs-store";
import { reviewService } from "../services/review-workspace/service";
import { humanBoardStorage } from "../services/human-board/storage";

const SAMPLE_KEY = "reelterminal.showcase.review.sample";
const BOARD_SAMPLE_KEY = "reelterminal.showcase.board.sample";

/** Seed actual review records in this browser's IndexedDB, without native files. */
export async function ensureReviewSample(): Promise<void> {
  const context = await getReviewContext();
  const page = await reviewService.listNodes(context.target, { view: "all" });
  let existingId = localStorage.getItem(SAMPLE_KEY);
  let activeNode = existingId ? page.nodes.find(node => node.id === existingId) : undefined;

  if (!activeNode) {
    const directory = await reviewService.directory.get(context.target);
    const node = await reviewService.createNode({
      target: context.target,
      name: "宣传片审阅示例",
      expectedWorkspaceRevision: directory.revision,
      requestId: crypto.randomUUID(),
    });
    activeNode = node;
    const target = { ...context.target, nodeId: node.id };
    const firstId = crypto.randomUUID();
    const samples = [
      { id: firstId, title: "开场文案", text: "让每一个灵感，都有机会成为作品。" },
      { id: crypto.randomUUID(), title: "字幕备选", text: "把创意留给你，把繁琐交给 Agent。" },
      { id: crypto.randomUUID(), title: "交付说明", text: "请检查措辞、节奏与品牌名称，再决定保留或返工。" },
    ];
    await reviewService.commit({
      target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "准备示例", request: {},
      build: state => {
        const result = buildWorkbenchIngestActions(state, {
          batchId: crypto.randomUUID(), name: "第一批 · 文案审阅",
          items: samples.map(sample => ({
            id: sample.id, title: sample.title, type: "text" as const,
            content: { type: "text" as const, entryId: crypto.randomUUID(), title: sample.title,
              speakerOrContext: "官网示例", versions: [{ version: 1, text: sample.text, createdAt: Date.now(), origin: "ingest" as const }] },
          })),
        });
        if (!result.ok) throw new Error(result.message);
        return result.actions;
      },
    });
    await reviewService.commit({
      target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "修改示例文案", request: {},
      build: state => {
        const result = buildWorkbenchTextRevisionActions(state, firstId, "让每个灵感，都能成为值得分享的作品。");
        if (!result.ok) throw new Error(result.message);
        return result.actions;
      },
    });
    localStorage.setItem(SAMPLE_KEY, node.id);
  }

  // Also ensure a sample Private Free Board so users experience both review tasks and private boards in workspace tabs
  let boardId = localStorage.getItem(BOARD_SAMPLE_KEY);
  const boards = await humanBoardStorage.list();
  let sampleBoard = boardId ? boards.find(board => board.id === boardId) : undefined;
  if (!sampleBoard) {
    sampleBoard = await humanBoardStorage.create("分镜灵感 · 私有画板");
    localStorage.setItem(BOARD_SAMPLE_KEY, sampleBoard.id);
  }

  useWorkbenchTabsStore.getState().open({ kind: "board", id: sampleBoard.id, name: sampleBoard.name });
  useWorkbenchTabsStore.getState().open({ kind: "review", id: activeNode.id, name: activeNode.name });
}
