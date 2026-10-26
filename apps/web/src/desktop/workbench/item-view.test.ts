import { describe, expect, it, vi } from "vitest";
import type { WorkbenchItem } from "@reelterminal/core";
import { toItemView } from "./useWorkbenchController";

vi.mock("../../stores/project-store", () => ({ useProjectStore: vi.fn() }));

const item: WorkbenchItem = {
  id: "v2", batchId: "batch", orderIndex: 1, title: "返工", type: "video",
  version: 1, createdAt: 1, content: { type: "video", mediaId: "media", markers: [] },
  provenanceTags: [], userTags: [], status: "pending", decisionLog: [], revisions: [],
  lineage: { upstreamGroupId: "group", upstreamGroupTitle: "候选", upstreamSourceNode: "生成",
    groupMode: "board", basedOnLabel: "v1", connectorEdgeLabel: "返工", failStreak: 0, steps: [] },
};

describe("toItemView presentation metadata", () => {
  it.each([
    { compareWithItemId: "v1" },
    { videoPayload: { compareWithItemId: "v1" } },
    { compareWithItemId: "v1", videoPayload: { compareWithItemId: "other" } },
  ])("maps comparison to both view fields: %j", comparison => {
    const view = toItemView({ ...item, ...comparison }, () => undefined, [], null, null);
    expect(view.groupMode).toBe("board");
    expect(view.compareWithItemId).toBe("v1");
    expect(view.videoPayload?.compareWithItemId).toBe("v1");
  });

  it("prefers the item mode and preserves unset comparison fields", () => {
    const view = toItemView({ ...item, groupMode: "category" }, () => undefined, [], null, null);
    expect(view.groupMode).toBe("category");
    expect(view.compareWithItemId).toBeUndefined();
    expect(view.videoPayload?.compareWithItemId).toBeUndefined();
  });
});
