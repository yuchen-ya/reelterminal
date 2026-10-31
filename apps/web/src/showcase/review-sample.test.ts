/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ensureReviewSample } from "./review-sample";
import { getReviewContext } from "../services/review-workspace/context";
import { reviewService } from "../services/review-workspace/service";
import { humanBoardStorage } from "../services/human-board/storage";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("creates one persistent review example with editable text and version history", async () => {
  await ensureReviewSample();
  await ensureReviewSample();
  const context = await getReviewContext();
  const { nodes } = await reviewService.listNodes(context.target, { view: "all" });
  expect(nodes).toHaveLength(1);
  expect(nodes[0].name).toBe("宣传片审阅示例");
  const target = { ...context.target, nodeId: nodes[0].id };
  const snapshot = await reviewService.getNode(target);
  expect(snapshot.state.items).toHaveLength(3);
  const item = snapshot.state.items.find(entry => entry.title === "开场文案")!;
  expect(item.version).toBe(2);
  expect((await reviewService.getVersion(target, item.id, 1)).content).toMatchObject({
    type: "text", versions: expect.arrayContaining([expect.objectContaining({ text: "让每一个灵感，都有机会成为作品。" })]),
  });

  const boards = await humanBoardStorage.list();
  expect(boards).toHaveLength(1);
  expect(boards[0].name).toBe("分镜灵感 · 私有画板");
});
