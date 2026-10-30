import { buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions } from "@reelterminal/core/actions/workbench-actions";
import { getReviewContext } from "../services/review-workspace/context";
import { useWorkbenchTabsStore } from "../stores/workbench-tabs-store";
import { reviewService } from "../services/review-workspace/service";

const SAMPLE_KEY = "reelterminal.showcase.review.sample";

/** Seed actual review records in this browser's IndexedDB, without native files. */
export async function ensureReviewSample(): Promise<void> {
  const context = await getReviewContext();
  const page = await reviewService.listNodes(context.target, { view: "all" });
  const existingId = localStorage.getItem(SAMPLE_KEY);
  if (existingId && page.nodes.some(node => node.id === existingId)) return;

  const directory = await reviewService.directory.get(context.target);
  const node = await reviewService.createNode({
    target: context.target,
    name: "宣传片审阅示例",
    expectedWorkspaceRevision: directory.revision,
    requestId: crypto.randomUUID(),
  });
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
  useWorkbenchTabsStore.getState().open({ kind: "review", id: node.id, name: node.name });
}
